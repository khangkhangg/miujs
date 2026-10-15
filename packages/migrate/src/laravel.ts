// Laravel's encrypted cookies and sessions, on WebCrypto.
//
// Format (Illuminate\Encryption\Encrypter, Laravel 5.x–11):
//   cookie = base64(json{ iv: base64(iv), value: base64(ciphertext), mac: hex(HMAC-SHA256(key, iv_b64 . value_b64)), tag })
// with AES-256-CBC (or AES-128-CBC) and PKCS#7 padding, or AES-256-GCM (mac empty, tag set).
// EncryptCookies prefixes the plaintext with hex(HMAC-SHA1(key, cookieName . "v2")) . "|" (Laravel 8+).
// The session cookie holds the 40-character session id; the data lives in the session store.

import type { Context } from "miujs";
import { resolveDatabase, type DatabaseSource } from "@miujs/db";
import { base64Decode, base64Encode, concat, digest, fromUtf8, hex, hmac, randomAlnum, randomBytes, timingSafeEqualString, utf8 } from "./bytes.ts";
import { migrateError } from "./errors.ts";
import { phpSerialize, phpUnserialize } from "./php.ts";
import type { LegacyCookieOptions, LegacySession, LegacySessionSource } from "./types.ts";

export type LaravelCipher = "aes-256-cbc" | "aes-128-cbc" | "aes-256-gcm";

const KEY_SIZE: Record<LaravelCipher, number> = { "aes-256-cbc": 32, "aes-128-cbc": 16, "aes-256-gcm": 32 };
const IV_SIZE: Record<LaravelCipher, number> = { "aes-256-cbc": 16, "aes-128-cbc": 16, "aes-256-gcm": 12 };

/** Decodes an APP_KEY (`base64:...` or a raw string) to key bytes, checking the size for `cipher`. */
export function parseAppKey(appKey: string, cipher: LaravelCipher = "aes-256-cbc"): Uint8Array<ArrayBuffer> {
  const want = KEY_SIZE[cipher];
  const bytes = typeof appKey === "string" ? (appKey.startsWith("base64:") ? base64Decode(appKey.slice(7)) : utf8(appKey)) : null;
  if (!bytes || bytes.length !== want) {
    throw migrateError(
      "APP_KEY",
      500,
      `The Laravel APP_KEY is not a valid ${want}-byte key for ${cipher}`,
      'Copy APP_KEY exactly from the Laravel app\'s .env, including the "base64:" prefix, and set `cipher` to match config/app.php.',
    );
  }
  return bytes;
}

const failed = () =>
  migrateError(
    "DECRYPT",
    400,
    "Could not decrypt the Laravel payload: the MAC or tag is invalid, or the data is malformed",
    "Check that appKey (and previousKeys) match the Laravel app's APP_KEY / APP_PREVIOUS_KEYS and that `cipher` matches config/app.php.",
  );

export interface LaravelCryptOptions {
  cipher?: LaravelCipher;
}

/** Laravel's `encrypt($value, $serialize)`. Returns the base64 payload. */
export async function laravelEncrypt(value: string, appKey: string, opts: LaravelCryptOptions & { serialize?: boolean } = {}): Promise<string> {
  const cipher = opts.cipher ?? "aes-256-cbc";
  const key = parseAppKey(appKey, cipher);
  const plain = utf8(opts.serialize === false ? value : phpSerialize(value));
  const iv = randomBytes(IV_SIZE[cipher]);
  let valueB64: string;
  let tag = "";
  if (cipher === "aes-256-gcm") {
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, plain));
    valueB64 = base64Encode(out.subarray(0, out.length - 16));
    tag = base64Encode(out.subarray(out.length - 16));
  } else {
    const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    valueB64 = base64Encode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, plain)));
  }
  const ivB64 = base64Encode(iv);
  const mac = cipher === "aes-256-gcm" ? "" : hex(await hmac("SHA-256", key, utf8(ivB64 + valueB64)));
  return base64Encode(utf8(JSON.stringify({ iv: ivB64, value: valueB64, mac, tag })));
}

