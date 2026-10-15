import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type RunOptions, type RunResult, type Runner } from "../src/index.ts";

export const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
export const REPO = join(import.meta.dir, "..", "..", "..");

export async function run(args: string[], cwd: string, runner?: Runner) {
  let out = "";
  let err = "";
  const code = await runCli(args, { cwd, out: (s) => void (out += s + "\n"), err: (s) => void (err += s + "\n"), run: runner });
  return { code, out, err };
}

const temps: string[] = [];
const links: string[] = [];
const bases = new Set<string>();
export function tempDir(base = tmpdir()) {
  if (base !== tmpdir()) bases.add(base);
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, "miu-cli-"));
  temps.push(d);
  return d;
}
/**
 * Deletes temp folders and links. Each test file calls `afterEach(cleanup)` itself: this module is
 * evaluated once per process, so a hook registered here would only attach to the first test file.
 */
export function cleanup() {
  // Remove links first so a recursive delete can never walk into the linked packages.
  for (const l of links.splice(0)) {
    try {
      unlinkSync(l);
    } catch {}
  }
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  // Folders made inside the repo (e.g. packages/cli/.tmp) go too once empty.
  for (const b of bases) {
    try {
      rmdirSync(b);
    } catch {}
  }
}

/** Links `node_modules/<name>` in `dir` to a real folder, the way `bun install` would. */
export function link(dir: string, name: string, target: string) {
  const at = join(dir, "node_modules", name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(realpathSync(target), at, "junction");
  links.push(at);
}

/** Links miujs and every @miujs/* workspace package (plus drizzle-orm) into `dir`. */
export function linkWorkspace(dir: string, packages: string[]) {
  for (const p of packages) {
    if (p === "miujs") link(dir, "miujs", join(REPO, "packages", "miujs"));
    else if (p === "drizzle-orm") link(dir, "drizzle-orm", join(REPO, "packages", "db", "node_modules", "drizzle-orm"));
    else link(dir, p, join(REPO, "packages", p.replace("@miujs/", "")));
  }
}

export interface FakeCall {
  cmd: string[];
  opts: RunOptions;
}

/** A Runner that records calls and answers from `respond`. Never spawns anything. */
export function fakeRunner(respond: (cmd: string[], opts: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>> = () => ({})) {
  const calls: FakeCall[] = [];
  const runner: Runner = async (cmd, opts) => {
    calls.push({ cmd, opts });
    const r = await respond(cmd, opts);
    if (r.stdout && opts.onStdout) opts.onStdout(r.stdout);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}
