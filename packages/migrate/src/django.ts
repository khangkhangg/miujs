// Django's signing (django.core.signing) and sessions, on WebCrypto and Compression Streams.
//
//   salted_hmac(salt, value, secret, alg) = HMAC-alg(key = alg(salt + secret), value)
//   sign(v)  = v + ":" + b64url(salted_hmac(salt + "signer", v, SECRET_KEY, "sha256"))      (no padding)
//   dumps(o) = TimestampSigner(salt).sign(["." if compressed] + b64url(zlib?(json(o))))
//               where TimestampSigner appends ":" + base62(unix time) before signing.
// The database backend stores dumps(session, salt="django.contrib.sessions.SessionStore", compress=True)
// in django_session.session_data; the cookie (`sessionid`) holds only the session_key.

import type { Context } from "miujs";
import { resolveDatabase, type DatabaseSource } from "@miujs/db";
import { base64urlDecode, base64urlEncode, digest, fromUtf8, hex, hmac, randomString, timingSafeEqualString, utf8 } from "./bytes.ts";
import { setLegacyCookie } from "./cookie.ts";
import { migrateError } from "./errors.ts";
import { checkTable } from "./laravel.ts";
import type { LegacyCookieOptions, LegacySession, LegacySessionSource } from "./types.ts";

export type DjangoAlgorithm = "sha256" | "sha1";

const HASH = { sha256: "SHA-256", sha1: "SHA-1" } as const;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_SALT = "django.contrib.sessions.SessionStore";
const SIGNED_COOKIE_SALT = "django.contrib.sessions.backends.signed_cookies";
const AUTH_HASH_SALT = "django.contrib.auth.models.AbstractBaseUser.get_session_auth_hash";

function b62Encode(n: number): string {
  if (n === 0) return "0";
  let s = "";
  while (n > 0) {
    s = B62[n % 62] + s;
    n = Math.floor(n / 62);
  }
  return s;
}

function b62Decode(s: string): number | null {
  if (!/^[0-9A-Za-z]{1,12}$/.test(s)) return null;
  let n = 0;
  for (const c of s) n = n * 62 + B62.indexOf(c);
  return n;
}

/** Django's salted_hmac(). */
export async function djangoSaltedHmac(keySalt: string, value: string, secret: string, algorithm: DjangoAlgorithm = "sha256"): Promise<Uint8Array> {
  const key = await digest(HASH[algorithm], utf8(keySalt + secret));
  return hmac(HASH[algorithm], key, utf8(value));
}

/** AbstractBaseUser.get_session_auth_hash(): what Django keeps in `_auth_user_hash`. */
export async function djangoSessionAuthHash(passwordHash: string, secretKey: string): Promise<string> {
  return hex(await djangoSaltedHmac(AUTH_HASH_SALT, passwordHash, secretKey, "sha256"));
}

const badSignature = (why: string) =>
  migrateError("SIGNATURE", 400, `Django signature check failed: ${why}`, "Check that secretKey (and secretKeyFallbacks) match the Django app's SECRET_KEY / SECRET_KEY_FALLBACKS, and that the salt matches.");