async function decryptBytes(payload: string, keys: Uint8Array<ArrayBuffer>[], cipher: LaravelCipher): Promise<Uint8Array> {
  const raw = typeof payload === "string" ? base64Decode(payload) : null;
  if (!raw) throw failed();
  let p: { iv?: unknown; value?: unknown; mac?: unknown; tag?: unknown };
  try {
    p = JSON.parse(fromUtf8(raw));
  } catch {
    throw failed();
  }
  if (!p || typeof p !== "object" || typeof p.iv !== "string" || typeof p.value !== "string") throw failed();
  const iv = base64Decode(p.iv);
  const data = base64Decode(p.value);
  if (!iv || iv.length !== IV_SIZE[cipher] || !data) throw failed();
  const gcm = cipher === "aes-256-gcm";
  // CBC must carry a MAC; never fall back to unauthenticated decryption.
  if (!gcm && (typeof p.mac !== "string" || !/^[0-9a-f]{64}$/.test(p.mac))) throw failed();
  const tag = gcm && typeof p.tag === "string" ? base64Decode(p.tag) : null;
  if (gcm && (!tag || tag.length !== 16)) throw failed();
  for (const key of keys) {
    try {
      if (gcm) {
        const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, concat(data, tag!)));
      }
      const mac = hex(await hmac("SHA-256", key, utf8(p.iv + p.value)));
      if (!timingSafeEqualString(mac, p.mac as string)) continue;
      const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, data));
    } catch {
      // Wrong key (GCM) or bad padding: try the next key.
    }
  }
  throw failed();
}

/**
 * Laravel's `decrypt($payload, $unserialize)`. `appKey` may be a list (current key first, then
 * APP_PREVIOUS_KEYS). With `unserialize` (default) the plaintext is read with the safe PHP
 * unserializer, which refuses class objects.
 */
export async function laravelDecrypt(
  payload: string,
  appKey: string | string[],
  opts: LaravelCryptOptions & { unserialize?: boolean; phpClasses?: "refuse" | "inert" } = {},
): Promise<any> {
  const cipher = opts.cipher ?? "aes-256-cbc";
  const keys = (Array.isArray(appKey) ? appKey : [appKey]).map((k) => parseAppKey(k, cipher));
  const plain = await decryptBytes(payload, keys, cipher);
  if (opts.unserialize === false) return fromUtf8(plain);
  return phpUnserialize(plain, { classes: opts.phpClasses });
}

async function cookiePrefix(name: string, key: Uint8Array): Promise<string> {
  return `${hex(await hmac("SHA-1", key, utf8(`${name}v2`)))}|`;
}

export interface LaravelCookieOptions extends LaravelCryptOptions {
  /** HMAC name prefix inside the value (Laravel 8+). Default true; false for older apps. */
  prefix?: boolean;
}

/** The value Laravel's EncryptCookies middleware would put in cookie `name`. */
export async function laravelCookieEncode(name: string, value: string, appKey: string, opts: LaravelCookieOptions = {}): Promise<string> {
  const prefix = opts.prefix === false ? "" : await cookiePrefix(name, parseAppKey(appKey, opts.cipher));
  return laravelEncrypt(prefix + value, appKey, { cipher: opts.cipher, serialize: false });
}

/** Opens a Laravel-encrypted cookie. Null when it does not decrypt or was made for another cookie name. */
export async function laravelCookieDecode(name: string, cookie: string, appKey: string | string[], opts: LaravelCookieOptions = {}): Promise<string | null> {
  const list = Array.isArray(appKey) ? appKey : [appKey];
  let plain: string;
  try {
    plain = await laravelDecrypt(cookie, list, { cipher: opts.cipher, unserialize: false });
  } catch {
    return null;
  }
  if (opts.prefix === false) return plain;
  for (const k of list) {
    const prefix = await cookiePrefix(name, parseAppKey(k, opts.cipher));
    if (plain.startsWith(prefix)) return plain.slice(prefix.length);
  }
  return null;
}

/** `login_{guard}_` . sha1('Illuminate\Auth\SessionGuard'): where Laravel's session guard keeps the user id. */
export async function laravelLoginKey(guard = "web", guardClass = "Illuminate\\Auth\\SessionGuard"): Promise<string> {
  return `login_${guard}_${hex(await digest("SHA-1", utf8(guardClass)))}`;
}

// --- stores ----------------------------------------------------------------------------------

export interface LaravelStoreWriteInfo {
  userId: string | number | null;
  ip: string | null;
  userAgent: string | null;
  lifetimeSeconds: number;
}

