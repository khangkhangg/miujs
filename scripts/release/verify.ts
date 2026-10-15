// Proves the npm packages work as published: builds them, packs real tarballs with npm, installs
// the tarballs into fresh projects outside the repo, and runs them.
//
//   bun scripts/release/verify.ts                 # everything
//   bun scripts/release/verify.ts --no-build      # reuse dist/npm from a previous build
//   bun scripts/release/verify.ts --only node,types
//   bun scripts/release/verify.ts --keep          # keep the temp projects and print where they are
//
// Steps (each prints PASS/FAIL; the exit code is 1 if any failed):
//   pack     npm pack every release package; check files, exports targets, manifest fields
//   node     npm install the tarballs (Node 24); import every export; run fixtures/app.ts over HTTP
//            through miujs/node with auth + session + db (node:sqlite) + cache + queue + realtime + bots
//   types    tsc --noEmit, strict, skipLibCheck false, nodenext, no lib "dom", against dist/types only
//            (src/ deleted); lists files that still need lib "dom"
//   workers  esbuild bundle of fixtures/worker.ts with Wrangler's conditions; no static node:/bun:
//            imports, no src/*.ts inputs, no eval/new Function; the bundle answers a request
//   deno     npm install into a second project, Deno 2 runs the app via bare and npm: specifiers
//   bun      bun install the tarballs, Bun runs the app from the TypeScript source ("bun" condition)
//
// Needs Node 24 (NODE_BIN, PATH or %LOCALAPPDATA%/nodejs), its npm, Deno 2 (DENO_BIN, PATH or
// ~/.deno/bin), and network access to the npm registry for typescript, @types/node, esbuild and
// drizzle-orm. Never publishes and never logs in.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { RELEASE_PACKAGES, buildOrder, findDeno, findNode, stageDir } from "../build-packages.ts";
import { GITHUB_REPO, ROOT, slash } from "../lib/repo.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const STEPS = ["pack", "node", "types", "workers", "deno", "bun"] as const;
type Step = (typeof STEPS)[number];

// ---------------------------------------------------------------------------------------------
// helpers

interface Run {
  code: number;
  out: string;
  err: string;
}

export function findNpm(node: string): string[] {
  for (const cli of [join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(cli)) return [node, cli];
  }
  const onPath = Bun.which("npm");
  if (onPath) return [onPath];
  throw new Error(`npm not found next to ${node}; install Node with npm or put npm on PATH`);
}

/** "miujs" -> "miujs", "@miujs/db" -> "miujs-db": the tarball name prefix npm pack uses. */
const tarballBase = (name: string) => name.replace(/^@/, "").replace("/", "-");

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;

export function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i < 0) return undefined;
    return argv[i].includes("=") ? argv[i].slice(flag.length + 1) : argv[i + 1];
  };
  const only = value("--only")?.split(",").map((s) => s.trim()) as Step[] | undefined;
  const skip = (value("--skip")?.split(",").map((s) => s.trim()) ?? []) as Step[];
  for (const s of [...(only ?? []), ...skip]) if (!STEPS.includes(s)) throw new Error(`Unknown step "${s}". Steps: ${STEPS.join(", ")}`);
  const steps = new Set<Step>((only ?? [...STEPS]).filter((s) => !skip.includes(s)));
  // Every runtime step installs tarballs, so packing always runs.
  steps.add("pack");
  return { steps, build: !argv.includes("--no-build"), keep: argv.includes("--keep"), dir: value("--dir") };
}

// ---------------------------------------------------------------------------------------------
// main

