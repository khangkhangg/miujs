import type { Context } from "../core/context.ts";
import { timingSafeEqual, utf8 } from "../batteries/auth/encoding.ts";

// ----- error hand-off between devErrors(), inspector() and devLogger() -----

/** Context variable where devtools stash the error that produced the current response. */
export const ERROR_KEY = "miu.devtools.error";

export function rememberError(c: Context<any, any>, err: unknown): void {
  c.set(ERROR_KEY, err);
}

/** The error behind the current response: core records it on `c.error`; devErrors() also stashes it. */
export function recalledError(c: Context<any, any>): unknown {
  return c.error ?? c.get(ERROR_KEY);
}

// ----- redaction -----

export const REDACTED = "[redacted]";
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);
const SECRET_NAME = /token|secret|passw(?:or)?d|api[-_]?key|credential|session|cookie|auth[-_]?key/i;

/** Header, query or body field names whose values must never be shown. */
export function isSecretName(name: string, extra?: RegExp): boolean {
  return SECRET_HEADERS.has(name.toLowerCase()) || SECRET_NAME.test(name) || (!!extra && extra.test(name));
}

export function redactHeaders(h: Headers, extra?: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = isSecretName(k, extra) ? REDACTED : v;
  });
  return out;
}

/** Deep-copies JSON-ish data, replacing secret-named fields. */
export function redactValue(v: unknown, extra?: RegExp, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, extra, depth + 1));
  if (typeof Blob !== "undefined" && v instanceof Blob) return `[${v.constructor.name} ${v.size} bytes]`;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = isSecretName(k, extra) ? REDACTED : redactValue(x, extra, depth + 1);
  return out;
}

/** Query string (without `?`) with secret-named parameter values replaced. */
export function redactSearch(search: string, extra?: RegExp): string {
  const s = search.startsWith("?") ? search.slice(1) : search;
  if (!s) return "";
  return s
    .split("&")
    .map((pair) => {
      const i = pair.indexOf("=");
      const raw = i < 0 ? pair : pair.slice(0, i);
      let key = raw;
      try {
        key = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        // keep raw
      }
      return isSecretName(key, extra) && i >= 0 ? `${raw}=${REDACTED}` : pair;
    })
    .join("&");
}

export function redactUrl(url: string, extra?: RegExp): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const h = url.indexOf("#", q);
  const search = url.slice(q + 1, h < 0 ? undefined : h);
  return url.slice(0, q) + "?" + redactSearch(search, extra);
}

// ----- HTML -----

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

// ----- stacks -----

export interface StackFrame {
  /** Function name, `""` for anonymous/top-level frames. */
  fn: string;
  /** File path (no `file://`), or a runtime-internal specifier like `node:internal/...`. */
  file: string;
  line: number;
  column: number;
  /** Runtime internals and `node_modules` frames. */
  internal: boolean;
}

const FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/** Parses V8 (Node, Workers) and JavaScriptCore-in-V8-format (Bun) stack traces. Positions are already source-mapped by the runtime when it supports source maps. */
export function parseStack(stack: string | undefined): StackFrame[] {
  const frames: StackFrame[] = [];
  if (!stack) return frames;
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    let file = m[2]!;
    if (file.startsWith("file://")) {
      try {
        file = decodeURIComponent(new URL(file).pathname);
      } catch {
        file = file.slice(7);
      }
    }
    frames.push({
      fn: m[1] ?? "",
      file,
      line: Number(m[3]),
      column: Number(m[4]),
      internal: /^(node:|bun:|internal[/:]|native)|\/node_modules\//.test(file) || !/[/\\]/.test(file),
    });
  }
  return frames;
}

export const frameLocation = (f: StackFrame) => `${f.file}:${f.line}:${f.column}`;

export interface ErrorInfo {
  name: string;
  message: string;
  /** `at …` lines of the stack. */
  stack: string[];
  frames: StackFrame[];
  /** `file:line:col` of the first application frame. */
  location?: string;
  cause: { name: string; message: string; stack: string[]; location?: string }[];
}

function describe(err: unknown): { name: string; message: string; stack: string[]; frames: StackFrame[]; location?: string } {
  if (err instanceof Error) {
    const frames = parseStack(err.stack);
    const app = frames.find((f) => !f.internal);
    return {
      name: err.name || err.constructor?.name || "Error",
      message: err.message,
      stack: (err.stack ?? "").split("\n").filter((l) => /^\s*at\s/.test(l)).map((l) => l.trim()),
      frames,
      location: app ? frameLocation(app) : undefined,
    };
  }
  return { name: typeof err, message: safeString(err), stack: [], frames: [] };
}

function safeString(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Name, message, parsed stack, first app location and the `cause` chain (cycle-safe, max 8 deep). */
export function errorInfo(err: unknown): ErrorInfo {
  const d = describe(err);
  const cause: ErrorInfo["cause"] = [];
  const seen = new Set<unknown>([err]);
  let cur = err instanceof Error ? err.cause : undefined;
  while (cur !== undefined && cur !== null && !seen.has(cur) && cause.length < 8) {
    seen.add(cur);
    const c = describe(cur);
    cause.push({ name: c.name, message: c.message, stack: c.stack, ...(c.location ? { location: c.location } : {}) });
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return { ...d, cause };
}

// ----- tokens -----

export function randomToken(bytes = 20): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(utf8(a), utf8(b));
}

export function nonce(): string {
  return randomToken(16);
}

// ----- bodies -----

/** Reads at most `max` bytes of a stream as text, then cancels it. Returns `truncated` when cut. */
export async function readLimited(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; size: number; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const room = max - size;
      size += value.byteLength;
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, Math.max(0, room)));
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (truncated) reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  return { text, size, truncated };
}

const TEXTUAL = /^(text\/|application\/(?:[\w.+-]*json|xml|x-www-form-urlencoded|javascript|graphql)|[^;]*\+(?:json|xml))/i;

/** Content types worth showing as text (never `text/event-stream`, which never ends). */
export function isTextual(type: string | null): boolean {
  if (!type) return false;
  return TEXTUAL.test(type) && !/event-stream/i.test(type);
}

/** Pretty, redacted representation of a textual body (JSON fields / form fields by name). */
export function redactBody(text: string, type: string | null, extra?: RegExp): unknown {
  if (type && /json/i.test(type)) {
    try {
      return redactValue(JSON.parse(text), extra);
    } catch {
      return text;
    }
  }
  if (type && /x-www-form-urlencoded/i.test(type)) return redactSearch(text, extra);
  return text;
}
