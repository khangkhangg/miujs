#!/usr/bin/env bun
/**
 * Build the published package into dist/ (or `--outDir <dir>`):
 *   - `tsc -p tsconfig.build.json`: module-preserving ESM with .js specifiers, .d.ts,
 *     declaration maps and source maps pointing back at src/ (shipped alongside).
 *   - dist/bin/miu.js: the CLI entry with a `#!/usr/bin/env node` shebang.
 * Usage: bun scripts/build.ts [--outDir dir] [--noCheck]
 *   --noCheck  emit without type-checking (tests use it; `bun run typecheck` covers types).
 */
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dir, "..");
const i = process.argv.indexOf("--outDir");
const outDir = resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : join(ROOT, "dist"));
const noCheck = process.argv.includes("--noCheck");

await rm(outDir, { recursive: true, force: true });

const tsc = Bun.spawnSync(
  [process.execPath, join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.build.json"), "--outDir", outDir, ...(noCheck ? ["--noCheck"] : [])],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
);
if (tsc.exitCode !== 0) {
  console.error("build: tsc failed");
  process.exit(tsc.exitCode ?? 1);
}

// tsc rewrites import specifiers but not `new URL("./x.ts", import.meta.url)` file references.
// Same-length replacement (.ts -> .js), so source maps stay valid.
const URL_TS = /new URL\((["'])(\.{1,2}\/[^"']+)\.ts\1, import\.meta\.url\)/g;
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
// tsc leaves `.ts` specifiers in declaration files; rewrite them so dist/*.d.ts resolve to their
// .d.ts siblings for every consumer (moduleResolution node16/nodenext/bundler).
const DTS_TS = /((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+))(["'])(\.{1,2}\/[^"'\n]+)\.ts\2/g;
for (const file of await walk(outDir)) {
  if (file.endsWith(".map")) {
    // Point `sources` at the shipped src/ as seen from <package>/dist/, whatever --outDir was.
    const map = JSON.parse(await readFile(file, "utf8")) as { sources: string[] };
    const up = "../".repeat(relative(outDir, file).split(sep).length);
    map.sources = map.sources.map((s) => up + relative(ROOT, resolve(dirname(file), s)).split(sep).join("/"));
    await writeFile(file, JSON.stringify(map));
    continue;
  }
  const isJs = file.endsWith(".js");
  if (!isJs && !file.endsWith(".d.ts")) continue;
  const src = await readFile(file, "utf8");
  const next = isJs
    ? src.replace(URL_TS, (_m, q: string, p: string) => `new URL(${q}${p}.js${q}, import.meta.url)`)
    : src.replace(DTS_TS, (_m, pre: string, q: string, p: string) => `${pre}${q}${p}.js${q}`);
  if (next !== src) await writeFile(file, next);
}

// The CLI entry: bin/miu.ts imports ../src/cli/main.ts; in dist it sits at dist/bin/miu.js -> ../cli/main.js.
const binSrc = await readFile(join(ROOT, "bin/miu.ts"), "utf8");
const body = new Bun.Transpiler({ loader: "ts", target: "node" })
  .transformSync(binSrc.replace(/^#!.*\n/, ""))
  .replace(/(["'])\.\.\/src\/cli\/main\.ts\1/, '"../cli/main.js"');
if (!body.includes('"../cli/main.js"')) throw new Error("build: bin/miu.ts no longer imports ../src/cli/main.ts");
await mkdir(join(outDir, "bin"), { recursive: true });
const bin = join(outDir, "bin/miu.js");
await writeFile(bin, `#!/usr/bin/env node\n// Generated from bin/miu.ts by scripts/build.ts.\n${body}`);
await chmod(bin, 0o755);

console.log(`build: wrote ${outDir}`);
