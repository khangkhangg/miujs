// @miujs/session — sessions in a signed cookie (default) or a server store, with flash
// messages and same-origin CSRF protection.

import { definePlugin, errors, type CloudflareNeeds, type Context, type Env } from "miujs";
import { base64urlDecode, base64urlEncode, randomId, sign, unsign, utf8 } from "./crypto.ts";
import { sessionManage } from "./manage.ts";
import type { SessionRecord, SessionStore } from "./stores.ts";

export * from "./crypto.ts";
export * from "./stores.ts";

export interface Session {
  /** Session id. Stable until `regenerate()` or `destroy()`. */
  readonly id: string;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Store a value readable (via `get`) only during the next request. */
  flash(key: string, value: unknown): void;
  /** New id, same data. Call on login and privilege changes (prevents session fixation). */
  regenerate(): void;
  /** Clear all data and expire the cookie. */
  destroy(): void;
}

declare module "miujs" {
  interface Context {
    session: Session;
  }
}

export interface SessionOptions {
  /** HMAC secret (≥ 32 chars). An array rotates: the first signs, all verify. Default: `env.SESSION_SECRET`. */
  secret?: string | string[];
  /** Server-side store. Default: everything in the signed cookie. */
  store?: SessionStore;
  /** Seconds. Default 7 days. */
  maxAge?: number;
  /** Default `miu_session`. */
  cookieName?: string;
  /** Default true, except for http://localhost. */
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  httpOnly?: boolean;
  domain?: string;
  path?: string;
  /** Extra origins (e.g. `https://admin.example.com`) allowed to send unsafe requests with the cookie. */
  trustedOrigins?: string[];
  /** Same-origin check on unsafe methods. Default true. */
  csrf?: boolean;
  /** Where dev-mode warnings go. Default: the request logger. */
  onWarning?: (message: string) => void;
}

const DAY = 24 * 3600;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_COOKIE = 4000;
const MIN_SECRET = 32;

/** Per-request session state. */
class SessionImpl implements Session {
  data: Record<string, unknown>;
  /** Flash values set on this request (for the next one). */
  nextFlash: Record<string, unknown> | undefined;
  /** Flash values from the previous request (readable now). */
  readonly incomingFlash: Record<string, unknown> | undefined;
  changed = false;
  destroyed = false;
  /** Ids to remove from the server store on response. */
  readonly stale: string[] = [];
  private _id: string | undefined;
  /** True when the client already holds a cookie for this session. */
  readonly loaded: boolean;

  constructor(id: string | undefined, record: SessionRecord | null) {
    this._id = id;
    this.loaded = !!record;
    this.data = record?.d ?? {};
    this.incomingFlash = record?.f;
    // Consuming flash values changes the stored session.
    if (record?.f && Object.keys(record.f).length) this.changed = true;
  }

