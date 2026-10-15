// `miu logs`: pretty-print MiuJS JSON-lines logs from a local file, or from `wrangler tail
// --format json` on Cloudflare (through the injectable runner).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUNX, CliError, int, str, type CliIO, type Flags, type Runner } from "./util.ts";

export interface LogEntry {
  level: string;
  msg: string;
  time?: string;
  requestId?: string;
  route?: string;
  status?: number;
  ms?: number;
  [key: string]: unknown;
}

const HIDDEN = new Set(["level", "msg", "time", "requestId", "route", "status", "ms", "method", "path", "app"]);

function clock(time: unknown): string {
  if (typeof time !== "string" && typeof time !== "number") return "";
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? String(time) : d.toISOString().slice(11, 23);
}

const scalar = (v: unknown) => (typeof v === "string" ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v));

/** One readable line: `10:00:01.250 INFO  request getUser 200 3.25ms [r-1] GET /users/7 key=value`. */
export function formatEntry(e: LogEntry): string {
  const parts: string[] = [];
  const t = clock(e.time);
  if (t) parts.push(t);
  parts.push(String(e.level ?? "info").toUpperCase().padEnd(5));
  parts.push(e.msg);
  if (e.route) parts.push(String(e.route));
  if (e.status !== undefined) parts.push(String(e.status));
  if (e.ms !== undefined) parts.push(`${e.ms}ms`);
  if (e.requestId) parts.push(`[${e.requestId}]`);
  if (e.method && e.path) parts.push(`${e.method} ${e.path}`);
  for (const [k, v] of Object.entries(e)) if (!HIDDEN.has(k) && v !== undefined) parts.push(`${k}=${scalar(v)}`);
  return parts.join(" ");
}

/** A JSON log line as an entry, or null for plain text. */
export function parseLine(line: string): LogEntry | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const o = JSON.parse(s);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    return { ...o, level: String(o.level ?? "info"), msg: String(o.msg ?? o.message ?? "") };
  } catch {
    return null;
  }
}

/** Splits a stream of (possibly pretty-printed) JSON objects. Text between objects is ignored. */
export function jsonObjectSplitter(onObject: (text: string) => void) {
  let buf = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  return (chunk: string) => {
    const offset = buf.length;
    buf += chunk;
    for (let i = offset; i < buf.length; i++) {
      const c = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"' && depth > 0) inString = true;
      else if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          onObject(buf.slice(start, i + 1));
          buf = buf.slice(i + 1);
          i = -1;
          start = -1;
        }
      }
    }
    if (depth === 0) buf = "";
  };
}

const CF_LEVEL: Record<string, string> = { log: "info", info: "info", debug: "debug", warn: "warn", error: "error" };

/** Entries from one `wrangler tail --format json` event: the app's log lines, then exceptions. */
export function entriesFromTail(event: any): LogEntry[] {
  const out: LogEntry[] = [];
  for (const log of event?.logs ?? []) {
    const message: unknown[] = Array.isArray(log.message) ? log.message : [log.message];
    const parsed = message.length === 1 && typeof message[0] === "string" ? parseLine(message[0]) : null;
    if (parsed) out.push(parsed);
    else {
      out.push({
        level: CF_LEVEL[log.level] ?? String(log.level ?? "info"),
        msg: message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" "),
        time: log.timestamp ? new Date(log.timestamp).toISOString() : undefined,
      });
    }
  }
  for (const ex of event?.exceptions ?? []) {
    out.push({ level: "error", msg: `${ex.name ?? "Error"}: ${ex.message ?? ""}`, time: ex.timestamp ? new Date(ex.timestamp).toISOString() : undefined });
  }
  if (!out.length && event?.event?.request) {
    let path = event.event.request.url;
    try {
      path = new URL(path).pathname;
    } catch {}
    out.push({
      level: event.outcome === "ok" ? "info" : "error",
      msg: "request",
      time: event.eventTimestamp ? new Date(event.eventTimestamp).toISOString() : undefined,
      method: event.event.request.method,
      path,
      status: event.event.response?.status,
      outcome: event.outcome,
    });
  }
  return out;
}

export async function cmdLogs(io: CliIO, flags: Flags, run: Runner) {
  const json = !!flags.json;
  const print = (e: LogEntry | string) => {
    if (typeof e === "string") io.out(json ? JSON.stringify({ level: "info", msg: e }) : e);
    else io.out(json ? JSON.stringify(e) : formatEntry(e));
  };
  const file = str(flags, "file");
  const worker = str(flags, "worker");

  if (file) {
    const path = resolve(io.cwd, file);
    if (!existsSync(path)) throw new CliError("MIU_E_CLI_LOGS_FILE", `Log file ${file} does not exist`, "Point --file at the file your app writes its JSON log lines to (e.g. `bun app.ts > app.log`).");
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const last = int(flags, "last", 50, 1);
    for (const line of lines.slice(-last)) print(parseLine(line) ?? line);
    return 0;
  }

  if (!worker && !existsSync(join(io.cwd, "wrangler.toml")) && !existsSync(join(io.cwd, "wrangler.jsonc")) && !existsSync(join(io.cwd, "wrangler.json"))) {
    throw new CliError(
      "MIU_E_CLI_LOGS_SOURCE",
      "No log source: no --file and no wrangler config here",
      "Pass --file app.log for a local app (run it with `bun app.ts > app.log`), or --worker <name> (or run in the folder with wrangler.toml) to tail Cloudflare.",
    );
  }

  const limit = flags.last ? int(flags, "last", 0, 1) : Infinity;
  let shown = 0;
  const stop = new AbortController();
  const split = jsonObjectSplitter((text) => {
    if (shown >= limit) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    for (const e of entriesFromTail(event)) {
      if (shown >= limit) break;
      print(e);
      shown++;
    }
    if (shown >= limit) stop.abort();
  });
  const cmd = [...BUNX(), "wrangler", "tail", ...(worker ? [worker] : []), "--format", "json"];
  if (!json) io.err(`Tailing ${worker ?? "the worker in wrangler.toml"} (bunx wrangler tail --format json). Ctrl+C to stop.`);
  const r = await run(cmd, { cwd: io.cwd, onStdout: split, signal: stop.signal });
  if (r.code !== 0 && !stop.signal.aborted) {
    throw new CliError("MIU_E_CLI_WRANGLER", `wrangler tail failed: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`, "Run `bunx wrangler login` and check the worker name (`--worker <name>` or `name` in wrangler.toml); the worker must be deployed.");
  }
  return 0;
}
