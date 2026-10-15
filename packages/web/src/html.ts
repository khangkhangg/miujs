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
  const slots = slotsOf(strings);
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const slot = slots[i];
    if (slot === TEXT) {
      out = appendValue(out, values[i]) + strings[i + 1];
      continue;
    }
    // Inside a tag: URL attributes lose script schemes, and an unquoted value is quoted so it
    // cannot end the attribute and add new ones (`class=${"x onclick=..."}`).
    let v = values[i];
    if (slot & URL_SLOT && typeof v === "string") v = safeUrl(v);
    out = slot & UNQUOTED ? appendValue(out + '"', v) + '"' + strings[i + 1] : appendValue(out, v) + strings[i + 1];
  }
  return new HtmlString(out);
}

/** Attributes whose value the browser loads or navigates to. */
export const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "cite", "background", "data", "codebase", "ping", "srcdoc"]);
const UNSAFE_SCHEME = /^(?:javascript|vbscript|data(?!:image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon);))/i;
/** What a script URL becomes: inert, and easy to spot in the output. */
export const UNSAFE_URL = "about:invalid#miu-unsafe-url";

/**
 * `url` unless it would run script (`javascript:`, `vbscript:`, `data:` other than images).
 * Browsers ignore ASCII whitespace and control characters around and inside a scheme, so they are
 * dropped before the check. `srcdoc` is HTML, so every value there is treated as a URL to check.
 */
export function safeUrl(url: string): string {
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const scheme = url.slice(0, colon + 1).replace(/[\u0000-\u0020\u007f]/g, "");
  if (scheme.includes("/") || scheme.includes("?") || scheme.includes("#")) return url; // a relative path
  return UNSAFE_SCHEME.test(scheme + url.slice(colon + 1, colon + 40)) ? UNSAFE_URL : url;
}

const TEXT = 0;
const IN_TAG = 1;
const UNQUOTED = 2;
const URL_SLOT = 4;
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const slotCache = new WeakMap<TemplateStringsArray, Uint8Array>();

/**
 * Where each interpolation of a template sits: in text, or inside a tag (quoted or not, URL
 * attribute or not). Scans the template's literal parts once per call site; values are escaped,
 * so they cannot change the state.
 */
function slotsOf(strings: TemplateStringsArray): Uint8Array {
  let slots = slotCache.get(strings);
  if (slots) return slots;
  slots = new Uint8Array(Math.max(0, strings.length - 1));
  let inTag = false;
  let quote = "";
  let tagName = "";
  let naming = false;
  let rawText = ""; // inside <script>, <style>, ...: only its end tag counts
  let comment = false;
  for (let i = 0; i < strings.length - 1; i++) {
    const s = strings[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (comment) {
        if (c === ">" && s.slice(Math.max(0, j - 2), j) === "--") comment = false;
      } else if (rawText) {
        if (c === "<" && s.slice(j + 1, j + 2 + rawText.length).toLowerCase() === "/" + rawText) rawText = "";
      } else if (!inTag) {
        if (c === "<" && s.startsWith("!--", j + 1)) {
          comment = true;
          j += 3;
        } else if (c === "<" && /[A-Za-z]/.test(s[j + 1] ?? "")) {
          inTag = true;
          naming = true;
          tagName = "";
        }
      } else if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
        naming = false;
      } else if (c === ">") {
        inTag = false;
        naming = false;
        if (RAW_TEXT.has(tagName.toLowerCase())) rawText = tagName.toLowerCase();
      } else if (naming) {
        if (/[\s/]/.test(c)) naming = false;
        else tagName += c;
      }
    }
    if (!inTag || comment || rawText) continue;
    const m = /([^\s"'<>\/=]+)\s*=\s*(["']?)$/.exec(s);
    let slot = IN_TAG;
    // The value starts right here (`name=` or `name="`), not in the middle of another value.
    if (m && (quote ? m[2] === quote : m[2] === "")) {
      if (!quote) slot |= UNQUOTED;
      // Only the start of a value can set its scheme, so only that interpolation is checked.
      if (URL_ATTRS.has(m[1].toLowerCase())) slot |= URL_SLOT;
    }
    slots[i] = slot;
  }
  slotCache.set(strings, slots);
  return slots;
}

/** Mark a string as trusted HTML. Never pass user input. */
export function raw(value: string): HtmlString {
  if (typeof value !== "string") throw webErrors.htmlRaw(value);
  return new HtmlString(value);
}

export interface RenderOptions {
  status?: number;
  headers?: Headers | Record<string, string> | [string, string][];
  /**
   * Prepend `<!doctype html>`. Default: only when the content starts with `<html` (a full
   * document) and has no doctype yet. `false` never adds one; `true` always does (unless present).
   */
  doctype?: boolean;
}

export const HTML_TYPE = "text/html; charset=utf-8";

/** A `text/html` Response. Plain strings are escaped; pass `html```, JSX or `raw()` for markup. */
export function render(body: HtmlString, opts: RenderOptions = {}): Response {
  const headers = new Headers(opts.headers);
  headers.set("content-type", HTML_TYPE);
  let text = appendValue("", body);
  const head = text.trimStart();
  const hasDoctype = /^<!doctype\s/i.test(head);
  const wantDoctype = opts.doctype ?? /^<html[\s>]/i.test(head);
  if (wantDoctype && !hasDoctype) text = "<!doctype html>" + text;
  return new Response(text, { status: opts.status ?? 200, headers });
}
