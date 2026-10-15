// Shared plumbing for the workerd harness: find Node and wrangler, generate wrangler config with
// the MiuJS CLI (`miu deploy cloudflare --dry-run`), start `wrangler dev --local` on a free port,
// and talk to it over HTTP and WebSockets. Local only: never logs in, never deploys.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";

export const HARNESS = import.meta.dir;
export const ROOT = resolve(HARNESS, "../..");
export const OUT = join(HARNESS, ".out");
const WRANGLER_JS = join(HARNESS, "node_modules/wrangler/bin/wrangler.js");
const BUN = process.execPath;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// tools

/** Node 20+ for wrangler: $NODE, `node` on PATH, or a portable install under %LOCALAPPDATA%\nodejs. */
/** True for a Node.js binary, false for Bun's `node` shim (or anything that does not run). */
export function isRealNode(exe: string): boolean {
  if (/[\\/]bun-node-[^\\/]*[\\/]/.test(exe)) return false;
  const r = spawnSync(exe, ["-p", "process.versions.bun ? 'bun' : 'node'"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "node";
}

export function nodeBin(): string {
  // `bun run <script>` sets NODE and puts Bun's own `node` shim (…/bun-node-<hash>/node) first on PATH. Wrangler
  // on Bun cannot reach its proxy worker ("getaddrinfo ENOTFOUND dummy" in ProxyController) and
  // never serves a request, so only accept a binary that really is Node.
  if (process.env.NODE && existsSync(process.env.NODE) && isRealNode(process.env.NODE)) return process.env.NODE;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["-a", "node"].slice(process.platform === "win32" ? 1 : 0), { encoding: "utf8" });
  for (const line of which.status === 0 ? which.stdout.split(/\r?\n/) : []) {
    const exe = line.trim();
    if (exe && isRealNode(exe)) return exe;
  }
  const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "nodejs") : "";
  if (local && existsSync(local)) {
    for (const d of readdirSync(local).sort().reverse()) {
      const exe = join(local, d, "node.exe");
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error("Node 20+ is needed to run wrangler. Install it, put it on PATH, or set NODE=/path/to/node.");
}

/** `bun install` in scripts/workerd (wrangler is pinned there, outside the workspaces). */
export function ensureWrangler(): void {
  if (existsSync(WRANGLER_JS)) return;
  console.log("Installing wrangler into scripts/workerd/node_modules ...");
  const r = spawnSync(BUN, ["install", "--frozen-lockfile"], { cwd: HARNESS, stdio: "inherit" });
  if (r.status !== 0) throw new Error("bun install in scripts/workerd failed");
}

/**
 * The fixture apps in scripts/workerd/apps are not workspaces: link `miujs` and `@miujs/*` into
 * scripts/workerd/node_modules (junctions on Windows, no admin rights needed) so Bun, wrangler's
 * esbuild and the CLI resolve them like an installed app would.
 */
export function linkWorkspacePackages(): void {
  const nm = join(HARNESS, "node_modules");
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const pkgFile = join(ROOT, "packages", dir, "package.json");
    if (!existsSync(pkgFile)) continue;
    const name = JSON.parse(readFileSync(pkgFile, "utf8")).name as string;
    const link = join(nm, ...name.split("/"));
    if (existsSync(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(ROOT, "packages", dir), link, "junction");
  }
}

function workerdExe(): string | null {
  const pkg = process.platform === "win32" ? "workerd-windows-64" : process.platform === "darwin" ? (process.arch === "arm64" ? "workerd-darwin-arm64" : "workerd-darwin-64") : process.arch === "arm64" ? "workerd-linux-arm64" : "workerd-linux-64";
  const exe = join(HARNESS, "node_modules/@cloudflare", pkg, "bin", process.platform === "win32" ? "workerd.exe" : "workerd");
  return existsSync(exe) ? exe : null;
}

/**
 * workerd on Windows links against the Visual C++ runtime (MSVCP140, VCRUNTIME140, VCRUNTIME140_1).
 * When it is not installed system-wide, copy Microsoft's DLLs from an app that ships them next to
 * workerd.exe (app-local deployment; touches only scripts/workerd/node_modules).
 */
export function ensureWorkerdRuns(): string {
  const exe = workerdExe();
  if (!exe) throw new Error("workerd binary not found; run `bun install` in scripts/workerd");
  const probe = () => spawnSync(exe, ["--version"], { encoding: "utf8" });
  let r = probe();
  if (r.status === 0) return r.stdout.trim();
  if (process.platform === "win32") {
    const dlls = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const candidates = [join(pf, "Common Files/microsoft shared/ClickToRun"), join(pf, "Microsoft Office/root/Office16"), join(pf, "ExpressVPN")];
    const dir = candidates.find((d) => dlls.every((f) => existsSync(join(d, f))));
    if (dir) {
      for (const f of dlls) copyFileSync(join(dir, f), join(dirname(exe), f));
      console.log(`workerd needed the Visual C++ runtime; copied ${dlls.join(", ")} from ${dir} next to workerd.exe`);
      r = probe();
      if (r.status === 0) return r.stdout.trim();
    }
    throw new Error("workerd.exe cannot start (missing Visual C++ runtime). Install the VC++ 2015-2022 x64 redistributable.");
  }
  throw new Error(`workerd cannot start: ${r.stderr || r.stdout}`);
}

/** Newest compatibility date the installed workerd supports (from its package version 1.YYYYMMDD.N). */
export function workerdCompatDate(): string {
  const v = JSON.parse(readFileSync(join(HARNESS, "node_modules/workerd/package.json"), "utf8")).version as string;
  const d = v.split(".")[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function wranglerVersion(): string {
  return JSON.parse(readFileSync(join(HARNESS, "node_modules/wrangler/package.json"), "utf8")).version;
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// config generation through the MiuJS CLI

export interface AppSpec {
  /** Short name: .out/<name>/ holds the generated config, logs and local state. */
  name: string;
  /** App folder (the CLI's cwd), relative to the repo root. */
  dir: string;
  /** Entry file inside dir (default: CLI auto-detect). */
  entry?: string;
  /** Env vars / secrets for `wrangler dev --var`. */
  vars?: Record<string, string>;
}

export interface Generated {
  config: string;
  toml: string;
  cliOutput: string;
}

/** `miu deploy cloudflare --dry-run --out .out/<name>/wrangler.toml` from the app's folder. */
export function generateConfig(app: AppSpec, compatDate: string): Generated {
  const outDir = join(OUT, app.name);
  mkdirSync(outDir, { recursive: true });
  const config = join(outDir, "wrangler.toml");
  const args = [join(ROOT, "packages/cli/src/bin.ts"), "deploy", "cloudflare", "--dry-run", "--force", "--out", config, "--compatibility-date", compatDate];
  if (app.entry) args.push("--entry", app.entry);
  const r = spawnSync(BUN, args, { cwd: join(ROOT, app.dir), encoding: "utf8", env: { ...process.env, MIU_ENV: "production" } });
  const cliOutput = `${r.stdout}${r.stderr}`;
  if (r.status !== 0) throw new Error(`miu deploy cloudflare --dry-run failed for ${app.name}:\n${cliOutput}`);
  return { config, toml: readFileSync(config, "utf8"), cliOutput };
}

// ---------------------------------------------------------------------------------------------
// wrangler dev --local

export interface Dev {
  url: string;
  ws: string;
  port: number;
  /** Everything wrangler and the Worker printed so far. */
  logs(): string;
  /** Wait until the log matches. */
  waitForLog(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  /** Milliseconds from spawning wrangler to "Ready on". */
  startupMs: number;
  stop(): Promise<void>;
}

export interface StartOptions {
  app: AppSpec;
  config: string;
  compatDate: string;
  /** Keep .out/<name>/state from an earlier run (restart scenarios). */
  keepState?: boolean;
  /** Timeout for "Ready on". */
  readyMs?: number;
}

const running = new Set<ChildProcess>();

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

process.on("exit", () => {
  for (const c of running) killTree(c);
});

export async function startDev(o: StartOptions): Promise<Dev> {
  const node = nodeBin();
  const port = await freePort();
  const inspector = await freePort();
  const outDir = join(OUT, o.app.name);
  const state = join(outDir, "state");
  if (!o.keepState) rmSync(state, { recursive: true, force: true });
  const args = [
    WRANGLER_JS,
    "dev",
    "--local",
    "--config",
    o.config,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspector),
    "--persist-to",
    state,
    "--compatibility-date",
    o.compatDate,
    "--test-scheduled",
    "--show-interactive-dev-session=false",
    "--log-level",
    "log",
  ];
  for (const [k, v] of Object.entries(o.app.vars ?? {})) args.push("--var", `${k}:${v}`);
  const started = performance.now();
  const child = spawn(node, args, {
    cwd: dirname(o.config),
    // CLOUDFLARE_CF_FETCH_ENABLED=false: use Miniflare's built-in placeholder request.cf instead of
    // downloading cf.json, so runs are hermetic (no network) and identical everywhere.
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_CF_FETCH_ENABLED: "false", NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_LOG_PATH: join(outDir, "wrangler-logs") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  running.add(child);
  let log = "";
  const waiters = new Set<() => void>();
  const onData = (b: Buffer) => {
    log += b.toString("utf8");
    for (const w of [...waiters]) w();
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  const logFile = join(outDir, `wrangler${o.keepState ? "-restart" : ""}.log`);

  const waitForLog = (re: RegExp, ms = 15_000) =>
    new Promise<RegExpMatchArray>((res, rej) => {
      const check = () => {
        const m = log.match(re);
        if (m) {
          waiters.delete(check);
          clearTimeout(t);
          res(m);
        } else if (child.exitCode !== null) {
          waiters.delete(check);
          clearTimeout(t);
          rej(new Error(`wrangler exited (${child.exitCode}) before ${re}:\n${log.slice(-3000)}`));
        }
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        rej(new Error(`timed out after ${ms} ms waiting for ${re} in wrangler output:\n${log.slice(-3000)}`));
      }, ms);
      waiters.add(check);
      child.once("exit", check);
      check();
    });

  try {
    await waitForLog(/Ready on (http:\/\/[^\s]+)/, o.readyMs ?? 120_000);
  } catch (e) {
    writeFileSync(logFile, log);
    killTree(child);
    running.delete(child);
    throw e;
  }
  const startupMs = performance.now() - started;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    ws: `ws://127.0.0.1:${port}`,
    port,
    startupMs,
    logs: () => log,
    waitForLog,
    async stop() {
      killTree(child);
      running.delete(child);
      await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
      writeFileSync(logFile, log);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP client with a cookie jar

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  ms: number;
}

export class Client {
  base: string;
  jar = new Map<string, string>();
  headers: Record<string, string>;
  constructor(base: string, headers: Record<string, string> = {}) {
    this.base = base;
    this.headers = headers;
  }

  async req(method: string, path: string, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; form?: Record<string, string> } = {}): Promise<Res> {
    const headers = new Headers({ origin: this.base, ...this.headers, ...init.headers });
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers.set("content-type", "application/json");
    } else if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const t0 = performance.now();
    const res = await fetch(this.base + path, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    const ms = performance.now() - t0;
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (/max-age=0/i.test(c) || v === "") this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), v);
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, json, ms };
  }
  get(path: string, init?: Parameters<Client["req"]>[2]) {
    return this.req("GET", path, init);
  }
  post(path: string, json?: unknown, init: Parameters<Client["req"]>[2] = {}) {
    return this.req("POST", path, { ...init, json });
  }
}

/** JSON-RPC over POST /mcp (streamable HTTP, JSON responses). */
export async function mcp(c: Client, method: string, params: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await c.req("POST", "/mcp", { json: { jsonrpc: "2.0", id: 1, method, params }, headers: { accept: "application/json, text/event-stream", ...headers } });
  if (r.json) return r.json;
  const data = r.text.split("\n").find((l) => l.startsWith("data:"));
  return data ? JSON.parse(data.slice(5)) : { status: r.status, text: r.text };
}

// ---------------------------------------------------------------------------------------------
// scenarios and results

export type Status = "pass" | "fail" | "skip";
export interface Result {
  app: string;
  name: string;
  status: Status;
  ms: number;
  note?: string;
}
export const results: Result[] = [];
export const metrics: Record<string, unknown> = {};

export class Skip extends Error {}
export function skip(reason: string): never {
  throw new Skip(reason);
}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function eq(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function scenario(app: string, name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ app, name, status: "pass", ms: performance.now() - t0, note: note || undefined });
    console.log(`  pass  ${name}${note ? `  (${note})` : ""}`);
    return true;
  } catch (e) {
    const skipped = e instanceof Skip;
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ app, name, status: skipped ? "skip" : "fail", ms: performance.now() - t0, note: msg.slice(0, 2000) });
    console.log(`  ${skipped ? "skip" : "FAIL"}  ${name}: ${msg.split("\n").slice(0, 8).join("\n        ")}`);
    return false;
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, ms = 5000, what = "condition", every = 20): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

export function percentiles(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { count: s.length, min: r(s[0] ?? NaN), p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(s[s.length - 1] ?? NaN), mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
}

/**
 * Resident memory of the running workerd process(es) in MB, from the OS (tasklist / ps). This is
 * the whole local runtime (Miniflare's simulators included), not one isolate. null if unknown.
 */
export function workerdMemoryMb(): number | null {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq workerd.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const kb = [...r.stdout.matchAll(/"workerd\.exe".*?"([\d.,\s]+) K"/g)].reduce((n, m) => n + Number(m[1].replace(/[.,\s]/g, "")), 0);
      return kb ? Math.round(kb / 1024) : null;
    }
    const r = spawnSync("ps", ["-A", "-o", "rss=,comm="], { encoding: "utf8" });
    const kb = r.stdout
      .split("\n")
      .filter((l) => /workerd/.test(l))
      .reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0);
    return kb ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

export function rel(p: string) {
  return relative(ROOT, p).replace(/\\/g, "/");
}

/** Local Explorer API that wrangler dev serves (KV / D1 / R2 / DO inspection). */
export async function explorer(dev: Dev, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${dev.url}/cdn-cgi/local/explorer/api${path}`, init);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: r.status, text };
  }
}