export interface PackResult {
  folder: string;
  name: string;
  version: string;
  tarball: string;
  size: number;
  unpackedSize: number;
  files: number;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const node = findNode();
  if (!node) throw new Error("Node not found: set NODE_BIN or put node on PATH");
  const npm = findNpm(node);
  const deno = findDeno();
  const results: Result[] = [];
  const record = (step: string, ok: boolean, detail = "", warn = false) => {
    results.push({ step, ok, detail, warn });
    console.log(`${!ok ? "FAIL" : warn ? "WARN" : "PASS"}  ${step}${detail ? `  ${detail.split("\n").join("\n      ")}` : ""}`);
  };
  // Lifecycle scripts (esbuild's postinstall) call `node`: make sure it is the one we found.
  const env = { ...process.env, PATH: `${dirname(node)}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, npm_config_update_notifier: "false", NO_COLOR: "1" };
  const run = (cmd: string[], cwd: string, timeout = 300_000): Run => {
    const started = performance.now();
    const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", timeout });
    const r = { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
    console.log(`  $ ${cmd.map((c) => (c.includes(" ") ? JSON.stringify(c) : c)).join(" ").replace(ROOT, ".")}  (${Math.round(performance.now() - started)} ms, exit ${r.code})`);
    return r;
  };
  const tail = (r: Run, n = 25) => (r.out + "\n" + r.err).trim().split(/\r?\n/).slice(-n).join("\n");

  const folders = buildOrder(RELEASE_PACKAGES);
  console.log(`Node ${run([node, "--version"], ROOT).out.trim()}, npm ${run([...npm, "--version"], ROOT).out.trim()}, Bun ${Bun.version}, Deno ${deno ? run([deno, "--version"], ROOT).out.split("\n")[0].replace("deno ", "") : "not found"}`);

  // 1. build
  if (opts.build) {
    const r = run([process.execPath, join(ROOT, "scripts", "build-packages.ts"), ...folders], ROOT, 600_000);
    record("build", r.code === 0, r.code === 0 ? `${folders.length} packages` : tail(r));
    if (r.code !== 0) return finish(results, null, [], opts.keep);
  }

  const tmp = opts.dir ? resolve(opts.dir) : mkdtempSync(join(tmpdir(), "miujs-verify-"));
  if (!relative(ROOT, tmp).startsWith("..")) throw new Error(`Temp dir ${tmp} is inside the repo; consumers must not see the workspace`);
  mkdirSync(tmp, { recursive: true });
  console.log(`temp: ${tmp}`);
  let packs: PackResult[] = [];
  try {
    // 2. pack
    const tarballs = join(tmp, "tarballs");
    mkdirSync(tarballs, { recursive: true });
    for (const folder of folders) {
      const manifest = JSON.parse(readFileSync(join(stageDir(folder), "package.json"), "utf8"));
      const r = run([...npm, "pack", stageDir(folder), "--pack-destination", tarballs, "--json", "--loglevel=error"], tmp);
      if (r.code !== 0) {
        record(`pack ${manifest.name}`, false, tail(r));
        continue;
      }
      const info = JSON.parse(r.out.slice(r.out.indexOf("[")))[0] as { filename: string; size: number; unpackedSize: number; files: { path: string }[] };
      const problems = checkTarball(manifest, info.files.map((f) => f.path));
      packs.push({ folder, name: manifest.name, version: manifest.version, tarball: join(tarballs, info.filename), size: info.size, unpackedSize: info.unpackedSize, files: info.files.length });
      record(`pack ${manifest.name}`, problems.length === 0, problems.length ? problems.join("\n") : `${kb(info.size)} gz, ${kb(info.unpackedSize)} unpacked, ${info.files.length} files`);
    }
    if (packs.length !== folders.length) return;

    const deps = Object.fromEntries(packs.map((p) => [p.name, `file:${slash(relative(join(tmp, "x"), p.tarball))}`]));
    const consumer = (dir: string, extra: Record<string, unknown> = {}) => {
      mkdirSync(dir, { recursive: true });
      // overrides pin transitive "miujs@^x" / "@miujs/*@^x" to the tarballs too, so nothing comes from the registry.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `verify-${dir.split(/[\\/]/).pop()}`, private: true, type: "module", dependencies: deps, overrides: deps, ...extra }, null, 2));
      for (const f of ["app.ts", "d1-node-sqlite.ts", "worker.ts"]) cpSync(join(FIXTURES, f), join(dir, f));
    };
    const assertInstalled = (dir: string, label: string) => {
      const problems = checkInstalled(dir, packs);
      record(`${label} install`, problems.length === 0, problems.join("\n") || `${packs.length} packages from tarballs, none from the registry`);
      return problems.length === 0;
    };

    // 3. node
    const nodeDir = join(tmp, "node");
    const needNode = opts.steps.has("node") || opts.steps.has("types") || opts.steps.has("workers");
    let nodeReady = false;
    if (needNode) {
      const tsVersion = JSON.parse(readFileSync(join(ROOT, "node_modules", "typescript", "package.json"), "utf8")).version;
      // Optional peers (drizzle-orm, postgres, ...) so every export can load and type-check.
      consumer(nodeDir, { devDependencies: { typescript: tsVersion, "@types/node": "^24", esbuild: "^0.25.0", ...optionalPeers(packs) } });
      const r = run([...npm, "install", "--no-audit", "--no-fund", "--loglevel=error"], nodeDir, 600_000);
      record("node npm install", r.code === 0, r.code === 0 ? "" : tail(r));
      nodeReady = r.code === 0 && assertInstalled(nodeDir, "node");
    }
    if (nodeReady && opts.steps.has("node")) {
      // Every export of every package loads under Node from dist JS.
      const specs = exportSpecifiers(packs);
      writeFileSync(
        join(nodeDir, "import-all.mjs"),
        `const specs = ${JSON.stringify(specs)};\nconst bad = [];\nfor (const s of specs) {\n  try {\n    const url = import.meta.resolve(s);\n    if (!/\\/dist\\/[^/]+\\.js$/.test(url)) bad.push(\`\${s} resolved to \${url}\`);\n    await import(s);\n  } catch (e) { bad.push(\`\${s}: \${e.message}\`); }\n}\nconsole.log(JSON.stringify({ count: specs.length, bad }));\nif (bad.length) process.exit(1);\n`,
      );
      const imp = run([node, "import-all.mjs"], nodeDir);
      record("node import every export", imp.code === 0, imp.code === 0 ? `${specs.length} entry points, all from dist/*.js` : tail(imp));
      runApp("node", run([node, "app.ts"], nodeDir), "node", /node_modules\/miujs\/dist\/index\.js$/, record, tail);
    }

    // 4. types: strict consumer, dist/types only
    if (nodeReady && opts.steps.has("types")) {
      for (const p of packs) rmSync(join(nodeDir, "node_modules", p.name, "src"), { recursive: true, force: true });
      const specs = exportSpecifiers(packs);
      writeFileSync(join(nodeDir, "types-all.ts"), specs.map((s, i) => `import type * as m${i} from "${s}";`).join("\n") + `\nexport type All = [${specs.map((_, i) => `typeof m${i}`).join(", ")}];\n`);
      const tsc = join(nodeDir, "node_modules", "typescript", "bin", "tsc");
      // A Node-only consumer: lib es2023 + @types/node, no lib "dom". Headers, Request, Response and
      // crypto exist there; DOM-only names (HeadersInit, BodyInit, CryptoKey, ...) do not.
      writeFileSync(join(nodeDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...STRICT_CONSUMER, lib: ["es2023"] }, files: ["app.ts", "worker.ts", "types-all.ts"] }, null, 2));
      const r = run([node, tsc, "-p", "tsconfig.json", "--pretty", "false", "--listFiles"], nodeDir);
      const t = splitTscOutput(r.out);
      const dom = classifyDomErrors(t.ours);
      const thirdParty = [...new Set(t.thirdParty.map((l) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(l)?.[1] ?? "?"))];
      const ok = dom.other.length === 0 && dom.unexpected.length === 0 && t.fromSrc.length === 0 && t.declarations > 0 && (r.code === 0 || t.thirdParty.length + dom.pending.length > 0);
      record(
        "types tsc --noEmit (strict, skipLibCheck false, nodenext, no lib dom)",
        ok,
        ok
          ? `${t.declarations} declaration files from ${specs.length} entry points, none from src/${t.thirdParty.length ? `; ignored ${t.thirdParty.length} errors inside third-party d.ts (${thirdParty.join(", ")})` : ""}`
          : [...dom.unexpected.map((l) => `needs lib dom: ${l}`), ...dom.other, ...t.fromSrc.slice(0, 5), dom.other.length + dom.unexpected.length ? "" : tail(r)].slice(0, 40).join("\n"),
      );
      if (dom.pending.length) record(`types: DOM-only names still in ${DOM_LIB_PENDING.join(", ")}`, true, dom.pending.join("\n"), true);
    }

