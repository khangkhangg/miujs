import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

export const ROOT = resolve(import.meta.dir, "../..");

export const run = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_NO_WARNINGS: "1", ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

let built: string | undefined;

/**
 * Build once per test process into a throwaway package root (dist/ plus symlinks to the
 * other published files), so concurrent runs never race on the repo's own dist/. Returns that root.
 * Emits with --noCheck: type errors are `bun run typecheck`'s job, not this test's.
 */
export function buildPackage(): string {
  if (built) return built;
  const root = mkdtempSync(join(tmpdir(), "miu-build-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  const r = run(["bun", join(ROOT, "scripts/build.ts"), "--outDir", join(root, "dist"), "--noCheck"], ROOT);
  if (r.code !== 0) throw new Error(`build failed:\n${r.out}\n${r.err}`);
  // The rest of the published `files` (src/ serves the "bun" export condition).
  for (const f of ["package.json", "templates", "src", "bin"]) symlinkSync(join(ROOT, f), join(root, f));
  return (built = root);
}
