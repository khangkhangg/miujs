// Contract capture: record request/response pairs (through the proxy or MiuJS routes) as JSONL
// cases that verifyContracts() replays. Personal data is redacted before anything is written.

import { definePlugin, detectRuntime, type Context } from "miujs";
import { fromUtf8 } from "./bytes.ts";
import { migrateError } from "./errors.ts";
import { PROXIED } from "./proxy.ts";

/** One recorded exchange (one JSONL line). */
export interface CaptureEntry {
  v: 1;
  ts: string;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  /** JSON value, form object, text, or null (see bodyOmitted). */
  body: unknown;
  bodyOmitted?: string;
  status: number;
  responseHeaders: Record<string, string>;
  response: unknown;
  responseOmitted?: string;
  durationMs: number;
  servedBy: "proxy" | "miujs";
  route: string | null;
  /** Optional label used in reports. */
  name?: string;
}

export type CaptureSink = { write(entry: CaptureEntry): void | Promise<void> } | ((line: string) => void | Promise<void>);

export interface RedactOptions {
  /** Extra object keys (case-insensitive substrings) whose values are replaced. */
  keys?: string[];
}

export interface CaptureOptions {
  sink: CaptureSink;
  redact?: RedactOptions & { /** Extra header names whose values are replaced. */ headers?: string[] };
  /** Fraction of requests to record (0..1), or a predicate. Default 1. */
  sample?: number | ((ctx: Context) => boolean);
  /** Extra request/response header names to record (besides content-type, accept, location, ...). */
  headers?: string[];
  /** Largest body recorded, in bytes. Default 64 KiB; bigger bodies are omitted. */
  maxBodyBytes?: number;
  /** "all" (default) or only exchanges forwarded to the old app. */
  only?: "all" | "proxied";
}

const R = "[REDACTED]";
const SECRET_KEY = /pass(word|wd|phrase)?|secret|token|api[_-]?key|^auth$|authori[sz]ation|cookie|session|csrf|xsrf|ssn|social[_-]?security|credit|card[_-]?(number|no)|cvv|cvc|iban|private[_-]?key|^e-?mail$|email[_-]?address|otp|mfa|signature/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKENISH = /^[A-Za-z0-9_\-+/=.]{32,}$/;

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token", "x-proxy-secret"]);
const REQUEST_HEADERS = ["content-type", "accept", "accept-language", "x-requested-with", "authorization", "cookie"];
const RESPONSE_HEADERS = ["content-type", "location", "set-cookie", "cache-control", "content-disposition"];

