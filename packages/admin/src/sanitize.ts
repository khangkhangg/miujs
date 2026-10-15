// A small allowlist HTML sanitizer for `field.richText()`. It tokenizes the input and rebuilds
// the markup from scratch: only allowlisted tags and attributes survive, text is re-escaped,
// tags are balanced, and elements that carry code (script, style, svg, …) are dropped with
// their content. No DOM, no regex-over-HTML replacement, so it runs on every runtime.

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li",
  "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
]);
const VOID_TAGS = new Set(["br", "hr"]);
/** Dropped together with everything up to their closing tag. */
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "noembed", "noframes", "textarea", "title",
  "template", "svg", "math", "xmp", "select", "frameset", "frame", "applet", "plaintext",
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = { a: new Set(["href", "title"]) };
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const MAX_DEPTH = 100;
const LINK_REL = "noopener noreferrer nofollow";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n",
  sol: "/", lpar: "(", rpar: ")", period: ".", comma: ",", semi: ";", excl: "!", num: "#", percnt: "%",
};

function escapeText(s: string): string {
  return s.replace(/&(?![A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9A-Fa-f]+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Decodes numeric and common named entities; unknown named entities stay as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
    }
    const named = NAMED[body.toLowerCase()];
    return named !== undefined && m.endsWith(";") ? named : m;
  });
}

/** True when `href` is http(s)/mailto/tel or a same-site relative URL. */
export function isSafeHref(raw: string): boolean {
  const decoded = decodeEntities(raw);
  // Browsers ignore control characters and whitespace inside the scheme.
  const cleaned = decoded.replace(/[\u0000- \u007f-\u009f]/g, "");
  // An entity we could not decode might hide a ":" — refuse rather than guess.
  if (/&[A-Za-z][A-Za-z0-9]*;/.test(cleaned)) return false;
  if (cleaned.startsWith("//") || cleaned.startsWith("\\\\") || cleaned.startsWith("/\\")) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(cleaned);
  if (scheme) return SAFE_SCHEMES.has(scheme[1].toLowerCase());
  // No scheme: relative. A ":" before any / ? # would be read as a scheme by some parsers.
  const firstDelim = cleaned.search(/[/?#]/);
  const colon = cleaned.indexOf(":");
  return colon === -1 || (firstDelim !== -1 && colon > firstDelim);
}

interface Attr {
  name: string;
  value: string;
}

/** Parses attributes from the inside of a start tag (after the name). */
function parseAttrs(src: string): Attr[] {
  const out: Attr[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /[\s/]/.test(src[i])) i++;
    if (i >= src.length) break;
    let name = "";
    while (i < src.length && !/[\s/>=]/.test(src[i])) name += src[i++];
    while (i < src.length && /\s/.test(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, i + 1);
        value = src.slice(i + 1, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end + 1;
      } else {
        while (i < src.length && !/\s/.test(src[i])) value += src[i++];
      }
    }
    if (name) out.push({ name: name.toLowerCase(), value });
  }
  return out;
}

/** Finds the `>` that ends a tag starting at `from`, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // Quotes only open a value right after `=` (possibly with spaces).
      let j = i - 1;
      while (j >= from && /\s/.test(html[j])) j--;
      if (html[j] === "=") quote = c;
    } else if (c === ">") return i;
  }
  return -1;
}

/**
 * Sanitizes rich text: keeps `p br hr strong b em i u s a ul ol li blockquote code pre h1–h6`,
 * only `href` (http, https, mailto, tel or relative) and `title` on links, and forces
 * `rel="noopener noreferrer nofollow"` on links. Everything else is removed; text is kept.
 */
export function sanitizeHtml(input: string): string {
  if (typeof input !== "string") return "";
  const html = input;
  let out = "";
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(html.slice(i));
      break;
    }
    out += escapeText(html.slice(i, lt));
    i = lt;
    // Comments, doctypes and processing instructions vanish.
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const closing = html[i + 1] === "/";
    const nameStart = closing ? i + 2 : i + 1;
    const m = /^[A-Za-z][A-Za-z0-9-]*/.exec(html.slice(nameStart, nameStart + 64));
    if (!m) {
      out += "&lt;";
      i++;
      continue;
    }
    const end = tagEnd(html, nameStart + m[0].length);
    if (end === -1) {
      // Never closed: it is text, not a tag.
      out += "&lt;";
      i++;
      continue;
    }
    const name = m[0].toLowerCase();
    const inner = html.slice(nameStart + m[0].length, end);
    i = end + 1;

    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      if (close === -1) {
        i = html.length;
      } else {
        const after = html.indexOf(">", close);
        i = after === -1 ? html.length : after + 1;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    const isVoid = VOID_TAGS.has(name);
    if (!isVoid && stack.length >= MAX_DEPTH) continue;
    const allowed = ALLOWED_ATTRS[name];
    let attrs = "";
    if (allowed) {
      for (const a of parseAttrs(inner)) {
        if (!allowed.has(a.name)) continue;
        if (a.name === "href" && !isSafeHref(a.value)) continue;
        attrs += ` ${a.name}="${escapeAttr(decodeEntities(a.value))}"`;
      }
    }
    if (name === "a") attrs += ` rel="${LINK_REL}"`;
    out += `<${name}${attrs}>`;
    if (!isVoid) stack.push(name);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
