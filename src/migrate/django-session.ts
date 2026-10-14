import type { Middleware } from "../core/app.ts";
import { fromBase64, fromBase64Url, timingSafeEqual, toBase64Url, utf8 } from "../batteries/auth/encoding.ts";

/**
 * Read Django sessions from a Miu app: a port of `django.core.signing`
 * (Signer, TimestampSigner, dumps/loads with JSONSerializer and zlib
 * compression) plus the session backends' encodings. Pickle-serialized
 * sessions (Django < 1.6 default) are not supported.
 */

export const DJANGO_SIGNED_COOKIE_SALT = "django.contrib.sessions.backends.signed_cookies";
/** `SessionBase.key_salt` for the db, cache, cached_db and file backends. */
export const DJANGO_SESSION_STORE_SALT = "django.contrib.sessions.SessionStore";

export type DjangoAlgorithm = "sha256" | "sha1";

export interface SignerOptions {
  /** `SECRET_KEY`. Pass an array to also accept `SECRET_KEY_FALLBACKS` (the first one signs). */
  key: string | string[];
  /** Default `"django.core.signing.Signer"` for sign/unsign, `"django.core.signing"` for dumps/loads. */
  salt?: string;
  /** `"sha256"` (Django >= 3.1, default) or `"sha1"` (older projects). */
  algorithm?: DjangoAlgorithm;
  sep?: string;
}

const HASH = { sha256: "SHA-256", sha1: "SHA-1" } as const;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `django.utils.crypto.salted_hmac`: HMAC keyed with hash(key_salt + secret). */
export async function saltedHmac(keySalt: string, value: string | Uint8Array, secret: string, algorithm: DjangoAlgorithm = "sha1"): Promise<Uint8Array> {
  const hash = HASH[algorithm];
  const derived = await crypto.subtle.digest(hash, utf8(keySalt + secret));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash }, false, ["sign"]);
  const data = typeof value === "string" ? utf8(value) : value;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>));
}

async function signature(value: string, key: string, salt: string, algorithm: DjangoAlgorithm): Promise<string> {
  return toBase64Url(await saltedHmac(salt + "signer", value, key, algorithm));
}

const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k]);

/** `Signer(key, salt=…, algorithm=…).sign(value)`. */
export async function djangoSign(value: string, opts: SignerOptions): Promise<string> {
  const sep = opts.sep ?? ":";
  const sig = await signature(value, keys(opts.key)[0]!, opts.salt ?? "django.core.signing.Signer", opts.algorithm ?? "sha256");
  return `${value}${sep}${sig}`;
}

/** `Signer.unsign`: the original value, or undefined when the signature is invalid. */
export async function djangoUnsign(signed: string, opts: SignerOptions): Promise<string | undefined> {
  const sep = opts.sep ?? ":";
  const i = signed.lastIndexOf(sep);
  if (i < 0) return undefined;
  const value = signed.slice(0, i);
  const sig = utf8(signed.slice(i + sep.length));
  let ok = false;
  for (const key of keys(opts.key)) {
    const expected = await signature(value, key, opts.salt ?? "django.core.signing.Signer", opts.algorithm ?? "sha256");
    ok = timingSafeEqual(utf8(expected), sig) || ok;
  }
  return ok ? value : undefined;
}

export interface LoadsOptions extends SignerOptions {
  /** Reject signatures older than this many seconds (TimestampSigner max_age). */
  maxAge?: number;
  /** Current time in seconds; for tests. */
  now?: number;
}

/** `django.core.signing.loads` with JSONSerializer. Returns undefined on any failure. */
export async function signingLoads<T = unknown>(s: string, opts: LoadsOptions): Promise<T | undefined> {
  const sep = opts.sep ?? ":";
  const signerOpts = { ...opts, salt: opts.salt ?? "django.core.signing" };
  const result = await djangoUnsign(s, signerOpts);
  if (result === undefined) return undefined;
  const i = result.lastIndexOf(sep);
  if (i < 0) return undefined;
  const ts = b62decode(result.slice(i + sep.length));
  if (ts === undefined) return undefined;
  if (opts.maxAge !== undefined) {
    const now = opts.now ?? Date.now() / 1000;
    if (now - ts > opts.maxAge) return undefined;
  }
  let b64 = result.slice(0, i);
  const compressed = b64.startsWith(".");
  if (compressed) b64 = b64.slice(1);
  let data = fromBase64Url(b64);
  if (!data) return undefined;
  try {
    if (compressed) data = await inflate(data);
    return JSON.parse(latin1(data)) as T;
  } catch {
    return undefined;
  }
}

export interface DumpsOptions extends SignerOptions {
  compress?: boolean;
  now?: number;
}