    // 5. workers bundle
    if (nodeReady && opts.steps.has("workers")) {
      cpSync(join(FIXTURES, "bundle-worker.mjs"), join(nodeDir, "bundle-worker.mjs"));
      const r = run([node, "bundle-worker.mjs"], nodeDir);
      const last = r.out.trim().split(/\r?\n/).pop() ?? "";
      let detail = tail(r);
      let dynamic: string[] = [];
      try {
        const rep = JSON.parse(last) as { runtime: string; bytes: number; dynamic: string[]; staticBuiltins: string[]; srcInputs: string[]; evals: string[]; status: number; body: string };
        dynamic = rep.dynamic;
        detail = r.code === 0 ? `${kb(rep.bytes)} bundle, no static node:/bun: imports, no src/*.ts inputs, no eval; GET /health -> ${rep.status} as ${rep.runtime}` : JSON.stringify(rep, null, 1);
      } catch {}
      record("workers bundle (workerd, worker, browser conditions)", r.code === 0, detail);
      // import(variable) is invisible to bundlers; a literal import("node:x") is resolved at build
      // time, and Wrangler fails on it unless the Worker enables nodejs_compat.
      if (r.code === 0 && dynamic.length) record("workers literal dynamic node: imports", true, `${dynamic.join(", ")} (runtime-guarded, but Wrangler needs nodejs_compat to resolve them; use a variable specifier)`, true);
    }

