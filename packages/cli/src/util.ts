// Shared pieces for the `miu` commands: IO, errors, flag parsing, the command runner and app loading.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface RunOptions {
  cwd: string;
  /** Called with stdout text as it arrives (for streams such as `wrangler tail`). */
  onStdout?: (chunk: string) => void;
  /** Pass stdout/stderr straight to the terminal instead of capturing them. */
  inherit?: boolean;
  /** Stops the process (e.g. `miu logs --last N` once N lines arrived). */
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command (wrangler, flyctl, bun build, ...). Injectable so tests never spawn or hit the network. */
export type Runner = (cmd: string[], opts: RunOptions) => Promise<RunResult>;

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Default: spawns the command with Bun. */
  run?: Runner;
}

export class CliError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

/** `bunx` as an argv prefix. Uses the running Bun binary so it works when bunx is not on PATH. */
export const BUNX = (): string[] => [process.execPath, "x"];

export const defaultRunner: Runner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
    stdin: "inherit",
    env: { ...process.env, ...opts.env },
  });
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const read = async (stream: ReadableStream<Uint8Array> | number | undefined, onChunk?: (s: string) => void) => {
    if (!stream || typeof stream === "number") return "";
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream as ReadableStream<Uint8Array>) {
      const s = decoder.decode(chunk, { stream: true });
      text += s;
      onChunk?.(s);
    }
    return text;
  };
  const [stdout, stderr] = await Promise.all([read(proc.stdout as never, opts.onStdout), read(proc.stderr as never)]);
  const code = await proc.exited;
  opts.signal?.removeEventListener("abort", onAbort);
  return { code: opts.signal?.aborted ? 0 : code, stdout, stderr };
};

/** How a command's flags are read: `"bool"` (`--json`) or `"value"` (`--out file`, `--out=file`). */
export type FlagSpec = Record<string, "bool" | "value">;
export type Flags = Record<string, string | true>;

export function parseArgs(args: string[], spec: FlagSpec, command: string) {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") || a === "--") {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = key === "help" ? "bool" : spec[key];
    if (!kind) {
      const known = Object.keys(spec).map((k) => `--${k}`);
      throw new CliError(
        "MIU_E_CLI_UNKNOWN_FLAG",
        `Unknown flag --${key} for \`miu ${command}\``,
        known.length ? `Valid flags: ${known.join(", ")}. Run \`miu help\` for details.` : `\`miu ${command}\` takes no flags. Run \`miu help\` for details.`,
      );
    }
    if (kind === "bool") {
      if (eq !== -1) throw new CliError("MIU_E_CLI_FLAG_VALUE", `--${key} does not take a value`, `Write --${key} on its own.`);
      flags[key] = true;
      continue;
    }
    const value = eq !== -1 ? a.slice(eq + 1) : args[i + 1];
    if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
      throw new CliError("MIU_E_CLI_FLAG_VALUE", `--${key} needs a value`, `Write --${key} <value> or --${key}=<value>.`);
    }
    flags[key] = value;
    if (eq === -1) i++;
  }
  return { positional, flags };
}

export function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function int(flags: Flags, key: string, fallback: number, min = 0): number {
  const v = str(flags, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new CliError("MIU_E_CLI_FLAG_VALUE", `--${key} must be a whole number ≥ ${min}, got "${v}"`, `Write e.g. --${key} ${Math.max(min, fallback)}.`);
  return n;
}

const ENTRY_CANDIDATES = ["app.ts", "src/app.ts", "index.ts", "src/index.ts", "app.tsx", "src/app.tsx"];

export function findEntry(cwd: string, given?: string): string {
  if (given) {
    const p = resolve(cwd, given);
    if (!existsSync(p)) throw new CliError("MIU_E_CLI_NO_APP", `Entry file ${given} does not exist`, "Pass the path to the file that default-exports your app.");
    return p;
  }
  for (const c of ENTRY_CANDIDATES) {
    const p = join(cwd, c);
    if (existsSync(p)) return p;
  }
  throw new CliError(
    "MIU_E_CLI_NO_APP",
    `No app entry found in ${cwd}`,
    `Create app.ts with \`export default miu({...})\`, or pass the entry path (tried ${ENTRY_CANDIDATES.join(", ")}).`,
  );
}

export interface AppLike {
  name: string;
  ready(): Promise<void>;
  inspect(): any;
  openapi(): any;
  tests: { name: string; fn: (call: unknown) => unknown }[];
  call: unknown;
}

/** Imports the entry and waits for the app. Returns the module too (for checks on its exports). */
export async function loadAppModule(entry: string): Promise<{ app: AppLike; mod: Record<string, unknown> }> {
  const mod = await import(pathToFileURL(entry).href);
  const app = mod.default;
  if (!app || typeof app.inspect !== "function" || typeof app.ready !== "function") {
    throw new CliError("MIU_E_CLI_NO_DEFAULT_EXPORT", `${entry} does not default-export a MiuJS app`, "Add `export default miu({ ... })` to the entry file.");
  }
  await app.ready();
  return { app, mod };
}

export async function loadApp(entry: string): Promise<AppLike> {
  return (await loadAppModule(entry)).app;
}

export function writeNew(file: string, content: string) {
  if (existsSync(file)) throw new CliError("MIU_E_CLI_EXISTS", `${file} already exists`, "Pick another name or delete the existing file first.");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function writeFile(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", ".miu"]);

/** Files under `dir` whose names match `ext`, skipping node_modules, .git and build output. */
export function* walk(dir: string, ext: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, ext);
    else if (ext.test(name) && st.size < 1_000_000) yield p;
  }
}

/** `10s`, `500ms`, `2m`, or a bare number of seconds → milliseconds. */
export function parseDuration(text: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (!m) throw new CliError("MIU_E_CLI_FLAG_VALUE", `--${flag} must be a duration like 10s, 500ms or 2m, got "${text}"`, `Write e.g. --${flag} 10s.`);
  const n = Number(m[1]);
  return Math.round(m[2] === "ms" ? n : m[2] === "m" ? n * 60_000 : n * 1000);
}
