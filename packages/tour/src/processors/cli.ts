// Running command-line tools (vips, gltf-transform) from a processor. Bun/Node/Deno only:
// every node:* import is dynamic and guarded, so this module loads (but refuses to run) on
// Cloudflare Workers, where there are no processes.
import { detectRuntime } from "miujs";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `cmd` (no shell: arguments are passed as-is). Rejects with an error whose `code` is
 * "ENOENT" when the program does not exist. Inject your own in tests or to run in a sandbox.
 */
export type Exec = (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

function notFound(cmd: string): Error {
  const e = new Error(`${cmd}: command not found`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && ((err as { code?: string }).code === "ENOENT" || /ENOENT|not found|No such file/i.test(String((err as Error).message)));
}

/** Bun.spawn on Bun, child_process elsewhere; never a shell. */
export const defaultExec: Exec = async (cmd, opts = {}) => {
  const runtime = detectRuntime();
  if (runtime === "workerd") throw notFound(cmd[0]);
  const timeout = opts.timeoutMs ?? 30 * 60_000;
  const B = (globalThis as { Bun?: { spawn(cmd: string[], o: unknown): any } }).Bun;
  if (B?.spawn) {
    let p: any;
    try {
      p = B.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", timeout });
    } catch (err) {
      if (isNotFound(err)) throw notFound(cmd[0]);
      throw err;
    }
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code: Number(code), stdout, stderr };
  }
  const mod = "node:child_process";
  const cp = (await import(/* @vite-ignore */ mod)) as typeof import("node:child_process");
  return new Promise((resolve, reject) => {
    cp.execFile(cmd[0], cmd.slice(1), { cwd: opts.cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as { code?: unknown }).code === "ENOENT") return reject(notFound(cmd[0]));
      if (err && typeof (err as { code?: unknown }).code !== "number") return reject(err);
      resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
};

/** A temporary folder on disk for one processing run. */
export interface Workspace {
  dir: string;
  path(...parts: string[]): string;
  write(name: string, bytes: Uint8Array): Promise<string>;
  read(file: string): Promise<Uint8Array>;
  /** Files under `dir` (recursive), as paths relative to it with "/" separators. */
  list(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  remove(): Promise<void>;
}

export async function tempWorkspace(prefix = "miu-tour-"): Promise<Workspace> {
  if (detectRuntime() === "workerd") throw notFound("filesystem");
  const [fs, os, path] = (await Promise.all(["node:fs/promises", "node:os", "node:path"].map((m) => import(/* @vite-ignore */ m)))) as [
    typeof import("node:fs/promises"),
    typeof import("node:os"),
    typeof import("node:path"),
  ];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const list = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (abs: string, rel: string) => {
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(abs, e.name), r);
        else out.push(r);
      }
    };
    await walk(d, "");
    return out.sort();
  };
  return {
    dir,
    path: (...parts) => path.join(dir, ...parts),
    async write(name, bytes) {
      const p = path.join(dir, name);
      await fs.writeFile(p, bytes);
      return p;
    },
    read: async (file) => new Uint8Array(await fs.readFile(file)),
    list,
    mkdir: async (d) => void (await fs.mkdir(d, { recursive: true })),
    remove: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
