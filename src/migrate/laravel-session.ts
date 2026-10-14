import type { Middleware } from "../core/app.ts";
import { decodePhpSession, unserializePhp } from "./php-session.ts";

/**
 * Read Laravel's encrypted cookies and sessions with the app's `APP_KEY`, so a Miu app can share
 * logins with a Laravel app during a migration. Mirrors `Illuminate\Encryption\Encrypter` (Laravel
 * 5.x–11.x payload format: `base64(json{iv, value, mac, tag})`) and `CookieValuePrefix` (6.18.31+/7.22+).
 * WebCrypto only: runs on Bun, Node and Workers.
 */

export type LaravelCipher = "aes-128-cbc" | "aes-256-cbc" | "aes-128-gcm" | "aes-256-gcm";

export interface LaravelCryptOptions {
  /** `APP_KEY` (`base64:…` or raw); an array adds `APP_PREVIOUS_KEYS`, tried in order. */
  appKey: string | string[];
  /** `config('app.cipher')`. Default `aes-256-cbc` (Laravel's default). Never taken from the payload. */
  cipher?: LaravelCipher;
}

const CIPHERS: Record<LaravelCipher, { size: number; aead: boolean; ivLength: number }> = {
  "aes-128-cbc": { size: 16, aead: false, ivLength: 16 },
  "aes-256-cbc": { size: 32, aead: false, ivLength: 16 },
  "aes-128-gcm": { size: 16, aead: true, ivLength: 12 },
  "aes-256-gcm": { size: 32, aead: true, ivLength: 12 },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Decode `APP_KEY`: `base64:<key>` or the raw key string. */
export function parseAppKey(appKey: string): Uint8Array<ArrayBuffer> {
  if (appKey.startsWith("base64:")) {
    const bytes = b64decode(appKey.slice(7));
    if (!bytes) throw new TypeError("Malformed APP_KEY: invalid base64 after `base64:`");
    return bytes;
  }
  return enc.encode(appKey);
}

/**
 * Decrypt a Laravel `encrypt()` / `encryptString()` payload and return the plaintext string
 * (still PHP-serialized if it was made with `encrypt()`). Undefined when it is invalid, tampered
 * with, or not made with these keys. Throws only on misconfiguration (unknown cipher, wrong key size).
 */
export async function laravelDecrypt(payload: string, opts: LaravelCryptOptions): Promise<string | undefined> {
  const { spec, keys } = resolve(opts);
  const raw = b64decode(payload);
  if (!raw) return undefined;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(dec.decode(raw));
  } catch {
    return undefined;
  }
  // Laravel's validPayload(): iv, value and mac are strings; tag (if present) is a string.
  if (!p || typeof p !== "object" || typeof p.iv !== "string" || typeof p.value !== "string" || typeof p.mac !== "string") return undefined;
  if (p.tag !== undefined && p.tag !== null && typeof p.tag !== "string") return undefined;
  const iv = b64decode(p.iv);
  if (!iv || iv.length !== spec.ivLength) return undefined;
  const ciphertext = b64decode(p.value);
  if (!ciphertext) return undefined;
  const tagB64 = typeof p.tag === "string" ? p.tag : "";

  if (spec.aead) {
    const tag = b64decode(tagB64);
    if (!tag || tag.length !== 16) return undefined;
    const data = concat(ciphertext, tag);
    for (const key of keys) {
      try {
        const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
        return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, k, data));
      } catch {
        // try the next key
      }
    }
    return undefined;
  }

  // CBC: a tag means someone is feeding us an AEAD payload; Laravel refuses it, so do we.
  if (tagB64 !== "") return undefined;
  if (!/^[0-9a-f]{64}$/.test(p.mac)) return undefined;
  const macInput = enc.encode(p.iv + p.value);
  for (const key of keys) {
    const hk = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    // Constant-time comparison via WebCrypto verify.
    if (!(await crypto.subtle.verify("HMAC", hk, hexToBytes(p.mac), macInput))) continue;
    try {
      const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
      return dec.decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, ciphertext));
    } catch {
      // bad padding with this key: try the next one (as Laravel does)
    }
  }
  return undefined;
}

/**
 * Encrypt a string the way Laravel's `encryptString()` does (so `decryptString()` reads it).
 * Uses the first key. Useful for writing cookies Laravel will accept, and for tests.
 */
export async function laravelEncrypt(value: string, opts: LaravelCryptOptions): Promise<string> {
  const { spec, keys } = resolve(opts);
  const key = keys[0]!;
  const iv = crypto.getRandomValues(new Uint8Array(spec.ivLength));
  const plain = enc.encode(value);
  let valueB64: string;
  let tagB64 = "";
  let mac = "";
  if (spec.aead) {
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, k, plain));
    valueB64 = b64encode(out.subarray(0, out.length - 16));
    tagB64 = b64encode(out.subarray(out.length - 16));
  } else {
    const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    valueB64 = b64encode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, plain)));
    const hk = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    mac = hex(new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode(b64encode(iv) + valueB64))));
  }
  // Same member order and slash escaping (JSON_UNESCAPED_SLASHES) as PHP's json_encode(compact(...)).
  const json = JSON.stringify({ iv: b64encode(iv), value: valueB64, mac, tag: tagB64 });
  return b64encode(enc.encode(json));
}

/** `CookieValuePrefix::create()`: `hmac_sha1(cookieName . "v2", key) . "|"`. */
export async function laravelCookiePrefix(cookieName: string, key: Uint8Array<ArrayBuffer>): Promise<string> {
  const hk = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode(cookieName + "v2")))) + "|";
}

