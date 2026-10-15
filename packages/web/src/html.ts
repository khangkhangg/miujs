import { webErrors } from "./errors.ts";

// A global symbol, so HTML made by another copy of this module (two installs, a bundled copy)
// is still recognized instead of being escaped twice.
const BRAND = Symbol.for("miujs.web.html");

/** Trusted, already-escaped HTML. Made by `html```, `raw()` and JSX; never by user input. */
export class HtmlString {
  declare readonly value: string;
  declare readonly [BRAND]: true;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}
Object.defineProperty(HtmlString.prototype, BRAND, { value: true });

export function isHtml(value: unknown): value is HtmlString {
  return typeof value === "object" && value !== null && (value as any)[BRAND] === true;
}

const ESC = /[&<>"']/g;
const HAS_ESC = /[&<>"']/;
const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML content and quoted attribute values. */
export function escapeHtml(s: string): string {
  return HAS_ESC.test(s) ? s.replace(ESC, (c) => ESC_MAP[c]) : s;
}

/**
 * Append a value to `out` as HTML: trusted HTML as-is, strings and numbers escaped, arrays
 * flattened, `null`/`undefined`/booleans skipped. Shared by `html``` and the JSX runtime.
 */
export function appendValue(out: string, v: unknown): string {
  if (v === null || v === undefined || typeof v === "boolean") return out;
  if (typeof v === "string") return out + escapeHtml(v);
  if (typeof v === "number" || typeof v === "bigint") return out + String(v);
  if (isHtml(v)) return out + v.value;
  if (Array.isArray(v)) {
    for (const x of v) out = appendValue(out, x);
    return out;
  }
  if (typeof v === "function") throw webErrors.htmlFunction();
  if (typeof (v as any).then === "function") throw webErrors.htmlAsync();
  return out + escapeHtml(String(v));
}

/**
 * Tagged template for HTML. Interpolations are escaped; nested `html``` results, JSX and `raw()`
 * are inserted as-is.
 *
 * ```ts
 * const Item = (name: string) => html`<li>${name}</li>`;
 * html`<ul>${names.map(Item)}</ul>`
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlString {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out = appendValue(out, values[i]) + strings[i + 1];
  return new HtmlString(out);
}

/** Mark a string as trusted HTML. Never pass user input. */
export function raw(value: string): HtmlString {
  if (typeof value !== "string") throw webErrors.htmlRaw(value);
  return new HtmlString(value);
}

export interface RenderOptions {
  status?: number;
  headers?: HeadersInit;
}

export const HTML_TYPE = "text/html; charset=utf-8";

/** A `text/html` Response. Plain strings are escaped; pass `html```, JSX or `raw()` for markup. */
export function render(body: HtmlString, opts: RenderOptions = {}): Response {
  const headers = new Headers(opts.headers);
  headers.set("content-type", HTML_TYPE);
  return new Response(appendValue("", body), { status: opts.status ?? 200, headers });
}
