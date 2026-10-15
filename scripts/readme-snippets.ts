// Type-checks the README examples marked `<!-- test -->`.
//
//   bun scripts/readme-snippets.ts            # every documented package
//   bun scripts/readme-snippets.ts cache db   # just these
//
// Each snippet becomes one module in a temp folder under the repo. A generated tsconfig maps
// `miujs` and `@miujs/*` (and their subpath exports) to the workspace sources, so snippets are
// checked against the real APIs. Only errors inside snippets are reported.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCUMENTED_PACKAGES, ROOT, readPackageJson, slash } from "./lib/repo.ts";

export interface Snippet {
  /** README path relative to the repo root. */
  file: string;
  /** README line of the snippet's first code line (1-based). */
  line: number;
  code: string;
  /** A ```tsx block (checked as a .tsx file). */
  tsx?: true;
}

const MARK = /^\s*<!--\s*test\s*-->\s*$/;
const FENCE_TS = /^```(ts|typescript|tsx)\s*$/;

/** The ```ts blocks that have `<!-- test -->` on the line above them (blank lines allowed between). */
export function extractSnippets(markdown: string, file: string): Snippet[] {
  const lines = markdown.split(/\r?\n/);
  const out: Snippet[] = [];
  let marked = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (MARK.test(l)) {
      marked = true;
      continue;
    }
    if (l.startsWith("```")) {
      const isTs = FENCE_TS.test(l);
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].startsWith("```")) end++;
      if (marked && isTs) out.push({ file, line: start + 1, code: lines.slice(start, end).join("\n"), ...(l.includes("tsx") ? { tsx: true as const } : {}) });
      marked = false;
      i = end;
      continue;
    }
    if (l.trim() !== "") marked = false;
  }
  return out;
}

/** tsconfig `paths` for every workspace package and its subpath exports. */
export function workspacePaths(fromDir: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    if (!existsSync(join(ROOT, "packages", dir, "package.json"))) continue;
    const pkg = readPackageJson(dir);
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      if (typeof target !== "string") continue;
      const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, "")}`;
      paths[spec] = [slash(relative(fromDir, join(ROOT, "packages", dir, target)))];
    }
    // Third-party deps installed only inside one package (e.g. drizzle-orm in packages/db).
    for (const dep of Object.keys({ ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies })) {
      const at = join(ROOT, "packages", dir, "node_modules", dep);
      if (paths[dep] || dep === "miujs" || dep.startsWith("@miujs/") || !existsSync(at)) continue;
      paths[dep] = [slash(relative(fromDir, at))];
      paths[`${dep}/*`] = [slash(relative(fromDir, at)) + "/*"];
    }
  }
  return paths;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/;

/** Type-checks snippets in one tsc run. Returns readable errors, `README.md:line:col - error ...`. */
export async function typecheckSnippets(snippets: Snippet[]): Promise<string[]> {
  if (snippets.length === 0) return [];
  const dir = join(ROOT, ".tmp", `readme-snippets-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const byFile = new Map<string, Snippet>();
    snippets.forEach((s, i) => {
      const name = `snippet_${String(i).padStart(3, "0")}.${s.tsx ? "tsx" : "ts"}`;
      // `export {}` keeps each snippet a module, so names don't clash and top-level await works.
      writeFileSync(join(dir, name), `${s.code}\nexport {};\n`);
      byFile.set(name, s);
    });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          extends: slash(relative(dir, join(ROOT, "tsconfig.json"))),
          compilerOptions: { noEmit: true, paths: workspacePaths(dir) },
          include: ["*.ts", "*.tsx"],
        },
        null,
        2,
      ),
    );
    const proc = Bun.spawn([process.execPath, "x", "tsc", "--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const errors: string[] = [];
    let current: string[] | null = null;
    for (const raw of (stdout + "\n" + stderr).split(/\r?\n/)) {
      const m = TSC_LINE.exec(raw);
      if (m) {
        const name = slash(m[1]).split("/").pop()!;
        const s = slash(m[1]).includes(slash(relative(ROOT, dir))) || slash(m[1]).startsWith(slash(dir)) ? byFile.get(name) : undefined;
        current = null;
        if (s) {
          const msg = `${s.file}:${s.line + Number(m[2]) - 1}:${m[3]} - ${m[4]}`;
          errors.push(msg);
          current = errors;
        }
      } else if (current && raw.startsWith("  ")) {
        errors[errors.length - 1] += "\n" + raw;
      }
    }
    if (errors.length === 0 && proc.exitCode !== 0 && !TSC_LINE.test(stdout.split(/\r?\n/)[0] ?? "") && stdout.trim() === "") {
      // tsc itself failed (bad config, missing binary): surface that instead of passing.
      errors.push(`tsc failed (exit ${proc.exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    return errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function packageSnippets(pkgs: readonly string[] = DOCUMENTED_PACKAGES): Snippet[] {
  const all: Snippet[] = [];
  for (const pkg of pkgs) {
    const rel = `packages/${pkg}/README.md`;
    const path = join(ROOT, rel);
    if (existsSync(path)) all.push(...extractSnippets(readFileSync(path, "utf8"), rel));
  }
  return all;
}

if (import.meta.main) {
  const pkgs = process.argv.slice(2);
  const snippets = packageSnippets(pkgs.length ? pkgs : DOCUMENTED_PACKAGES);
  const errors = await typecheckSnippets(snippets);
  for (const e of errors) console.error(e);
  console.log(`${snippets.length} snippet(s), ${errors.length} error(s)`);
  if (errors.length) process.exit(1);
}
