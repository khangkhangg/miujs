// Canonical JSON (for hashing), field-level diffs and key-based redaction.

export const REDACTED = "[REDACTED]";

function toJsonValue(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return typeof v === "function" || typeof v === "symbol" ? undefined : v;
  if (typeof (v as { toJSON?: unknown }).toJSON === "function") return toJsonValue((v as { toJSON(): unknown }).toJSON(), seen);
  if (seen.has(v)) return "[Circular]";
  seen.add(v);
  let out: unknown;
  if (Array.isArray(v)) {
    out = v.map((x) => {
      const j = toJsonValue(x, seen);
      return j === undefined ? null : j;
    });
  } else {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const j = toJsonValue((v as Record<string, unknown>)[k], seen);
      if (j !== undefined) o[k] = j;
    }
    out = o;
  }
  seen.delete(v);
  return out;
}

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  const v = toJsonValue(value, new WeakSet());
  return v === undefined ? "null" : JSON.stringify(v);
}

/** A JSON-safe deep copy in canonical form (what a store reads back). */
export function toCanonical<T = unknown>(value: unknown): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export type Changes = Record<string, { before?: unknown; after?: unknown } | typeof REDACTED>;

function asFields(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return { value: v };
}

/** Top-level fields whose values differ (compared by canonical JSON). */
export function diff(before: unknown, after: unknown): Changes {
  const b = asFields(before);
  const a = asFields(after);
  const out: Changes = {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of keys) {
    const bv = b[k];
    const av = a[k];
    if (bv !== undefined && av !== undefined && canonicalJson(bv) === canonicalJson(av)) continue;
    if (bv === undefined && av === undefined) continue;
    const entry: { before?: unknown; after?: unknown } = {};
    if (bv !== undefined) entry.before = bv;
    if (av !== undefined) entry.after = av;
    out[k] = entry;
  }
  return out;
}

/** Splits `patientSSN`, `api-key`, `refresh_token` into lower-case words. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SECRET_WORDS = new Set([
  "password", "passwd", "pwd", "passphrase", "secret", "secrets", "token", "tokens", "apikey", "authorization",
  "cookie", "cookies", "ssn", "cvv", "cvc", "otp", "credential", "credentials", "privatekey", "pin",
]);
const SECRET_PAIRS = [["api", "key"], ["access", "key"], ["private", "key"], ["social", "security"], ["credit", "card"], ["card", "number"], ["set", "cookie"]];

// Matched inside the key with case, digits and separators removed: catches "accesstoken",
// "password2" and "pAsSwOrD", which word splitting misses. Long enough not to hit look-alikes.
const SECRET_SUBSTRINGS = ["password", "passwd", "passphrase", "apikey", "accesstoken", "refreshtoken", "authtoken", "sessiontoken", "clientsecret", "secretkey", "privatekey", "authorization"];

function isDefaultSecret(key: string): boolean {
  const squashed = key.toLowerCase().replace(/[^a-z]/g, "");
  if (SECRET_SUBSTRINGS.some((x) => squashed.includes(x))) return true;
  const w = words(key);
  if (w.some((x) => SECRET_WORDS.has(x))) return true;
  for (let i = 0; i + 1 < w.length; i++) if (SECRET_PAIRS.some(([p, q]) => w[i] === p && w[i + 1] === q)) return true;
  return false;
}

export type RedactRule = string | RegExp;
export type Redactor = (key: string) => boolean;

/** Default secret keys plus your own: strings match a key ignoring case and `_`/`-`/camelCase; regexes test the raw key. */
export function redactor(extra: RedactRule[] = []): Redactor {
  const strings = extra.filter((x): x is string => typeof x === "string").map((s) => words(s).join("_"));
  const regexes = extra.filter((x): x is RegExp => x instanceof RegExp).map((r) => new RegExp(r.source, r.flags.replace(/[gy]/g, "")));
  return (key) => {
    if (isDefaultSecret(key)) return true;
    if (strings.length) {
      const w = words(key);
      const joined = w.join("_");
      if (strings.some((s) => s === joined || (!s.includes("_") && w.includes(s)))) return true;
    }
    return regexes.some((r) => r.test(key));
  };
}

// Values that are credentials whatever key they sit under: an HTTP auth header value, or a JWT.
const AUTH_VALUE = /^\s*(bearer|basic)\s+\S{10,}\s*$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/;

/** True for strings that are themselves credentials (`Bearer …`, `Basic …`, JWTs). */
export function isSecretValue(v: string): boolean {
  return AUTH_VALUE.test(v) || JWT.test(v);
}

/** Deep copy with values under secret keys (and credential-looking strings) replaced by `[REDACTED]`. */
export function redact(value: unknown, isSecret: Redactor, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return isSecretValue(value) ? REDACTED : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) out = value.map((x) => redact(x, isSecret, seen));
  // Redact what will actually be stored: models and ORM rows serialize through toJSON.
  else if (typeof (value as { toJSON?: unknown }).toJSON === "function") out = redact((value as { toJSON(): unknown }).toJSON(), isSecret, seen);
  else {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = isSecret(k) ? REDACTED : redact(v, isSecret, seen);
    out = o;
  }
  seen.delete(value);
  return out;
}