/** Python's json.dumps(separators=(",", ":")) with ensure_ascii=True. */
function pyJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxSize: number): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxSize) {
      await reader.cancel();
      return null;
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

export interface DjangoSigningOptions {
  /** SECRET_KEY, or [SECRET_KEY, ...SECRET_KEY_FALLBACKS]. The first one signs. */
  secretKey: string | string[];
  /** Default "django.core.signing". */
  salt?: string;
  /** Default "sha256" (Django ≥ 3.1). */
  algorithm?: DjangoAlgorithm;
}

/** django.core.signing.dumps(). */
export async function djangoSigningDumps(obj: unknown, opts: DjangoSigningOptions & { compress?: boolean; timestamp?: number }): Promise<string> {
  const secret = Array.isArray(opts.secretKey) ? opts.secretKey[0] : opts.secretKey;
  const salt = opts.salt ?? "django.core.signing";
  let data = utf8(pyJson(obj));
  let compressed = false;
  if (opts.compress) {
    const c = await pipe(data, new CompressionStream("deflate"), Infinity);
    if (c && c.length < data.length - 1) {
      data = c as Uint8Array<ArrayBuffer>;
      compressed = true;
    }
  }
  const value = `${compressed ? "." : ""}${base64urlEncode(data)}:${b62Encode(opts.timestamp ?? Math.floor(Date.now() / 1000))}`;
  return `${value}:${base64urlEncode(await djangoSaltedHmac(`${salt}signer`, value, secret, opts.algorithm))}`;
}

/** django.core.signing.loads(). Throws MIU_E_MIGRATE_SIGNATURE (or _EXPIRED with maxAge). */
export async function djangoSigningLoads(
  signed: string,
  opts: DjangoSigningOptions & { maxAge?: number; /** Largest decompressed size in bytes. Default 1 MiB. */ maxSize?: number },
): Promise<any> {
  const secrets = Array.isArray(opts.secretKey) ? opts.secretKey : [opts.secretKey];
  const salt = opts.salt ?? "django.core.signing";
  if (typeof signed !== "string") throw badSignature("not a string");
  const sep = signed.lastIndexOf(":");
  if (sep <= 0) throw badSignature("no signature");
  const value = signed.slice(0, sep);
  const sig = signed.slice(sep + 1);
  let ok = false;
  for (const secret of secrets) {
    const expected = base64urlEncode(await djangoSaltedHmac(`${salt}signer`, value, secret, opts.algorithm));
    if (timingSafeEqualString(expected, sig)) ok = true;
  }
  if (!ok) throw badSignature("signature does not match");
  const tsSep = value.lastIndexOf(":");
  const ts = tsSep > 0 ? b62Decode(value.slice(tsSep + 1)) : null;
  if (ts === null) throw badSignature("no timestamp");
  if (opts.maxAge !== undefined && Date.now() / 1000 - ts > opts.maxAge) {
    throw migrateError("SIGNATURE_EXPIRED", 400, `Django signature is older than ${opts.maxAge} seconds`, "Sign in again on the old app, or raise maxAge to match SESSION_COOKIE_AGE.");
  }
  let body = value.slice(0, tsSep);
  const compressed = body.startsWith(".");
  if (compressed) body = body.slice(1);
  let data = base64urlDecode(body) as Uint8Array | null;
  if (!data) throw badSignature("payload is not base64");
  if (compressed) {
    try {
      data = await pipe(data, new DecompressionStream("deflate"), opts.maxSize ?? 1024 * 1024);
    } catch {
      data = null;
    }
    if (!data) throw badSignature("payload does not decompress within the size limit");
  }
  try {
    return JSON.parse(fromUtf8(data));
  } catch {
    throw badSignature("payload is not JSON (PickleSerializer sessions are not supported)");
  }
}

// --- stores ----------------------------------------------------------------------------------

/** Signs and verifies with the session's secrets. */
export interface DjangoCodec {
  loads(value: string, salt: string, maxAge?: number): Promise<any>;
  dumps(obj: unknown, salt: string): Promise<string>;
}

export interface DjangoSessionStore {
  readonly kind: string;
  /** Session id and data for this cookie value, or null. */
  load(cookie: string, codec: DjangoCodec, ctx: Context, maxAge: number): Promise<{ id: string; data: Record<string, unknown> } | null>;
  /** Persists `data`; returns the new cookie value. */
  save(data: Record<string, unknown>, codec: DjangoCodec, ctx: Context, maxAge: number): Promise<string>;
  destroy(cookie: string, ctx: Context): Promise<void>;
  inspect?(): Record<string, unknown>;
}

/** Parses a DateTimeField value. Naive values are UTC (USE_TZ = True) unless `utcOffsetMinutes` says otherwise. */
function parseDate(v: unknown, utcOffsetMinutes: number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string") return NaN;
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/.exec(v.trim());
  if (!m) return NaN;
  const frac = m[3] ? m[3].slice(0, 4) : "";
  if (m[4]) return Date.parse(`${m[1]}T${m[2]}${frac}${m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4]}`);
  return Date.parse(`${m[1]}T${m[2]}${frac}Z`) - utcOffsetMinutes * 60_000;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ".$1000");
}

