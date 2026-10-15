// Builds packages for npm.
//
//   bun scripts/build-packages.ts                  # every released package (RELEASE_PACKAGES)
//   bun scripts/build-packages.ts miujs cache      # these (and their workspace deps, built first)
//   bun scripts/build-packages.ts cache --dry-run  # print the planned package.json, write nothing
//   bun scripts/build-packages.ts --all            # every workspace package, released or not
//
// For each package:
//   packages/<pkg>/dist/*.js        Bun.build: target node, ESM, not minified, deps external
//   packages/<pkg>/dist/types/      tsc --emitDeclarationOnly
//   dist/npm/<pkg>/                 the folder to publish: package.json (below), src/, dist/, README.md,
//                                   LICENSE (AGPL-3.0) and COMMERCIAL-LICENSE.md (the dual-licensing notice)
//
// The published package.json sends each runtime to the right files:
//   "types"  -> dist/types/*.d.ts   (TypeScript, including deno check)
//   "bun"    -> src/*.ts            (Bun runs the TypeScript source, as in this repo)
//   "default"-> dist/*.js           (Node, Deno and bundlers)
// There is deliberately no "deno" -> src condition: Node and Deno 2 both refuse to strip types
// under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so Deno gets the JS too.
// Deno users who want the TypeScript source should get it from JSR instead.
// Workspace deps become "^<version>" (all packages are versioned in lockstep by
// scripts/release/version.ts). "sideEffects" is false unless the source package.json lists files
// (src paths; entry points get their dist twins), and the build fails if a source module has
// undeclared top-level side effects. Declarations are checked for .ts specifiers and undeclared packages.
// Verify the packed tarballs on Node, Deno, Bun, Workers and tsc: bun scripts/release/verify.ts
// Publish with: npm publish dist/npm/<pkg> (see RELEASING.md; CI does it on a v* tag)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCUMENTED_PACKAGES, GITHUB_REPO, ROOT, blobUrl, readPackageJson, slash, type PackageJson } from "./lib/repo.ts";

type Conditions = { types: string; bun: string; default: string };

/**
 * Packages published to npm, in docs order. admin, game, tour and migrate are left out until their
 * APIs settle (see DOCUMENTED_PACKAGES); build them with --all.
 */
export const RELEASE_PACKAGES: readonly string[] = DOCUMENTED_PACKAGES;

/** Every workspace package folder under packages/. */
export const ALL_PACKAGES = (): string[] =>
  readdirSync(join(ROOT, "packages")).filter((d) => existsSync(join(ROOT, "packages", d, "package.json"))).sort();

/** Oldest Node the published JS is tested on (CI and scripts/release/verify.ts run Node 24). */
export const NODE_ENGINE = ">=24";

/** Publishing fields we read from a source package.json beyond the shared PackageJson type. */
type SourcePackage = PackageJson & { sideEffects?: boolean | string[]; keywords?: string[] };

export interface PublishManifest {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type: "module";
  main: string;
  types: string;
  exports: Record<string, Conditions | string>;
  bin?: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  devDependencies?: never;
  repository: { type: "git"; url: string; directory: string };
  homepage: string;
  bugs: { url: string };
  keywords?: string[];
  engines: { node: string };
  sideEffects: boolean | string[];
  publishConfig?: { access: "public" };
}

/** Source paths ("./src/x.ts") a package declares side-effectful, plus their built twins. */
export function sideEffectsOf(pkg: SourcePackage): boolean | string[] {
  const se = pkg.sideEffects;
  if (se === undefined || se === false) return false;
  if (se === true) return true;
  const out: string[] = [];
  // A declared entry point keeps its built twin; other modules are bundled into the entry that imports them.
  const entries = new Set([...Object.values(pkg.exports ?? {}), ...Object.values(pkg.bin ?? {})]);
  for (const p of se) {
    out.push(p);
    if (entries.has(p)) out.push(`./dist/${stem(p)}.js`);
  }
  return out;
}