    // 6. deno
    if (opts.steps.has("deno")) {
      if (!deno) record("deno", false, "Deno not found: set DENO_BIN or put deno on PATH");
      else {
        const denoDir = join(tmp, "deno");
        consumer(denoDir);
        writeFileSync(join(denoDir, "deno.json"), JSON.stringify({ nodeModulesDir: "manual" }));
        const r = run([...npm, "install", "--no-audit", "--no-fund", "--loglevel=error"], denoDir, 600_000);
        record("deno npm install", r.code === 0, r.code === 0 ? "" : tail(r));
        if (r.code === 0 && assertInstalled(denoDir, "deno")) {
          runApp("deno (bare specifiers)", run([deno, "run", "-A", "app.ts"], denoDir), "deno", /node_modules\/miujs\/dist\/index\.js$/, record, tail);
          // The same app with npm: specifiers, resolved from the local node_modules.
          for (const f of ["app.ts", "d1-node-sqlite.ts"]) {
            const text = readFileSync(join(denoDir, f), "utf8").replace(/from "((?:@miujs\/[\w-]+|miujs)(?:\/[\w-]+)?)"/g, 'from "npm:$1"').replace(/import\.meta\.resolve\("(@miujs\/cache|miujs)"\)/g, 'import.meta.resolve("npm:$1")');
            writeFileSync(join(denoDir, f.replace(".ts", ".npm.ts")), text.replace('"./d1-node-sqlite.ts"', '"./d1-node-sqlite.npm.ts"'));
          }
          runApp("deno (npm: specifiers)", run([deno, "run", "-A", "app.npm.ts"], denoDir), "deno", /(node_modules\/miujs\/dist\/index\.js|^npm:)/, record, tail);
          const check = run([deno, "check", "app.ts"], denoDir);
          record("deno check (types condition)", check.code === 0, check.code === 0 ? "" : tail(check));
        }
      }
    }

    // 7. bun
    if (opts.steps.has("bun")) {
      const bunDir = join(tmp, "bun");
      consumer(bunDir);
      const r = run([process.execPath, "install", "--no-save"], bunDir, 600_000);
      record("bun install", r.code === 0, r.code === 0 ? "" : tail(r));
      if (r.code === 0 && assertInstalled(bunDir, "bun")) runApp("bun", run([process.execPath, "app.ts"], bunDir), "bun", /node_modules\/miujs\/src\/index\.ts$/, record, tail);
    }
  } finally {
    finish(results, tmp, packs, opts.keep);
  }
}

const STRICT_CONSUMER = {
  target: "es2022",
  module: "nodenext",
  moduleResolution: "nodenext",
  types: ["node"],
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
};