/** Where the old app keeps session data. Payloads are the raw strings Laravel's handler reads/writes. */
export interface LaravelSessionStore {
  readonly kind: string;
  /** The stored payload, or null when missing or older than `lifetimeSeconds`. */
  read(id: string, opts: { lifetimeSeconds: number }, ctx: Context): Promise<Uint8Array | string | null>;
  write(id: string, payload: string, info: LaravelStoreWriteInfo, ctx: Context): Promise<void>;
  destroy(id: string, ctx: Context): Promise<void>;
  inspect?(): Record<string, unknown>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export function checkTable(table: string): string {
  if (!IDENT.test(table)) {
    throw migrateError("CONFIG", 500, `"${table.slice(0, 60)}" is not a valid table name`, "Pass a plain table name such as \"sessions\" (letters, digits, underscores, optional schema prefix).");
  }
  return table;
}

/** Laravel's `database` session driver (DatabaseSessionHandler): one row per session in `table`. */
export function laravelDatabaseStore(db: DatabaseSource, opts: { table?: string } = {}): LaravelSessionStore {
  const table = checkTable(opts.table ?? "sessions");
  const now = () => Math.floor(Date.now() / 1000);
  return {
    kind: "database",
    async read(id, { lifetimeSeconds }, ctx) {
      const row = await resolveDatabase(db, ctx.env).prepare(`SELECT payload, last_activity FROM ${table} WHERE id = ?`).bind(id).first<{ payload: string; last_activity: number }>();
      if (!row || typeof row.payload !== "string") return null;
      if (Number(row.last_activity) < now() - lifetimeSeconds) return null;
      return base64Decode(row.payload);
    },
    async write(id, payload, info, ctx) {
      const d = resolveDatabase(db, ctx.env);
      const userId = info.userId === null ? null : /^\d+$/.test(String(info.userId)) ? Number(info.userId) : info.userId;
      const values = [userId, info.ip, info.userAgent, base64Encode(utf8(payload)), now()];
      const r = await d.prepare(`UPDATE ${table} SET user_id = ?, ip_address = ?, user_agent = ?, payload = ?, last_activity = ? WHERE id = ?`).bind(...values, id).run();
      if (!r.meta.changes) {
        await d.prepare(`INSERT INTO ${table} (user_id, ip_address, user_agent, payload, last_activity, id) VALUES (?, ?, ?, ?, ?, ?)`).bind(...values, id).run();
      }
    },
    async destroy(id, ctx) {
      await resolveDatabase(db, ctx.env).prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    },
    inspect: () => ({ store: "database", table }),
  };
}

// --- session source --------------------------------------------------------------------------

export interface LaravelSessionOptions {
  /** APP_KEY of the Laravel app ("base64:..."). */
  appKey: string;
  /** APP_PREVIOUS_KEYS, still accepted for reading. */
  previousKeys?: string[];
  cipher?: LaravelCipher;
  /** Default "laravel_session" (config/session.php `cookie`). */
  cookieName?: string;
  store: LaravelSessionStore;
  /** Minutes (config/session.php `lifetime`). Default 120. */
  lifetime?: number;
  /** config/session.php `serialization`. Default "php". */
  serialization?: "php" | "json";
  /** config/session.php `encrypt`. Default false. */
  encrypt?: boolean;
  /** Auth guard whose login key holds the user id. Default "web". */
  guard?: string;
  /** Cookie name prefix check (Laravel 8+). Default true. */
  cookiePrefix?: boolean;
  /** Class objects in the payload: "refuse" (default, the session reads as absent) or "inert". */
  phpClasses?: "refuse" | "inert";
  cookie?: LegacyCookieOptions;
}

const LARAVEL_ID = /^[A-Za-z0-9]{40}$/;

/** The Laravel app's session, readable and writable from MiuJS. */
export function laravelSession(opts: LaravelSessionOptions): LegacySessionSource {
  const cipher = opts.cipher ?? "aes-256-cbc";
  // Validate keys up front so a bad APP_KEY fails at startup, not on the first request.
  parseAppKey(opts.appKey, cipher);
  for (const k of opts.previousKeys ?? []) parseAppKey(k, cipher);
  const keys = [opts.appKey, ...(opts.previousKeys ?? [])];
  const cookieName = opts.cookieName ?? "laravel_session";
  const lifetimeSeconds = (opts.lifetime ?? 120) * 60;
  const serialization = opts.serialization ?? "php";
  const store = opts.store;
  const prefix = opts.cookiePrefix ?? true;
  let loginKey: Promise<string> | undefined;
  const getLoginKey = () => (loginKey ??= laravelLoginKey(opts.guard ?? "web"));
  const CACHE = `migrate:laravel:${Math.random().toString(36).slice(2)}`;

  const decode = async (raw: Uint8Array | string): Promise<Record<string, unknown> | null> => {
    let bytes: Uint8Array | string = raw;
    if (opts.encrypt) bytes = await laravelDecrypt(typeof raw === "string" ? raw : fromUtf8(raw), keys, { cipher });
    const value = serialization === "json" ? JSON.parse(typeof bytes === "string" ? bytes : fromUtf8(bytes)) : phpUnserialize(bytes, { classes: opts.phpClasses });
    if (Array.isArray(value) && value.length === 0) return {};
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  };
  const encode = async (data: Record<string, unknown>): Promise<string> => {
    const s = serialization === "json" ? JSON.stringify(data) : phpSerialize(data);
    return opts.encrypt ? laravelEncrypt(s, opts.appKey, { cipher }) : s;
  };
  const cookieAttrs = (ctx: Context) => ({
    path: opts.cookie?.path ?? "/",
    domain: opts.cookie?.domain,
    secure: opts.cookie?.secure ?? ctx.url.protocol === "https:",
    sameSite: opts.cookie?.sameSite ?? "Lax",
    httpOnly: true,
  });

  async function load(ctx: Context): Promise<LegacySession | null> {
    const raw = ctx.cookies.get(cookieName);
    if (!raw) return null;
    const id = await laravelCookieDecode(cookieName, raw, keys, { cipher, prefix });
    if (id === null || !LARAVEL_ID.test(id)) return null;
    const payload = await store.read(id, { lifetimeSeconds }, ctx);
    if (payload === null || payload === undefined) return null;
    let data: Record<string, unknown> | null;
    try {
      data = await decode(payload);
    } catch (err) {
      ctx.log.warn("could not read the Laravel session payload", { code: (err as { code?: string }).code });
      return null;
    }
    if (!data) return null;
    const uid = data[await getLoginKey()];
    return { kind: "laravel", id, data, userId: typeof uid === "string" || typeof uid === "number" ? String(uid) : null };
  }

  const source: LegacySessionSource = {
    kind: "laravel",
    read(ctx) {
      const cached = ctx.state[CACHE] as Promise<LegacySession | null> | undefined;
      if (cached) return cached;
      const p = load(ctx);
      ctx.state[CACHE] = p;
      return p;
    },
    async login(ctx, userId) {
      const existing = await source.read(ctx);
      const data: Record<string, unknown> = existing ? { ...existing.data } : { _flash: { old: [], new: [] } };
      if (typeof data._token !== "string") data._token = randomAlnum(40);
      data[await getLoginKey()] = userId;
      // Like Laravel's session()->migrate(true) on login: new id, old row gone (no fixation).
      if (existing) await store.destroy(existing.id, ctx);
      const id = randomAlnum(40);
      await store.write(id, await encode(data), { userId, ip: ctx.ip ?? null, userAgent: ctx.headers.get("user-agent")?.slice(0, 500) ?? null, lifetimeSeconds }, ctx);
      const value = await laravelCookieEncode(cookieName, id, opts.appKey, { cipher, prefix });
      ctx.cookies.set(cookieName, value, { ...cookieAttrs(ctx), maxAge: lifetimeSeconds });
      const session: LegacySession = { kind: "laravel", id, data, userId: String(userId) };
      ctx.state[CACHE] = Promise.resolve(session);
      return session;
    },
    async logout(ctx) {
      const existing = await source.read(ctx);
      if (existing) await store.destroy(existing.id, ctx);
      const a = cookieAttrs(ctx);
      ctx.cookies.delete(cookieName, { path: a.path, domain: a.domain });
      ctx.state[CACHE] = Promise.resolve(null);
    },
    inspect: () => ({
      kind: "laravel",
      cookieName,
      cipher,
      appKey: "(set)",
      previousKeys: (opts.previousKeys ?? []).length,
      lifetimeMinutes: lifetimeSeconds / 60,
      serialization,
      encrypt: !!opts.encrypt,
      guard: opts.guard ?? "web",
      store: store.inspect?.() ?? { store: store.kind },
    }),
  };
  return source;
}