/** Workspace folder name for an npm name: "miujs" -> "miujs", "@miujs/db" -> "db". */
const folderOf = (name: string) => (name === "miujs" ? "miujs" : name.replace(/^@miujs\//, ""));
const isWorkspace = (spec: string) => spec.startsWith("workspace:");

/** "./src/node.ts" -> "node" */
const stem = (srcPath: string) => srcPath.replace(/^\.\/src\//, "").replace(/\.tsx?$/, "");

export function publishManifest(pkg: SourcePackage): PublishManifest {
  const exports: Record<string, Conditions | string> = {};
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    const s = stem(target);
    exports[sub] = { types: `./dist/types/${s}.d.ts`, bun: target, default: `./dist/${s}.js` };
  }
  exports["./package.json"] = "./package.json";
  const deps = (d?: Record<string, string>) => {
    if (!d) return undefined;
    const out: Record<string, string> = {};
    for (const [name, spec] of Object.entries(d)) out[name] = isWorkspace(spec) ? `^${readPackageJson(folderOf(name)).version}` : spec;
    return out;
  };
  const folder = folderOf(pkg.name);
  const extraFiles = (pkg.files ?? []).filter((f) => f !== "src" && f !== "dist");
  const m: PublishManifest = {
    name: pkg.name,
    version: pkg.version,
    ...(pkg.description ? { description: pkg.description } : {}),
    license: pkg.license,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/types/index.d.ts",
    exports,
    ...(pkg.bin ? { bin: Object.fromEntries(Object.entries(pkg.bin).map(([k, v]) => [k, `./dist/${stem(v)}.js`])) } : {}),
    files: ["src", "dist", ...extraFiles, "README.md", "LICENSE", "COMMERCIAL-LICENSE.md"],
    ...(pkg.dependencies ? { dependencies: deps(pkg.dependencies) } : {}),
    ...(pkg.peerDependencies ? { peerDependencies: deps(pkg.peerDependencies) } : {}),
    ...(pkg.peerDependenciesMeta ? { peerDependenciesMeta: pkg.peerDependenciesMeta } : {}),
    repository: { type: "git", url: `git+https://github.com/${GITHUB_REPO}.git`, directory: `packages/${folder}` },
    homepage: blobUrl(`packages/${folder}/README.md`),
    bugs: { url: `https://github.com/${GITHUB_REPO}/issues` },
    ...(pkg.keywords ? { keywords: pkg.keywords } : {}),
    engines: { node: NODE_ENGINE },
    sideEffects: sideEffectsOf(pkg),
    ...(pkg.name.startsWith("@") ? { publishConfig: { access: "public" as const } } : {}),
  };
  return m;
}

/** Where the publishable folder for a package is staged. */
export const stageDir = (folder: string) => join(ROOT, "dist", "npm", folder);

/** Deno for tests: DENO_BIN, then PATH, then ~/.deno/bin. */
export function findDeno(): string | null {
  if (process.env.DENO_BIN && existsSync(process.env.DENO_BIN)) return process.env.DENO_BIN;
  const onPath = Bun.which("deno");
  if (onPath) return onPath;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  for (const exe of ["deno", "deno.exe"]) if (home && existsSync(join(home, ".deno", "bin", exe))) return join(home, ".deno", "bin", exe);
  return null;
}

/** Node for tests: NODE_BIN, then PATH, then a per-user install under %LOCALAPPDATA%/nodejs. */
export function findNode(): string | null {
  if (process.env.NODE_BIN && existsSync(process.env.NODE_BIN)) return process.env.NODE_BIN;
  const onPath = Bun.which("node");
  if (onPath) return onPath;
  const base = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "nodejs");
  if (base && existsSync(base)) {
    for (const d of readdirSync(base).sort().reverse()) {
      const exe = join(base, d, "node.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const workspaceDeps = (pkg: PackageJson) =>
  Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })
    .filter(([, spec]) => isWorkspace(spec))
    .map(([name]) => folderOf(name));

/** The packages to build, with their workspace deps first. */
export function buildOrder(requested: readonly string[]): string[] {
  const order: string[] = [];
  const visit = (folder: string, path: string[]) => {
    if (order.includes(folder)) return;
    if (path.includes(folder)) throw new Error(`Dependency cycle: ${[...path, folder].join(" -> ")}`);
    for (const dep of workspaceDeps(readPackageJson(folder))) visit(dep, [...path, folder]);
    order.push(folder);
  };
  for (const r of requested) visit(r, []);
  return order;
}

function listFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** Points relative "./x.ts" specifiers (static or in strings, like app.ts's node adapter) at the built "./x.js". */
function rewriteTsSpecifiers(dir: string, ext: RegExp, onlyIfExists: boolean) {
  for (const file of listFiles(dir, ext)) {
    const text = readFileSync(file, "utf8");
    const next = text.replace(/(["'])(\.\.?\/[\w./-]+?)\.tsx?\1/g, (whole, q: string, path: string) => {
      if (onlyIfExists && !existsSync(join(file, "..", `${path}.js`))) return whole;
      return `${q}${path}.js${q}`;
    });
    if (next !== text) writeFileSync(file, next);
  }
}

async function buildJs(folder: string, pkg: PackageJson) {
  const dir = join(ROOT, "packages", folder);
  const entries = [...Object.values(pkg.exports ?? {}), ...Object.values(pkg.bin ?? {})].map((p) => join(dir, p));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  const result = await Bun.build({
    entrypoints: [...new Set(entries)],
    root: join(dir, "src"),
    outdir: join(dir, "dist"),
    target: "node",
    format: "esm",
    splitting: true,
    minify: false,
    sourcemap: "none",
    external: [...deps, ...deps.map((d) => `${d}/*`), "bun", "bun:*"],
  });
  if (!result.success) throw new Error(`Bun.build failed for ${pkg.name}:\n${result.logs.map(String).join("\n")}`);
  rewriteTsSpecifiers(join(dir, "dist"), /\.js$/, true);
}

/** tsconfig `paths` sending workspace deps to their built declarations. */
function depTypePaths(pkg: PackageJson, fromDir: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const seen = new Set<string>();
  const add = (folder: string) => {
    if (seen.has(folder)) return;
    seen.add(folder);
    const dep = readPackageJson(folder);
    for (const [sub, target] of Object.entries(dep.exports ?? {})) {
      const spec = sub === "." ? dep.name : `${dep.name}/${sub.replace(/^\.\//, "")}`;
      const dts = join(ROOT, "packages", folder, "dist", "types", `${stem(target)}.d.ts`);
      if (!existsSync(dts)) throw new Error(`${dep.name} has no built types at ${slash(relative(ROOT, dts))}; build it first.`);
      paths[spec] = [slash(relative(fromDir, dts))];
    }
    for (const d of workspaceDeps(dep)) add(d);
  };
  for (const d of workspaceDeps(pkg)) add(d);
  return paths;
}

function runTsc(folder: string, pkg: PackageJson, srcDir: string): { ok: boolean; out: string } {
  const dir = join(ROOT, "packages", folder);
  const tmp = join(ROOT, ".tmp", `types-${folder}-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const src = slash(relative(tmp, srcDir));
    const config = {
      extends: slash(relative(tmp, join(ROOT, "tsconfig.json"))),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: slash(relative(tmp, join(dir, "dist", "types"))),
        rootDir: src,
        paths: depTypePaths(pkg, tmp),
      },
      include: [`${src}/**/*.ts`, `${src}/**/*.tsx`],
    };
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify(config, null, 2));
    const p = Bun.spawnSync([process.execPath, "x", "tsc", "-p", join(tmp, "tsconfig.json"), "--pretty", "false"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Top-level `interface X` / `type X =` that a module does not export. */
const PRIVATE_TYPE = /^(interface|type)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Declarations via tsc. If tsc can't name a private type in a public signature (TS4xxx, e.g. an
 * exported class property typed with a non-exported interface), emit from a copy of src/ with
 * top-level types exported, and warn: the real fix is to export them in the source.
 */
async function buildTypes(folder: string, pkg: PackageJson) {
  const dir = join(ROOT, "packages", folder);
  let r = runTsc(folder, pkg, join(dir, "src"));
  if (!r.ok) {
    const errors = r.out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
    if (errors.length === 0 || !errors.every((l) => /error TS4\d{3}:/.test(l))) throw new Error(`tsc --emitDeclarationOnly failed for ${pkg.name}:\n${r.out}`);
    // The copy sits inside the package so bare imports still resolve through its node_modules.
    const copy = join(dir, "dist", ".types-src");
    rmSync(copy, { recursive: true, force: true });
    cpSync(join(dir, "src"), copy, { recursive: true });
    const exported: string[] = [];
    for (const file of listFiles(copy, /\.tsx?$/)) {
      const text = readFileSync(file, "utf8");
      const next = text.replace(PRIVATE_TYPE, (_, kind: string, name: string) => {
        exported.push(`${name} (${slash(relative(copy, file))})`);
        return `export ${kind} ${name}`;
      });
      if (next !== text) writeFileSync(file, next);
    }
    rmSync(join(dir, "dist", "types"), { recursive: true, force: true });
    r = runTsc(folder, pkg, copy);
    rmSync(copy, { recursive: true, force: true });
    if (!r.ok) throw new Error(`tsc --emitDeclarationOnly failed for ${pkg.name}:\n${r.out}`);
    const named = exported.filter((e) => errors.some((l) => l.includes(`'${e.split(" ")[0]}'`)));
    console.warn(`warning: ${pkg.name}: public types use non-exported types (${named.join(", ") || exported.join(", ")}); declarations were emitted with them exported. Fix: export them in the source.`);
  }
  rewriteTsSpecifiers(join(dir, "dist", "types"), /\.d\.ts$/, false);
}

function stage(folder: string, manifest: PublishManifest) {
  const src = join(ROOT, "packages", folder);
  const out = stageDir(folder);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(src, "src"), join(out, "src"), { recursive: true });
  cpSync(join(src, "dist"), join(out, "dist"), { recursive: true });
  for (const f of manifest.files) {
    if (f === "src" || f === "dist" || f === "LICENSE" || f === "COMMERCIAL-LICENSE.md" || f === "README.md") continue;
    if (existsSync(join(src, f))) cpSync(join(src, f), join(out, f), { recursive: true });
  }
  if (existsSync(join(src, "README.md"))) cpSync(join(src, "README.md"), join(out, "README.md"));
  cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
  cpSync(join(ROOT, "COMMERCIAL-LICENSE.md"), join(out, "COMMERCIAL-LICENSE.md"));
  writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** A top-level statement that runs on import: a call, an await, an expression in parentheses, or an assignment to a property / global. */
const TOP_LEVEL_EFFECT = /^(?:[(;]|(?:await|new|void|delete)\b|globalThis\b.*=|[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*\(|[A-Za-z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])+\s*=[^=>])/;

/**
 * The lines of a module that start at the top level: not inside a string, template literal, comment,
 * regex, or any bracket. Comments are dropped. A small lexer, good enough for our own sources.
 */
export function topLevelLines(src: string): string[] {
  type State = "code" | "sq" | "dq" | "tpl" | "lc" | "bc" | "re";
  const out: string[] = [];
  const tpl: number[] = []; // bracket depth at each open `${`
  let state: State = "code";
  let depth = 0;
  let cur = "";
  let top = true;
  let inClass = false; // inside [...] of a regex
  let prev = ""; // last non-space code character, to tell a regex from a division
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\n") {
      if (state === "lc") state = "code";
      if (top && cur.trim()) out.push(cur.replace(/\r$/, ""));
      cur = "";
      top = state === "code" && depth === 0;
      continue;
    }
    if (state === "lc") continue;
    if (state === "bc") {
      if (c === "*" && n === "/") (state = "code"), i++;
      continue;
    }
    cur += c;
    if (state === "sq" || state === "dq") {
      if (c === "\\") cur += src[++i] ?? "";
      else if (c === (state === "sq" ? "'" : '"')) state = "code";
      continue;
    }
    if (state === "tpl") {
      if (c === "\\") cur += src[++i] ?? "";
      else if (c === "`") state = "code";
      else if (c === "$" && n === "{") {
        tpl.push(depth++);
        cur += src[++i];
        state = "code";
      }
      continue;
    }
    if (state === "re") {
      if (c === "\\") cur += src[++i] ?? "";
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) state = "code";
      continue;
    }
    // code
    if (c === "/" && n === "/") (state = "lc"), (cur = cur.slice(0, -1));
    else if (c === "/" && n === "*") (state = "bc"), (cur = cur.slice(0, -1)), i++;
    else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|in|of)$/.test(cur.slice(0, -1).trimEnd()))) (state = "re"), (inClass = false);
    else if (c === "'") state = "sq";
    else if (c === '"') state = "dq";
    else if (c === "`") state = "tpl";
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (c === "}" && tpl.length && tpl[tpl.length - 1] === depth) (tpl.pop(), (state = "tpl"));
    }
    if (!/\s/.test(c)) prev = state === "re" ? "/" : c;
  }
  if (top && cur.trim()) out.push(cur);
  return out;
}