const DJANGO_KEY = /^[a-z0-9]{8,40}$/;
const KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Django's `db` (and `cached_db`) session backend: the django_session table. */
export function djangoDatabaseStore(db: DatabaseSource, opts: { table?: string; /** Minutes east of UTC for naive dates when USE_TZ = False. Default 0. */ utcOffsetMinutes?: number } = {}): DjangoSessionStore {
  const table = checkTable(opts.table ?? "django_session");
  const offset = opts.utcOffsetMinutes ?? 0;
  return {
    kind: "database",
    async load(cookie, codec, ctx) {
      if (!DJANGO_KEY.test(cookie)) return null;
      const row = await resolveDatabase(db, ctx.env).prepare(`SELECT session_data, expire_date FROM ${table} WHERE session_key = ?`).bind(cookie).first<{ session_data: string; expire_date: unknown }>();
      if (!row) return null;
      const expires = parseDate(row.expire_date, offset);
      if (!(expires > Date.now())) return null;
      const data = await codec.loads(String(row.session_data), SESSION_SALT);
      return { id: cookie, data };
    },
    async save(data, codec, ctx, maxAge) {
      const key = randomString(32, KEY_CHARS);
      const expires = formatDate(Date.now() + maxAge * 1000 + offset * 60_000);
      await resolveDatabase(db, ctx.env).prepare(`INSERT INTO ${table} (session_key, session_data, expire_date) VALUES (?, ?, ?)`).bind(key, await codec.dumps(data, SESSION_SALT), expires).run();
      return key;
    },
    async destroy(cookie, ctx) {
      if (!DJANGO_KEY.test(cookie)) return;
      await resolveDatabase(db, ctx.env).prepare(`DELETE FROM ${table} WHERE session_key = ?`).bind(cookie).run();
    },
    inspect: () => ({ store: "database", table }),
  };
}

/** Django's `signed_cookies` session backend: the data is in the cookie itself. */
export function djangoSignedCookieStore(): DjangoSessionStore {
  return {
    kind: "signed_cookies",
    async load(cookie, codec, _ctx, maxAge) {
      const data = await codec.loads(cookie, SIGNED_COOKIE_SALT, maxAge);
      return { id: cookie.slice(cookie.lastIndexOf(":") + 1), data };
    },
    async save(data, codec) {
      return codec.dumps(data, SIGNED_COOKIE_SALT);
    },
    async destroy() {},
    inspect: () => ({ store: "signed_cookies" }),
  };
}

// --- session source --------------------------------------------------------------------------

export interface DjangoSessionOptions {
  secretKey: string;
  secretKeyFallbacks?: string[];
  /** SESSION_COOKIE_NAME. Default "sessionid". */
  cookieName?: string;
  store: DjangoSessionStore;
  /** SESSION_COOKIE_AGE in seconds. Default 1209600 (two weeks). */
  maxAge?: number;
  /**
   * The user's current password hash, to check `_auth_user_hash` like Django does on every request
   * (a password change logs other sessions out). Also used by `login` when no hash is passed.
   */
  passwordHashFor?: (userId: string, ctx: Context) => Promise<string | null | undefined> | string | null | undefined;
  /** `_auth_user_backend` written on login. Default "django.contrib.auth.backends.ModelBackend". */
  backend?: string;
  algorithm?: DjangoAlgorithm;
  cookie?: LegacyCookieOptions;
}