/** `django.core.signing.dumps` with JSONSerializer: readable by Django's `signing.loads`. */
export async function signingDumps(obj: unknown, opts: DumpsOptions): Promise<string> {
  const sep = opts.sep ?? ":";
  let data = utf8(pyJson(obj));
  let prefix = "";
  if (opts.compress) {
    const z = await deflate(data);
    if (z.length < data.length - 1) {
      data = z;
      prefix = ".";
    }
  }
  const ts = b62encode(Math.floor(opts.now ?? Date.now() / 1000));
  return djangoSign(`${prefix}${toBase64Url(data)}${sep}${ts}`, { ...opts, salt: opts.salt ?? "django.core.signing" });
}

export interface SessionDataOptions {
  secretKey: string | string[];
  /** Session backend class name, default `SessionStore`. */
  sessionClass?: string;
  algorithm?: DjangoAlgorithm;
}

/**
 * Decode the `session_data` column of `django_session` (or a cache/file
 * backend value). Handles the signed format (Django >= 3.1) and the legacy
 * `base64(hexhash:json)` format. Undefined when invalid.
 */
export async function decodeDjangoSessionData(sessionData: string, opts: SessionDataOptions): Promise<Record<string, unknown> | undefined> {
  const cls = opts.sessionClass ?? "SessionStore";
  const signed = await signingLoads<Record<string, unknown>>(sessionData, {
    key: opts.secretKey,
    salt: `django.contrib.sessions.${cls}`,
    algorithm: opts.algorithm,
  });
  if (signed && typeof signed === "object") return signed;
  // Legacy (< 3.1): base64(salted_hmac("django.contrib.sessions" + cls, json).hexdigest() + ":" + json), SHA-1.
  const raw = fromBase64(sessionData);
  if (!raw) return undefined;
  const colon = raw.indexOf(0x3a);
  if (colon < 0) return undefined;
  const hash = raw.subarray(0, colon);
  const serialized = raw.subarray(colon + 1);
  let ok = false;
  for (const key of keys(opts.secretKey)) {
    const expected = hex(await saltedHmac(`django.contrib.sessions${cls}`, serialized, key, "sha1"));
    ok = timingSafeEqual(utf8(expected), hash) || ok;
  }
  if (!ok) return undefined;
  try {
    return JSON.parse(latin1(serialized));
  } catch {
    return undefined;
  }
}

export interface DjangoSessionBridgeOptions {
  /** Django `SECRET_KEY` (array: plus `SECRET_KEY_FALLBACKS`). */
  secretKey: string | string[];
  /** `SESSION_COOKIE_NAME`, default `sessionid`. */
  cookieName?: string;
  /**
   * Load `session_data` by session key for db/cache/file backends, e.g.
   * `SELECT session_data FROM django_session WHERE session_key = ? AND expire_date > now()`.
   * Omit for the `signed_cookies` backend.
   */
  read?: (sessionKey: string) => Promise<string | undefined | null>;
  /** `SESSION_COOKIE_AGE` for signed cookies, default 1209600 (2 weeks). */
  maxAge?: number;
  algorithm?: DjangoAlgorithm;
  /** Context variable to set. Default `legacySession`. */
  variable?: string;
}

/** Middleware exposing a Django session as read-only data via `c.get("legacySession")`. */
export function djangoSessionBridge(opts: DjangoSessionBridgeOptions): Middleware {
  const name = opts.cookieName ?? "sessionid";
  const variable = opts.variable ?? "legacySession";
  return async (c, next) => {
    const value = c.cookie(name);
    if (value) {
      let data: Record<string, unknown> | undefined;
      if (opts.read) {
        if (/^[A-Za-z0-9]{1,128}$/.test(value)) {
          const raw = await opts.read(value);
          if (raw) data = await decodeDjangoSessionData(raw, opts);
        }
      } else {
        data = await signingLoads(value, {
          key: opts.secretKey,
          salt: DJANGO_SIGNED_COOKIE_SALT,
          algorithm: opts.algorithm,
          maxAge: opts.maxAge ?? 1209600,
        });
      }
      if (data && typeof data === "object") c.set(variable, Object.freeze(data));
    }
    await next();
  };
}

// ---------- helpers ----------

function b62encode(n: number): string {
  if (n === 0) return "0";
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  let s = "";
  while (n > 0) {
    s = B62[n % 62] + s;
    n = Math.floor(n / 62);
  }
  return sign + s;
}

function b62decode(s: string): number | undefined {
  if (!/^-?[0-9A-Za-z]+$/.test(s)) return undefined;
  const neg = s.startsWith("-");
  let n = 0;
  for (const ch of neg ? s.slice(1) : s) n = n * 62 + B62.indexOf(ch);
  return neg ? -n : n;
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Python's `json.dumps(obj, separators=(",", ":"))`: compact and ASCII-only. */
function pyJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const inflate = (d: Uint8Array) => pipe(d, new DecompressionStream("deflate"));
const deflate = (d: Uint8Array) => pipe(d, new CompressionStream("deflate"));