function redactString(s: string): string {
  if (TOKENISH.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return "[TOKEN]";
  return s.replace(JWT, "[TOKEN]").replace(BEARER, "$1 [TOKEN]").replace(EMAIL, "[EMAIL]");
}

/** Replaces personal data in a JSON-like value: secret-looking keys, emails, bearer tokens, JWTs, long random strings. */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const extra = (opts.keys ?? []).map((k) => k.toLowerCase());
  const secretKey = (k: string) => SECRET_KEY.test(k) || extra.some((e) => k.toLowerCase().includes(e));
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) return R;
    if (typeof v === "string") return redactString(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const val = secretKey(k) && x !== null && typeof x !== "object" ? R : secretKey(k) && x !== null ? R : walk(x, depth + 1);
        Object.defineProperty(out, k, { value: val, enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | "too large" | null> {
  if (!stream) return null;
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return "too large";
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function decodeBody(
  stream: ReadableStream<Uint8Array> | null,
  headers: Headers,
  max: number,
  ropts: RedactOptions,
): Promise<{ value: unknown; omitted?: string }> {
  const declared = Number(headers.get("content-length") ?? NaN);
  if (declared > max) {
    await stream?.cancel().catch(() => {});
    return { value: null, omitted: "too large" };
  }
  let bytes = await readLimited(stream, max);
  if (bytes === "too large") return { value: null, omitted: "too large" };
  if (!bytes || bytes.length === 0) return { value: null };
  const enc = (headers.get("content-encoding") ?? "").toLowerCase();
  if (enc === "gzip" || enc === "deflate") {
    try {
      const d = await readLimited(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(enc) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), max);
      if (d === "too large") return { value: null, omitted: "too large" };
      bytes = d;
    } catch {
      return { value: null, omitted: "undecodable" };
    }
  } else if (enc && enc !== "identity") {
    return { value: null, omitted: `content-encoding ${enc}` };
  }
  if (!bytes) return { value: null };
  const type = (headers.get("content-type") ?? "").toLowerCase();
  const text = fromUtf8(bytes);
  if (type.includes("json")) {
    try {
      return { value: redact(JSON.parse(text), ropts) };
    } catch {
      return { value: redactString(text) };
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    const obj: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(text)) {
      const prev = obj[k];
      obj[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return { value: redact(obj, ropts) };
  }
  if (type.startsWith("text/") || type.includes("xml") || type.includes("javascript") || type === "") return { value: redactString(text) };
  return { value: null, omitted: `binary ${type}` };
}

function pickHeaders(h: Headers, names: string[], sensitive: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = n === "set-cookie" ? h.getSetCookie().join(", ") || null : h.get(n);
    if (v === null) continue;
    out[n] = sensitive.has(n) ? R : redactString(v);
  }
  return out;
}

function writeTo(sink: CaptureSink, entry: CaptureEntry): void | Promise<void> {
  return typeof sink === "function" ? sink(JSON.stringify(entry)) : sink.write(entry);
}

/** In-memory sink (tests, small runs). */
export function memorySink() {
  const entries: CaptureEntry[] = [];
  return {
    entries,
    write(e: CaptureEntry) {
      entries.push(e);
    },
    jsonl: () => entries.map((e) => JSON.stringify(e)).join("\n"),
  };
}

/** Appends JSONL to a file (Bun/Node/Deno only). */
export function jsonlFileSink(path: string): CaptureSink {
  let chain: Promise<void> = Promise.resolve();
  return (line: string) => {
    chain = chain.then(async () => {
      if (detectRuntime() === "workerd") throw migrateError("CONFIG", 500, "jsonlFileSink needs a filesystem", "On Workers, pass a sink that writes to R2, KV or a queue.");
      const mod = "node:fs/promises";
      const fs = (await import(/* @vite-ignore */ mod)) as { appendFile(p: string, d: string): Promise<void> };
      await fs.appendFile(path, `${line}\n`);
    });
    return chain;
  };
}

/** Parses JSONL capture output into cases. Blank lines are skipped. */
export function parseCases(jsonl: string): CaptureEntry[] {
  const out: CaptureEntry[] = [];
  const lines = jsonl.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let e: CaptureEntry;
    try {
      e = JSON.parse(line);
    } catch {
      throw migrateError("CASES", 400, `Line ${i + 1} of the cases file is not JSON`, "Each line must be one JSON object written by captureMiddleware (JSONL). Remove or fix the line.");
    }
    if (!e || typeof e.method !== "string" || typeof e.path !== "string") {
      throw migrateError("CASES", 400, `Line ${i + 1} of the cases file has no method/path`, "Each case needs at least { method, path }.");
    }
    out.push(e);
  }
  return out;
}

const STATE = "migrate.capture";

/** Records exchanges to `sink`. Put it before migrateProxy in `plugins` so proxied requests are seen. */
export function captureMiddleware(opts: CaptureOptions) {
  const max = opts.maxBodyBytes ?? 64 * 1024;
  const ropts: RedactOptions = { keys: opts.redact?.keys };
  const sensitive = new Set([...SENSITIVE_HEADERS, ...(opts.redact?.headers ?? []).map((h) => h.toLowerCase())]);
  const extra = (opts.headers ?? []).map((h) => h.toLowerCase());
  const reqNames = [...new Set([...REQUEST_HEADERS, ...extra])];
  const resNames = [...new Set([...RESPONSE_HEADERS, ...extra])];

  return definePlugin({
    name: "migrate-capture",
    onRequest(ctx) {
      const s = opts.sample ?? 1;
      const take = typeof s === "function" ? s(ctx) : s >= 1 || Math.random() < s;
      if (!take) return;
      const hasBody = ctx.method !== "GET" && ctx.method !== "HEAD" && ctx.req.body !== null;
      const query: Record<string, string | string[]> = {};
      for (const [k, v] of ctx.url.searchParams) {
        const prev = query[k];
        query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      ctx.state[STATE] = { start: performance.now(), query, clone: hasBody ? ctx.req.clone() : null };
    },
    onResponse(ctx, res) {
      const st = ctx.state[STATE] as { start: number; query: Record<string, string | string[]>; clone: Request | null } | undefined;
      if (!st) return;
      const proxied = ctx.state[PROXIED] === true;
      if (opts.only === "proxied" && !proxied) {
        st.clone?.body?.cancel().catch(() => {});
        return;
      }
      const durationMs = Math.round((performance.now() - st.start) * 100) / 100;
      const copy = res.clone();
      ctx.waitUntil(
        (async () => {
          try {
            const [reqBody, resBody] = await Promise.all([
              st.clone ? decodeBody(st.clone.body, st.clone.headers, max, ropts) : Promise.resolve({ value: null } as { value: unknown; omitted?: string }),
              decodeBody(copy.body, copy.headers, max, ropts),
            ]);
            const entry: CaptureEntry = {
              v: 1,
              ts: new Date().toISOString(),
              method: ctx.method,
              path: ctx.path,
              query: redact(st.query, ropts) as Record<string, string | string[]>,
              headers: pickHeaders(ctx.req.headers, reqNames, sensitive),
              body: reqBody.value,
              status: res.status,
              responseHeaders: pickHeaders(copy.headers, resNames, sensitive),
              response: resBody.value,
              durationMs,
              servedBy: proxied ? "proxy" : "miujs",
              route: proxied ? null : (ctx.route?.name ?? null),
            };
            if (reqBody.omitted) entry.bodyOmitted = reqBody.omitted;
            if (resBody.omitted) entry.responseOmitted = resBody.omitted;
            await writeTo(opts.sink, entry);
          } catch (err) {
            ctx.log.warn("contract capture failed", { err: err instanceof Error ? err.message : String(err) });
          }
        })(),
      );
    },
    inspect() {
      return { sample: typeof opts.sample === "function" ? "custom" : (opts.sample ?? 1), only: opts.only ?? "all", maxBodyBytes: max, redactKeys: opts.redact?.keys ?? [], headers: extra };
    },
  });
}
