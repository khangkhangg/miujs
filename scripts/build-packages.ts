// Builds packages for npm.
//
//   bun scripts/build-packages.ts                  # every documented package
//   bun scripts/build-packages.ts miujs cache      # these (and their workspace deps, built first)
//   bun scripts/build-packages.ts cache --dry-run  # print the planned package.json, write nothing
//
// For each package:
//   packages/<pkg>/dist/*.js        Bun.build: target node, ESM, not minified, deps external
//   packages/<pkg>/dist/types/      tsc --emitDeclarationOnly
//   dist/npm/<pkg>/                 the folder to publish: package.json (below), src/, dist/, README.md, LICENSE
//
// The published package.json sends each runtime to the right files:
//   "types"  -> dist/types/*.d.ts   (TypeScript, including deno check)
//   "bun"    -> src/*.ts            (Bun runs the TypeScript source, as in this repo)
//   "default"-> dist/*.js           (Node, Deno and bundlers)
// There is deliberately no "deno" -> src condition: Node and Deno 2 both refuse to strip types
// under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so Deno gets the JS too.
// Deno users who want the TypeScript source should get it from JSR instead.
// Publish with: npm publish dist/npm/<pkg>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCUMENTED_PACKAGES, GITHUB_REPO, ROOT, blobUrl, readPackageJson, slash, type PackageJson } from "./lib/repo.ts";

type Conditions = { types: string; bun: string; default: string };

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
  publishConfig?: { access: "public" };
}

/** Workspace folder name for an npm name: "miujs" -> "miujs", "@miujs/db" -> "db". */
const folderOf = (name: string) => (name === "miujs" ? "miujs" : name.replace(/^@miujs\//, ""));
const isWorkspace = (spec: string) => spec.startsWith("workspace:");

/** "./src/node.ts" -> "node" */
const stem = (srcPath: string) => srcPath.replace(/^\.\/src\//, "").replace(/\.tsx?$/, "");

export function publishManifest(pkg: PackageJson): PublishManifest {
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
    files: ["src", "dist", ...extraFiles, "README.md", "LICENSE"],
    ...(pkg.dependencies ? { dependencies: deps(pkg.dependencies) } : {}),
    ...(pkg.peerDependencies ? { peerDependencies: deps(pkg.peerDependencies) } : {}),
    ...(pkg.peerDependenciesMeta ? { peerDependenciesMeta: pkg.peerDependenciesMeta } : {}),
    repository: { type: "git", url: `git+https://github.com/${GITHUB_REPO}.git`, directory: `packages/${folder}` },
    homepage: blobUrl(`packages/${folder}/README.md`),
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
    if (f === "src" || f === "dist" || f === "LICENSE" || f === "README.md") continue;
    if (existsSync(join(src, f))) cpSync(join(src, f), join(out, f), { recursive: true });
  }
  if (existsSync(join(src, "README.md"))) cpSync(join(src, "README.md"), join(out, "README.md"));
  cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
  writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export async function buildPackage(folder: string) {
  const pkg = readPackageJson(folder);
  rmSync(join(ROOT, "packages", folder, "dist"), { recursive: true, force: true });
  await buildJs(folder, pkg);
  await buildTypes(folder, pkg);
  stage(folder, publishManifest(pkg));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const requested = args.filter((a) => !a.startsWith("--"));
  const targets = requested.length ? requested : [...DOCUMENTED_PACKAGES];
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
