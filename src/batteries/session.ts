import type { Middleware } from "../core/app.ts";
import type { Context, CookieOptions } from "../core/context.ts";
import type { Store } from "./store/types.ts";
import { fromBase64Url, hmacKey, randomBytes, toBase64Url, utf8 } from "./auth/encoding.ts";

export interface SessionOptions {
  store: Store;
  /** At least 32 characters. Pass an array to rotate keys: the first signs, any verifies. */
  secret: string | string[];
  cookieName?: string;
  /** Lifetime in seconds (store TTL and cookie Max-Age). Default 14 days. */
  ttl?: number;
  cookie?: { secure?: boolean; sameSite?: "Strict" | "Lax" | "None"; path?: string; domain?: string };
  /** Re-save and re-issue the cookie on every request, extending the expiry. */
  rolling?: boolean;
}

type Data = Record<string, unknown>;
interface StoredSession {
  data: Data;
  flash?: Data;
}

/** Server-side session. Data loads lazily on first access and is saved only when changed. */
export class Session {
  #store: Store;
  #id: string;
  #isNew: boolean;
  #data?: Data;
  #flashIn: Data = {};
  #flashOut: Data = {};
  #loading?: Promise<void>;
  #dirty = false;
  #destroyed = false;
  #stale: string[] = [];

  constructor(store: Store, id: string | undefined) {
    this.#store = store;
    this.#isNew = !id;
    this.#id = id ?? newId();
    if (this.#isNew) this.#data = {};
  }

  get id(): string {
    return this.#id;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return (await this.#load())[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    (await this.#load())[key] = value;
    this.#dirty = true;
  }

  async delete(key: string): Promise<void> {
    const data = await this.#load();
    if (key in data) {
      delete data[key];
      this.#dirty = true;
    }
  }

  async all(): Promise<Data> {
    return { ...(await this.#load()) };
  }

  /** `flash(key, value)` stores a value for the next request; `flash(key)` reads and removes it. */
  flash<T = unknown>(key: string): Promise<T | undefined>;
  flash(key: string, value: unknown): Promise<void>;
  async flash(key: string, ...value: unknown[]): Promise<unknown> {
    await this.#load();
    if (value.length) {
      this.#flashOut[key] = value[0];
      this.#dirty = true;
      return;
    }
    const v = this.#flashIn[key];
    delete this.#flashIn[key];
    return v;
  }

  /** Issue a new id, keeping the data. Call on login to prevent session fixation. */
  async regenerate(): Promise<void> {
    await this.#load();
    if (!this.#isNew) this.#stale.push(this.#id);
    this.#id = newId();
    this.#isNew = true;
    this.#destroyed = false;
    this.#dirty = true;
  }

  /** Delete the stored session and clear the cookie. Later writes start a fresh session. */
  async destroy(): Promise<void> {
    if (!this.#isNew) {
      this.#stale.push(this.#id);
      this.#destroyed = true;
    }
    this.#id = newId();
    this.#isNew = true;
    this.#data = {};
    this.#flashIn = {};
    this.#flashOut = {};
    this.#dirty = false;
  }

  #load(): Promise<Data> {
    if (this.#data) return Promise.resolve(this.#data);
    this.#loading ??= this.#store.get<StoredSession>(this.#id).then((rec) => {
      if (this.#data) return;
      if (!rec) {
        this.#isNew = true;
        this.#id = newId();
        this.#data = {};
        return;
      }
      this.#data = rec.data ?? {};
      this.#flashIn = { ...rec.flash };
      // Incoming flash is consumed by this request whether or not it is read.
      if (Object.keys(this.#flashIn).length) this.#dirty = true;
    });
    return this.#loading.then(() => this.#data!);
  }

  /** @internal Persist changes; returns what to do with the cookie. */
  async _commit(ttl: number, rolling: boolean): Promise<"set" | "clear" | null> {
    for (const id of this.#stale.splice(0)) await this.#store.delete(id);
    if (rolling && !this.#isNew && !this.#destroyed) await this.#load();
    const exists = !this.#isNew || this.#dirty;
    if (this.#dirty || (rolling && exists)) {
      const rec: StoredSession = { data: this.#data ?? {} };
      if (Object.keys(this.#flashOut).length) rec.flash = this.#flashOut;
      await this.#store.set(this.#id, rec, { ttl });
      return "set";
    }
    return this.#destroyed ? "clear" : null;
  }
}

/** Signed-cookie, store-backed sessions. Access with `session(c)` or `c.get("session")`. */
export function sessions(opts: SessionOptions): Middleware {
  const secrets = Array.isArray(opts.secret) ? opts.secret : [opts.secret];
  if (!secrets.length || secrets.some((s) => typeof s !== "string" || s.length < 32)) {
    throw new Error("sessions(): secret must be at least 32 characters");
  }
  const store = opts.store.prefix("sess:");
  const name = opts.cookieName ?? "miu.sid";
  const ttl = opts.ttl ?? 1_209_600;
  const rolling = opts.rolling ?? false;
  const cookie: CookieOptions = {
    path: opts.cookie?.path ?? "/",
    domain: opts.cookie?.domain,
    httpOnly: true,
    secure: opts.cookie?.secure,
    sameSite: opts.cookie?.sameSite ?? "Lax",
  };
  let keys: Promise<CryptoKey[]> | undefined;
  const getKeys = () => (keys ??= Promise.all(secrets.map((s) => hmacKey(s))));

  return async (c, next) => {
    const id = await unsign(c.cookie(name), await getKeys());
    const s = new Session(store, id);
    c.set("session", s);
    await next();
    const action = await s._commit(ttl, rolling);
    if (!action) return;
    const value = action === "set" ? await sign(s.id, (await getKeys())[0]!) : "";
    const header = serialize(name, value, { ...cookie, maxAge: action === "set" ? ttl : 0 });
    try {
      c.res.headers.append("set-cookie", header);
    } catch {
      // Immutable headers (e.g. Response.redirect()): copy the response.
      const h = new Headers(c.res.headers);
      h.append("set-cookie", header);
      c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
    }
  };
}

/** The current request's session. Throws if `sessions()` is not installed. */
export function session(c: Context<any, any>): Session {
  const s = c.get("session") as Session | undefined;
  if (!s) throw new Error("No session on this request: the sessions() middleware must run first");
  return s;
}

function newId(): string {
  return toBase64Url(randomBytes(32));
}

async function sign(id: string, key: CryptoKey): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(id)));
  return `${id}.${toBase64Url(sig)}`;
}

async function unsign(value: string | undefined, keys: CryptoKey[]): Promise<string | undefined> {
  if (!value) return undefined;
  const dot = value.indexOf(".");
  if (dot <= 0) return undefined;
  const id = value.slice(0, dot);
  const sig = fromBase64Url(value.slice(dot + 1));
  if (!sig || sig.length !== 32) return undefined;
  for (const key of keys) {
    if (await crypto.subtle.verify("HMAC", key, sig, utf8(id))) return id;
  }
  return undefined;
}

function serialize(name: string, value: string, o: CookieOptions): string {
  let s = `${name}=${value}; Max-Age=${o.maxAge}`;
  if (o.domain) s += `; Domain=${o.domain}`;
  if (o.path) s += `; Path=${o.path}`;
  if (o.httpOnly) s += "; HttpOnly";
  if (o.secure) s += "; Secure";
  if (o.sameSite) s += `; SameSite=${o.sameSite}`;
  return s;
}