/**
 * Source modules with top-level side effects that `sideEffects` does not declare. Checked per source
 * module because that is what a bundler drops under `sideEffects: false` (Bun loads src/ through the
 * "bun" condition); in dist/ the same statement sits inside the entry or chunk that needs it.
 */
export function checkSideEffects(folder: string, pkg: SourcePackage): string[] {
  if (pkg.sideEffects === true) return [];
  const declared = new Set(pkg.sideEffects || []);
  const dir = join(ROOT, "packages", folder);
  const problems: string[] = [];
  for (const p of declared) if (!existsSync(join(dir, p))) problems.push(`  "sideEffects" lists ${p}, which does not exist.`);
  for (const file of listFiles(join(dir, "src"), /\.tsx?$/)) {
    const rel = `./${slash(relative(dir, file))}`;
    if (declared.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    const lines = topLevelLines(text);
    // Patching the prototype of a class declared in the same module only matters when that class is
    // used, and then the module is kept anyway.
    const ownPrototype = (l: string) => {
      const m = /^(?:Object\.(?:assign|defineProperty|defineProperties)\(\s*)?([A-Za-z_$][\w$]*)\.prototype\b/.exec(l);
      return !!m && new RegExp(`^(?:export\\s+)?(?:class|function|var|let|const)\\s+${m[1].replace(/\$/g, "\\$")}\\b`, "m").test(text);
    };
    const hit = lines.find((l) => TOP_LEVEL_EFFECT.test(l) && !ownPrototype(l));
    if (hit) problems.push(`  ${rel} runs code on import (${hit.trim().slice(0, 80)}). Fix: add "${rel}" to "sideEffects" in packages/${folder}/package.json, or move the code into a function.`);
  }
  return problems;
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/**
 * Declarations a consumer can load with `skipLibCheck: false`: no `.ts` specifiers (they would point
 * at source a Node/tsc consumer must not compile), relative imports that exist, and bare imports only
 * of the package itself or its declared dependencies. Built-in modules (`node:*`, `bun`,
 * `cloudflare:*`) need the consumer's ambient types, so they are not allowed either.
 */
export function checkDeclarations(folder: string, manifest: PublishManifest): string[] {
  const typesDir = join(ROOT, "packages", folder, "dist", "types");
  const allowed = new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const problems: string[] = [];
  for (const file of listFiles(typesDir, /\.d\.ts$/)) {
    const rel = slash(relative(join(ROOT, "packages", folder), file));
    for (const m of stripComments(readFileSync(file, "utf8")).matchAll(SPECIFIER)) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        if (/\.tsx?$/.test(spec)) problems.push(`  ${rel} imports "${spec}" (a .ts source path).`);
        else if (!existsSync(join(file, "..", spec.replace(/\.js$/, ".d.ts"))) && !existsSync(join(file, "..", spec, "index.d.ts"))) problems.push(`  ${rel} imports "${spec}", which has no declaration file.`);
      } else if (!allowed.has(packageOf(spec))) {
        problems.push(`  ${rel} imports "${spec}", which ${manifest.name} does not depend on. Fix: use a structural type, or add it to dependencies/peerDependencies.`);
      }
    }
  }
  return problems;
}

export async function buildPackage(folder: string) {
  const pkg = readPackageJson(folder);
  rmSync(join(ROOT, "packages", folder, "dist"), { recursive: true, force: true });
  await buildJs(folder, pkg);
  await buildTypes(folder, pkg);
  const manifest = publishManifest(pkg);
  const problems = [...checkSideEffects(folder, pkg), ...checkDeclarations(folder, manifest)];
  if (problems.length) throw new Error(`${pkg.name} is not publishable:\n${problems.join("\n")}`);
  stage(folder, manifest);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const requested = args.filter((a) => !a.startsWith("--"));
  const targets = args.includes("--all") ? ALL_PACKAGES() : requested.length ? requested : [...RELEASE_PACKAGES];
  for (const t of targets) if (!existsSync(join(ROOT, "packages", t, "package.json"))) throw new Error(`No package at packages/${t}`);
  if (dryRun) {
    for (const t of targets) {
      console.log(`# ${slash(relative(ROOT, stageDir(t)))}/package.json`);
      console.log(JSON.stringify(publishManifest(readPackageJson(t)), null, 2));
    }
  } else {
    const failed = new Map<string, string>();
    for (const folder of buildOrder(targets)) {
      const name = readPackageJson(folder).name;
      const blocked = workspaceDeps(readPackageJson(folder)).filter((d) => failed.has(d));
      if (blocked.length) {
        failed.set(folder, `skipped: depends on ${blocked.join(", ")}`);
        console.error(`skipped ${name}: depends on ${blocked.join(", ")}, which failed`);
        continue;
      }
      const started = performance.now();
      try {
        await buildPackage(folder);
        console.log(`built ${name} -> ${slash(relative(ROOT, stageDir(folder)))} (${Math.round(performance.now() - started)} ms)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.set(folder, msg);
        console.error(`FAILED ${name}: ${msg.split("\n").slice(0, 6).join("\n  ")}`);
      }
    }
    if (failed.size) {
      console.error(`\n${failed.size} package(s) not built: ${[...failed.keys()].join(", ")}`);
      process.exit(1);
    }
  }
}