/** The Django app's session, readable and writable from MiuJS. */
export function djangoSession(opts: DjangoSessionOptions): LegacySessionSource {
  const secrets = [opts.secretKey, ...(opts.secretKeyFallbacks ?? [])];
  if (secrets.some((s) => typeof s !== "string" || s.length < 8)) {
    throw migrateError("SECRET_KEY", 500, "The Django SECRET_KEY is missing or too short", "Pass djangoSession({ secretKey }) the exact SECRET_KEY from the Django settings (and SECRET_KEY_FALLBACKS if any).");
  }
  const cookieName = opts.cookieName ?? "sessionid";
  const maxAge = opts.maxAge ?? 1209600;
  const store = opts.store;
  const backend = opts.backend ?? "django.contrib.auth.backends.ModelBackend";
  const CACHE = `migrate:django:${Math.random().toString(36).slice(2)}`;
  const codec: DjangoCodec = {
    loads: (value, salt, age) => djangoSigningLoads(value, { secretKey: secrets, salt, maxAge: age, algorithm: opts.algorithm }),
    dumps: (obj, salt) => djangoSigningDumps(obj, { secretKey: secrets[0], salt, compress: true, algorithm: opts.algorithm }),
  };
  const cookieAttrs = (ctx: Context) => ({
    path: opts.cookie?.path ?? "/",
    domain: opts.cookie?.domain,
    secure: opts.cookie?.secure ?? ctx.url.protocol === "https:",
    sameSite: opts.cookie?.sameSite ?? "Lax",
    httpOnly: true,
  });

  async function hashMatches(given: unknown, passwordHash: string): Promise<boolean> {
    if (typeof given !== "string") return false;
    let ok = false;
    for (const s of secrets) if (timingSafeEqualString(await djangoSessionAuthHash(passwordHash, s), given)) ok = true;
    return ok;
  }

  async function load(ctx: Context): Promise<LegacySession | null> {
    const raw = ctx.cookies.get(cookieName);
    if (!raw) return null;
    let loaded: { id: string; data: Record<string, unknown> } | null;
    try {
      loaded = await store.load(raw, codec, ctx, maxAge);
    } catch {
      return null;
    }
    if (!loaded || !loaded.data || typeof loaded.data !== "object" || Array.isArray(loaded.data)) return null;
    const uid = loaded.data._auth_user_id;
    let userId = typeof uid === "string" || typeof uid === "number" ? String(uid) : null;
    if (userId !== null && opts.passwordHashFor) {
      const pw = await opts.passwordHashFor(userId, ctx);
      if (!pw || !(await hashMatches(loaded.data._auth_user_hash, pw))) userId = null;
    }
    return { kind: "django", id: loaded.id, data: loaded.data, userId };
  }

  const source: LegacySessionSource = {
    kind: "django",
    read(ctx) {
      const cached = ctx.state[CACHE] as Promise<LegacySession | null> | undefined;
      if (cached) return cached;
      const p = load(ctx);
      ctx.state[CACHE] = p;
      return p;
    },
    async login(ctx, userId, extra = {}) {
      const id = String(userId);
      const passwordHash = (extra.passwordHash as string | undefined) ?? (await opts.passwordHashFor?.(id, ctx)) ?? null;
      if (!passwordHash) {
        throw migrateError(
          "CONFIG",
          500,
          "Cannot sign in to Django without the user's password hash",
          "Django rejects sessions without _auth_user_hash. Pass login(ctx, id, { passwordHash }) or djangoSession({ passwordHashFor }).",
        );
      }
      const existing = await source.read(ctx);
      // Like django.contrib.auth.login(): keep the data for the same (or an anonymous) user, flush for another.
      const keep = existing && (existing.userId === null || existing.userId === id) ? existing.data : {};
      const data: Record<string, unknown> = {
        ...keep,
        _auth_user_id: id,
        _auth_user_backend: (extra.backend as string | undefined) ?? backend,
        _auth_user_hash: await djangoSessionAuthHash(passwordHash, secrets[0]),
      };
      const raw = ctx.cookies.get(cookieName);
      if (raw) await store.destroy(raw, ctx);
      const value = await store.save(data, codec, ctx, maxAge);
      setLegacyCookie(ctx, cookieName, value, { ...cookieAttrs(ctx), maxAge });
      const session: LegacySession = { kind: "django", id: store.kind === "database" ? value : value.slice(value.lastIndexOf(":") + 1), data, userId: id };
      ctx.state[CACHE] = Promise.resolve(session);
      return session;
    },
    async logout(ctx) {
      const raw = ctx.cookies.get(cookieName);
      if (raw) await store.destroy(raw, ctx);
      const a = cookieAttrs(ctx);
      ctx.cookies.delete(cookieName, { path: a.path, domain: a.domain });
      ctx.state[CACHE] = Promise.resolve(null);
    },
    inspect: () => ({
      kind: "django",
      cookieName,
      secretKey: "(set)",
      secretKeyFallbacks: (opts.secretKeyFallbacks ?? []).length,
      maxAge,
      checksAuthHash: !!opts.passwordHashFor,
      store: store.inspect?.() ?? { store: store.kind },
    }),
  };
  return source;
}
