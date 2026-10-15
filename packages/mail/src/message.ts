// Address/header validation and HTML helpers. Everything a transport receives has passed these.

import { errors } from "miujs";

const BARE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NAMED = /^([^<>"\r\n]{0,200}|"[^"\r\n]{0,200}")\s*<([^<>\s]+)>$/;
const CRLF = /[\r\n]/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
/** Headers that name senders or recipients. Setting them via `headers` would bypass validation. */
const RESERVED = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "sender", "return-path", "content-type", "content-transfer-encoding", "mime-version"]);

const invalidAddress = (field: string, value: unknown) =>
  errors.custom({
    code: "MIU_E_MAIL_ADDRESS_INVALID",
    status: 400,
    message: `Invalid email address in ${field}: ${JSON.stringify(String(value).slice(0, 100))}`,
    fix: 'Use a single address like "ann@example.com" or "Ann <ann@example.com>" per entry; pass several recipients as an array.',
  });

const invalidHeader = (message: string) =>
  errors.custom({
    code: "MIU_E_MAIL_HEADER_INVALID",
    status: 400,
    message,
    fix: "Remove line breaks (CR/LF) from the subject and headers. Set recipients with `to`/`replyTo`, not `headers`. Header names use letters, digits and dashes.",
  });

/** Validates one address (`a@b.co` or `Name <a@b.co>`). Returns it trimmed. */
export function checkAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 320 || CRLF.test(value)) throw invalidAddress(field, value);
  const v = value.trim();
  if (BARE.test(v)) return v;
  const m = NAMED.exec(v);
  if (m && BARE.test(m[2])) return v;
  throw invalidAddress(field, value);
}

export function checkSubject(subject: string): string {
  if (CRLF.test(subject)) throw invalidHeader("The subject contains a line break (possible header injection)");
  if (subject.length > 998) throw invalidHeader("The subject is longer than 998 characters");
  return subject;
}

export function checkHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw invalidHeader(`Invalid header name ${JSON.stringify(name.slice(0, 100))}`);
    if (RESERVED.has(name.toLowerCase())) throw invalidHeader(`The ${name} header cannot be set through \`headers\``);
    if (typeof value !== "string" || CRLF.test(value)) throw invalidHeader(`The ${name} header value contains a line break (possible header injection)`);
    out[name] = value;
  }
  return out;
}

/** Escapes `& < > " '` for HTML text and attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e: string) => {
    const lower = e.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower];
    if (lower.startsWith("#x")) return safeChar(parseInt(lower.slice(2), 16), all);
    if (lower.startsWith("#")) return safeChar(parseInt(lower.slice(1), 10), all);
    return all;
  });
}

function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Plain-text version of an HTML email: tags stripped, links kept as `label (url)`. */
export function htmlToText(html: string): string {
  let s = html.replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_all, d: string | undefined, q: string | undefined, label: string) => {
    const href = decode(d ?? q ?? "");
    const text = label.replace(/<[^>]*>/g, "").trim();
    return text && decode(text) !== href ? `${text} (${href})` : href;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, "\n\n");
  s = s.replace(/<li\b[^>]*>/gi, "- ");
  s = s.replace(/<[^>]*>/g, "");
  s = decode(s);
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