  get id(): string {
    return (this._id ??= randomId());
  }
  get<T>(key: string): T | undefined {
    if (this.incomingFlash && Object.hasOwn(this.incomingFlash, key)) return this.incomingFlash[key] as T;
    return Object.hasOwn(this.data, key) ? (this.data[key] as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.revive();
    this.data[key] = value;
    this.changed = true;
  }
  delete(key: string): void {
    if (!Object.hasOwn(this.data, key)) return;
    delete this.data[key];
    this.changed = true;
  }
  flash(key: string, value: unknown): void {
    this.revive();
    (this.nextFlash ??= {})[key] = value;
    this.changed = true;
  }
  regenerate(): void {
    this.revive();
    if (this._id) this.stale.push(this._id);
    this._id = randomId();
    this.changed = true;
  }
  destroy(): void {
    if (this._id) this.stale.push(this._id);
    this._id = undefined;
    this.data = {};
    this.nextFlash = undefined;
    this.destroyed = true;
  }
  private revive(): void {
    if (this.destroyed) {
      this.destroyed = false;
      this._id = randomId();
    }
  }
  record(maxAge: number): SessionRecord {
    const r: SessionRecord = { d: this.data, e: Date.now() + maxAge * 1000 };
    if (this.nextFlash) r.f = this.nextFlash;
    return r;
  }
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function serialize(name: string, value: string, o: { maxAge: number; path: string; domain?: string; secure: boolean; httpOnly: boolean; sameSite: string }): string {
  let s = `${name}=${encodeURIComponent(value)}; Max-Age=${Math.floor(o.maxAge)}`;
  if (o.maxAge === 0) s += "; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  s += `; Path=${o.path}`;
  if (o.domain) s += `; Domain=${o.domain}`;
  if (o.secure) s += "; Secure";
  if (o.httpOnly) s += "; HttpOnly";
  s += `; SameSite=${o.sameSite}`;
  return s;
}

function withHeader(res: Response, name: string, value: string, append: boolean): Response {
  try {
    if (append) res.headers.append(name, value);
    else res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    if (append) copy.headers.append(name, value);
    else copy.headers.set(name, value);
    return copy;
  }
}

/**
 * Sessions on `ctx.session`. Put it before `auth()` in `plugins`.
 *
 * ```ts
 * miu({ plugins: [session(), auth()] })
 * ```
 */
export function session(opts: SessionOptions = {}) {
  const cookieName = opts.cookieName ?? "miu_session";
  let maxAge = opts.maxAge ?? 7 * DAY;
  const store = opts.store;
  const csrf = opts.csrf ?? true;
  const trusted = new Set<string>();
  for (const o of opts.trustedOrigins ?? []) {
    trusted.add(o.replace(/\/+$/, ""));
    const h = hostOf(o);
    if (h) trusted.add(h);
  }
  let dev = true;
  let devSecret: string | undefined;
  let warned = false;

  const KEY = Symbol("session");

  function secretsFor(ctx: Context): string[] {
    const raw = opts.secret ?? (ctx.env?.SESSION_SECRET as string | undefined);
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
    if (list.length === 0) {
      if (!dev) {
        throw errors.config(
          "MIU_E_SESSION_SECRET_MISSING",
          "No session secret configured",
          "Set the SESSION_SECRET environment variable (on Workers: `wrangler secret put SESSION_SECRET`) to a random string of 32+ characters, or pass session({ secret }).",
        );
      }
      if (!warned) {
        warned = true;
        const msg = "SESSION_SECRET is not set; using a random secret for this process. Sessions reset on restart. Set SESSION_SECRET before deploying.";
        if (opts.onWarning) opts.onWarning(msg);
        else ctx.log.warn(msg);
      }
      return [(devSecret ??= randomId())];
    }
    if (list.some((s) => s.length < MIN_SECRET)) {
      throw errors.config(
        "MIU_E_SESSION_SECRET_WEAK",
        `Session secret is shorter than ${MIN_SECRET} characters`,
        "Use a random secret of 32+ characters, e.g. the output of `openssl rand -base64 48`.",
      );
    }
    return list;
  }

  /**
   * With a session cookie, the request must prove it came from this site (Origin or Referer).
   * Without one (`cookieless`, used for routes tagged "csrf-always" such as login), browsers are
   * still checked, but clients that send neither header (curl, server-to-server) are allowed.
   */
  function csrfCheck(ctx: Context, cookieless = false): void {
    if (!csrf || !UNSAFE.has(ctx.method)) return;
    if (ctx.route?.tags.includes("csrf-exempt")) return;
    const origin = ctx.headers.get("origin");
    const referer = ctx.headers.get("referer");
    const host = ctx.url.host;
    let ok = false;
    if (origin !== null) {
      const o = origin.replace(/\/+$/, "");
      ok = hostOf(o) === host || trusted.has(o);
    } else if (referer) {
      const h = hostOf(referer);
      ok = h !== null && (h === host || trusted.has(h) || trusted.has(new URL(referer).origin));
    } else if (cookieless) {
      ok = ctx.headers.get("sec-fetch-site") !== "cross-site";
    }
    if (!ok) {
      throw errors.custom({
        code: "MIU_E_CSRF",
        status: 403,
        message: "Cross-site request blocked: the Origin/Referer does not match this site",
        fix: "Send the request from the same origin (browsers add the Origin header). For another trusted site add it to session({ trustedOrigins }); for webhooks tag the route `csrf-exempt`; API clients should use `Authorization: Bearer` without cookies.",
      });
    }
  }

  async function load(ctx: Context, raw: string, secrets: string[]): Promise<SessionImpl | null> {
    const value = await unsign(raw, secrets);
    if (value === null) return null;
    if (store) {
      const rec = await store.get(value, ctx.env);
      return rec && rec.e > Date.now() ? new SessionImpl(value, rec) : null;
    }
    const bytes = base64urlDecode(value);
    if (!bytes) return null;
    let p: { i?: unknown; d?: unknown; f?: unknown; e?: unknown };
    try {
      p = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
    if (typeof p?.i !== "string" || typeof p.e !== "number" || p.e <= Date.now() || typeof p.d !== "object" || p.d === null) return null;
    return new SessionImpl(p.i, { d: p.d as Record<string, unknown>, f: p.f as Record<string, unknown> | undefined, e: p.e });
  }

  return definePlugin({
    name: "session",
    setup(app) {
      dev = app.dev;
    },
    async onRequest(ctx) {
      const secrets = secretsFor(ctx);
      const raw = ctx.cookies.get(cookieName);
      if (raw !== undefined) csrfCheck(ctx);
      else if (ctx.route?.tags.includes("csrf-always")) csrfCheck(ctx, true);
      const loaded = raw ? await load(ctx, raw, secrets) : null;
      const s = loaded ?? new SessionImpl(undefined, null);
      ctx.state[KEY as unknown as string] = { s, secrets, hadCookie: raw !== undefined, valid: !!loaded };
      (ctx as { session: Session }).session = s;
    },
    async onResponse(ctx, res) {
      const st = ctx.state[KEY as unknown as string] as { s: SessionImpl; secrets: string[]; hadCookie: boolean; valid: boolean } | undefined;
      if (!st) return;
      const { s, secrets } = st;
      const url = ctx.url;
      const attrs = {
        path: opts.path ?? "/",
        domain: opts.domain,
        secure: opts.secure ?? !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)),
        httpOnly: opts.httpOnly ?? true,
        sameSite: opts.sameSite ?? "Lax",
      };
      if (store) for (const id of s.stale) await store.delete(id, ctx.env);
      let cookie: string | null = null;
      if (s.destroyed || (!s.changed && st.hadCookie && !st.valid)) {
        // Destroyed, or the client sent an invalid/expired cookie: expire it.
        if (st.hadCookie || s.loaded) cookie = serialize(cookieName, "", { ...attrs, maxAge: 0 });
      } else if (s.changed) {
        const record = s.record(maxAge);
        let value: string;
        if (store) {
          await store.set(s.id, record, maxAge, ctx.env);
          value = await sign(s.id, secrets[0]);
        } else {
          const payload = base64urlEncode(utf8(JSON.stringify({ i: s.id, ...record })));
          value = await sign(payload, secrets[0]);
          if (value.length > MAX_COOKIE) {
            throw errors.custom({
              code: "MIU_E_SESSION_TOO_LARGE",
              status: 500,
              message: `Session cookie would be ${value.length} bytes; browsers drop cookies over ~4 KB`,
              fix: "Store less in the session (ids, not records), or use a server store: session({ store: dbSessionStore(db) }) or kvSessionStore(\"SESSIONS\").",
            });
          }
        }
        cookie = serialize(cookieName, value, { ...attrs, maxAge });
      }
      if (!cookie) return;
      let out = withHeader(res, "set-cookie", cookie, true);
      // Responses that set a session cookie must never be stored by shared caches.
      out = withHeader(out, "cache-control", "private, no-store", false);
      return out;
    },
    inspect() {
      return {
        store: store ? (store.inspect?.() ?? { store: store.kind }) : { store: "cookie" },
        cookieName,
        maxAge,
        csrf,
        trustedOrigins: [...(opts.trustedOrigins ?? [])],
        secret: opts.secret ? "(set)" : "env.SESSION_SECRET",
      };
    },
    manage() {
      return sessionManage({
        store,
        csrf,
        getMaxAge: () => maxAge,
        setMaxAge: (s) => {
          maxAge = s;
        },
        secretsFor,
        secretSource(ctx) {
          const raw = opts.secret ?? (ctx.env?.SESSION_SECRET as string | undefined);
          const n = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean).length;
          // Outside dev, a missing secret fails every request (MIU_E_SESSION_SECRET_MISSING) before this runs.
          if (n === 0) return { value: "random (dev)", tone: "warning" };
          return { value: n === 1 ? "configured" : `configured (${n} keys, rotating)` };
        },
      });
    },
    cloudflare(): CloudflareNeeds {
      return store?.cloudflare?.() ?? {};
    },
  });
}

/** For other batteries: the session on this request, if the session plugin ran. */
export function getSession(ctx: Context): Session | undefined {
  return (ctx as { session?: Session }).session;
}

export type { Env };