/**
 * Decrypt a cookie set through Laravel's `EncryptCookies` middleware and check its name-bound prefix
 * (so an encrypted value from another cookie can't be swapped in). Returns the plain cookie value.
 */
export async function decryptLaravelCookie(value: string, cookieName: string, opts: LaravelCryptOptions): Promise<string | undefined> {
  const plain = await laravelDecrypt(value, opts);
  if (plain === undefined) return undefined;
  for (const key of resolve(opts).keys) {
    const prefix = await laravelCookiePrefix(cookieName, key);
    if (plain.startsWith(prefix)) return plain.slice(prefix.length);
  }
  return undefined;
}

export interface LaravelSessionDataOptions extends Partial<LaravelCryptOptions> {
  /** `config('session.encrypt')`: payloads in the session store are encrypted. Needs `appKey`. */
  encrypted?: boolean;
  /** `config('session.serialization')` (Laravel 10.13+): `php` (default) or `json`. */
  serialization?: "php" | "json";
}

/**
 * Turn the raw payload stored by Laravel's session handler (file, database `payload` column, Redis,
 * cache…) into the PHP-serialized attributes string, decrypting it when `session.encrypt` is on.
 * Feed the result to `decodePhpSession()`; or use `decodeLaravelSession()` which does both.
 */
export async function laravelSessionPayload(data: string, opts: LaravelSessionDataOptions = {}): Promise<string | undefined> {
  if (!opts.encrypted) return data;
  if (!opts.appKey) throw new TypeError("laravelSessionPayload: `appKey` is required when `encrypted` is true");
  const plain = await laravelDecrypt(data, { appKey: opts.appKey, cipher: opts.cipher });
  if (plain === undefined) return undefined;
  // EncryptedStore uses encrypt($data) with serialize=true, so the payload is serialize(<string>).
  if (/^s:\d+:"/.test(plain)) {
    try {
      const inner = unserializePhp(plain);
      if (typeof inner === "string") return inner;
    } catch {
      return undefined;
    }
  }
  return plain;
}

/** Decode a Laravel session payload to its attributes; undefined when invalid. */
export async function decodeLaravelSession(data: string, opts: LaravelSessionDataOptions = {}): Promise<Record<string, unknown> | undefined> {
  const payload = await laravelSessionPayload(data, opts);
  if (!payload) return undefined;
  try {
    if (opts.serialization === "json") {
      const v = JSON.parse(payload);
      return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
    }
    if (!/^a:\d+:\{/.test(payload)) return undefined;
    return decodePhpSession(payload, "php_serialize");
  } catch {
    return undefined;
  }
}

export interface LaravelSessionBridgeOptions extends LaravelCryptOptions {
  /** `config('session.cookie')`. Default `laravel_session`. */
  cookieName?: string;
  /**
   * Load the raw session payload by id: `storage/framework/sessions/<id>` (file driver),
   * `SELECT payload FROM sessions WHERE id = ?` (database; base64-decode it first),
   * or `GET <prefix><id>` (redis/cache driver).
   */
  read: (id: string) => Promise<string | undefined | null>;
  /** `config('session.encrypt')`. Default false. */
  encrypted?: boolean;
  serialization?: "php" | "json";
  /** Context variable to set. Default `legacySession`. */
  variable?: string;
}

/**
 * Middleware exposing a Laravel session as read-only data via `c.get("legacySession")`:
 * decrypts the session cookie with `APP_KEY`, checks its prefix, loads the payload with `read`,
 * and decodes it. Undefined when there is no valid cookie or session.
 */
export function laravelSessionBridge(opts: LaravelSessionBridgeOptions): Middleware {
  const name = opts.cookieName ?? "laravel_session";
  const variable = opts.variable ?? "legacySession";
  resolve(opts); // fail fast on misconfiguration
  return async (c, next) => {
    const cookie = c.cookie(name);
    if (cookie) {
      const id = await decryptLaravelCookie(cookie, name, opts);
      // Laravel session ids are Str::random(40): validate before the id reaches `read`.
      if (id && /^[A-Za-z0-9]{40}$/.test(id)) {
        const raw = await opts.read(id);
        if (raw) {
          const data = await decodeLaravelSession(raw, opts);
          if (data) c.set(variable, Object.freeze(data));
        }
      }
    }
    await next();
  };
}

// ---------- helpers ----------

const keyCache = new Map<string, Uint8Array<ArrayBuffer>[]>();

function resolve(opts: LaravelCryptOptions) {
  const cipher = (opts.cipher ?? "aes-256-cbc").toLowerCase() as LaravelCipher;
  const spec = CIPHERS[cipher];
  if (!spec) throw new TypeError(`Unsupported Laravel cipher ${JSON.stringify(opts.cipher)}; expected ${Object.keys(CIPHERS).join(", ")}`);
  const list = Array.isArray(opts.appKey) ? opts.appKey : [opts.appKey];
  if (list.length === 0) throw new TypeError("appKey is required");
  const cacheKey = `${cipher}\0${list.join("\0")}`;
  let keys = keyCache.get(cacheKey);
  if (!keys) {
    keys = list.map((k) => {
      const bytes = parseAppKey(k);
      if (bytes.length !== spec.size) throw new TypeError(`${cipher} needs a ${spec.size}-byte APP_KEY, got ${bytes.length} bytes`);
      return bytes;
    });
    if (keyCache.size > 32) keyCache.clear();
    keyCache.set(cacheKey, keys);
  }
  return { cipher, spec, keys };
}

function b64decode(s: string): Uint8Array<ArrayBuffer> | undefined {
  // Strict standard base64 (PHP's base64_encode output); tolerate missing padding.
  const clean = s.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return undefined;
  try {
    const bin = atob(clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

function b64encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