interface Result {
  step: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

/** tsc output: errors in our packages or the fixtures, errors inside third-party d.ts, our files loaded from src/. */
export function splitTscOutput(out: string) {
  const lines = out.split(/\r?\n/).map((l) => l.trim().replaceAll("\\", "/"));
  const errors = lines.filter((l) => /error TS\d+/.test(l));
  const isOurs = (l: string) => !l.includes("node_modules/") || /node_modules\/(miujs|@miujs)\//.test(l);
  const listed = lines.filter((l) => /\.tsx?$/.test(l) && !/error TS/.test(l));
  return {
    ours: errors.filter(isOurs),
    thirdParty: errors.filter((l) => !isOurs(l)),
    fromSrc: listed.filter((l) => /node_modules\/(miujs|@miujs\/[^/]+)\/src\//.test(l)),
    declarations: listed.filter((l) => /node_modules\/(miujs|@miujs)\//.test(l)).length,
  };
}

/**
 * Packages whose public types still use DOM-only names (reported as a warning, not a failure).
 * Empty this list once they are fixed: then any DOM-only name in any package fails the check.
 */
export const DOM_LIB_PENDING: readonly string[] = ["miujs"];

/**
 * Splits our tsc errors (from splitTscOutput) into: a missing global type in one of our .d.ts files
 * (needs lib "dom"), for a pending package or not, and every other error.
 */
export function classifyDomErrors(ours: string[]) {
  const pending: string[] = [];
  const unexpected: string[] = [];
  const other: string[] = [];
  for (const l of ours) {
    const m = /node_modules\/((?:@miujs\/[^/]+)|miujs)\/(dist\/types\/[^(]+)\((\d+),\d+\): error TS(2304|2552|2749): .*?'(\w+)'/.exec(l);
    if (!m) other.push(l);
    else (DOM_LIB_PENDING.includes(m[1]) ? pending : unexpected).push(`${m[1]}/${m[2]}:${m[3]} ${m[5]}`);
  }
  return { pending, unexpected, other };
}

/** Optional peer dependencies of the packed packages, as devDependencies for the consumer. */
export function optionalPeers(packs: PackResult[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of packs) {
    const m = JSON.parse(readFileSync(join(stageDir(p.folder), "package.json"), "utf8")) as { peerDependencies?: Record<string, string> };
    for (const [name, range] of Object.entries(m.peerDependencies ?? {})) if (name !== "miujs" && !name.startsWith("@miujs/")) out[name] = range;
  }
  return out;
}

function runApp(label: string, r: Run, runtime: string, resolved: RegExp, record: (s: string, ok: boolean, d?: string) => void, tail: (r: Run) => string) {
  const last = r.out.trim().split(/\r?\n/).pop() ?? "";
  try {
    const rep = JSON.parse(last) as { runtime: string; resolved: { miujs: string }; checks: Record<string, boolean>; failures: string[] };
    const where = slash(rep.resolved.miujs);
    const ok = r.code === 0 && rep.runtime === runtime && rep.failures.length === 0 && resolved.test(where);
    const passed = Object.values(rep.checks).filter(Boolean).length;
    record(`${label} app over HTTP`, ok, ok ? `${passed}/${Object.keys(rep.checks).length} checks; miujs from ${where.replace(/^.*node_modules\//, "node_modules/")}` : [`runtime=${rep.runtime} miujs=${where}`, ...rep.failures, tail(r)].join("\n"));
  } catch {
    record(`${label} app over HTTP`, false, tail(r));
  }
}

/** Problems with one packed tarball's file list. */
export function checkTarball(manifest: { name: string; main?: string; types?: string; exports?: Record<string, unknown>; bin?: Record<string, string>; files?: string[] }, files: string[]): string[] {
  const have = new Set(files.map((f) => f.replace(/^package\//, "")));
  const problems: string[] = [];
  for (const f of ["package.json", "README.md", "LICENSE", "COMMERCIAL-LICENSE.md"]) if (!have.has(f)) problems.push(`missing ${f}`);
  const targets: string[] = [manifest.main ?? "", manifest.types ?? "", ...Object.values(manifest.bin ?? {})];
  for (const v of Object.values(manifest.exports ?? {})) targets.push(...(typeof v === "string" ? [v] : Object.values(v as Record<string, string>)));
  for (const t of targets.filter(Boolean)) if (!have.has(t.replace(/^\.\//, ""))) problems.push(`exports/main/bin target ${t} is not in the tarball`);
  for (const f of have) if (/(^|\/)(test|tests|\.tmp|\.types-src|node_modules)\//.test(f) || /\.test\.tsx?$/.test(f)) problems.push(`unexpected file ${f}`);
  const raw = JSON.stringify(manifest);
  if (raw.includes("workspace:")) problems.push("package.json still has workspace: ranges");
  return problems;
}

/** Every installed copy of our packages must be the tarball version, from this repo. */
export function checkInstalled(dir: string, packs: PackResult[]): string[] {
  const problems: string[] = [];
  const ours = new Map(packs.map((p) => [p.name, p.version]));
  const visit = (nm: string, depth: number) => {
    if (!existsSync(nm) || depth > 4) return;
    for (const entry of readdirSync(nm)) {
      const names = entry.startsWith("@") ? readdirSync(join(nm, entry)).map((e) => `${entry}/${e}`) : [entry];
      for (const name of names) {
        const pj = join(nm, name, "package.json");
        if (ours.has(name) && existsSync(pj)) {
          const m = JSON.parse(readFileSync(pj, "utf8"));
          if (m.version !== ours.get(name) || !String(m.repository?.url ?? "").includes(GITHUB_REPO)) {
            problems.push(`${slash(relative(dir, join(nm, name)))} is ${m.name}@${m.version} from ${m.repository?.url ?? "unknown"}, not this repo's tarball`);
          }
          if (depth > 0) problems.push(`nested copy at ${slash(relative(dir, join(nm, name)))} (should be deduped to the root)`);
        }
        visit(join(nm, name, "node_modules"), depth + 1);
      }
    }
  };
  visit(join(dir, "node_modules"), 0);
  for (const name of ours.keys()) if (!existsSync(join(dir, "node_modules", name, "package.json"))) problems.push(`${name} is not installed`);
  return problems;
}

/** "miujs", "miujs/node", "@miujs/db", "@miujs/db/drizzle", ... from the packed manifests. */
export function exportSpecifiers(packs: PackResult[]): string[] {
  const out: string[] = [];
  for (const p of packs) {
    const m = JSON.parse(readFileSync(join(stageDir(p.folder), "package.json"), "utf8")) as { exports: Record<string, unknown> };
    for (const sub of Object.keys(m.exports)) if (sub !== "./package.json") out.push(sub === "." ? p.name : `${p.name}/${sub.slice(2)}`);
  }
  return out;
}

function finish(results: Result[], tmp: string | null, packs: PackResult[], keep: boolean) {
  if (tmp) {
    if (keep) console.log(`\nkept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  const failed = results.filter((r) => !r.ok);
  if (packs.length) {
    console.log("\npackage                  packed (gz)   unpacked   files");
    for (const p of packs) console.log(`${p.name.padEnd(24)} ${kb(p.size).padStart(11)} ${kb(p.unpackedSize).padStart(10)} ${String(p.files).padStart(7)}`);
    const total = packs.reduce((a, p) => a + p.size, 0);
    console.log(`${"total".padEnd(24)} ${kb(total).padStart(11)}`);
  }
  const warned = results.filter((r) => r.ok && r.warn).length;
  console.log(`\n${results.length - failed.length}/${results.length} passed${warned ? ` (${warned} with warnings)` : ""}${failed.length ? `; failed: ${failed.map((f) => f.step).join(", ")}` : ""}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = ["## Release verify", "", "| step | result |", "|---|---|", ...results.map((r) => `| ${r.step} | ${!r.ok ? "**FAIL**" : r.warn ? "warn: " + r.detail : "pass"} |`), ""];
    if (packs.length) lines.push("| package | packed (gz) | unpacked | files |", "|---|---:|---:|---:|", ...packs.map((p) => `| ${p.name} | ${kb(p.size)} | ${kb(p.unpackedSize)} | ${p.files} |`), "");
    writeFileSync(summary, lines.join("\n") + "\n", { flag: "a" });
  }
  process.exitCode = failed.length || !results.length ? 1 : 0;
}

if (import.meta.main) {
  await main().catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  });
}
