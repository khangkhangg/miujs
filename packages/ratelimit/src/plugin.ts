// The rateLimit() plugin, limiter() for use outside routes, and asAuthLimiter() for @miujs/auth.

import { definePlugin, errors, type CloudflareNeeds, type Context, type Env } from "miujs";
import { checkPolicy, configError, parseWindow, type Algorithm, type Decision, type Policy, type WindowSpec } from "./algorithms.ts";
import { memoryStore, type RateLimitStore } from "./stores.ts";

type MaybePromise<T> = T | Promise<T>;
type OneOrMany = string | string[];

/** Who a rule counts: client IP, signed-in user (else IP), API key (else IP), or your function. */
export type By = "ip" | "user" | "apiKey" | ((ctx: Context) => MaybePromise<string | null | undefined>);

export interface RateLimitRule {
  /** Names the counter and the policy in headers. Default `rule_<n>`. Letters, digits, `_ . -`. */
  name?: string;
  /** All given criteria must match; a list matches any of its entries. No `match`: every request. */
  match?: {
    /** Route name, e.g. `"auth_login"`. */
    route?: OneOrMany;
    /** Path pattern: `/api/*` (this path and everything below), `:param` and `*` match one segment. */
    path?: OneOrMany;
    method?: OneOrMany;
    /** Route tag. */
    tag?: OneOrMany;
  };
  limit: number;
  /** Seconds, or `"10s"`, `"1m"`, `"15m"`, `"1h"`, `"1d"`. */
  window: WindowSpec;
  /** Default `"sliding"`. */
  algorithm?: Algorithm;
  /** Token bucket capacity (bursts). Default `limit`. */
  burst?: number;
  /** Units each request costs. Default 1. */
  cost?: number;
  /** Default: the plugin's `keyBy` (default `"ip"`). A function returning null exempts the request. */
  by?: By;
}

export interface RateLimitOptions {
  rules: RateLimitRule[];
  /** Default `memoryStore()`. On Workers use `durableObjectStore()`, `kvStore()` or `cloudflareBindingStore()`. */
  store?: RateLimitStore;
  /** Default identity for rules without `by`. Default `"ip"`. */
  keyBy?: By;
  /**
   * Header with the client IP, set by a proxy you trust (e.g. `"x-forwarded-for"` behind nginx,
   * `"cf-connecting-ip"` behind Cloudflare). The rightmost address is used: proxies append, so
   * anything to its left may be forged by the client. Without it, `ctx.ip` is used. Never name a
   * header clients can reach directly.
   */
  trustProxyHeader?: string;
  /** `"draft-6"` (default): `RateLimit-Limit/-Remaining/-Reset`. `"draft-8"`: `RateLimit` + `RateLimit-Policy`. */
  headers?: "draft-6" | "draft-8" | false;
  /** When the store fails: `"deny"` (default, 503) or `"allow"` (log and let the request through). */
  onStoreError?: "deny" | "allow";
  /** Clock, for tests. */
  now?: () => number;
}

const BY_NAMES = new Set(["ip", "user", "apiKey"]);
const MATCH_KEYS = new Set(["route", "path", "method", "tag"]);

function checkBy(by: unknown, where: string): By {
  if (typeof by === "function" || (typeof by === "string" && BY_NAMES.has(by))) return by as By;
  throw configError(`${where}: unknown by ${JSON.stringify(by)}`, 'Use by: "ip", "user", "apiKey" or a function (ctx) => string | null.');
}

const list = (v: OneOrMany | undefined, where: string, key: string): string[] | undefined => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length || arr.some((x) => typeof x !== "string" || !x)) throw configError(`${where}: match.${key} must be a non-empty string or list of strings`, `E.g. match: { ${key}: "..." }.`);
  return arr;
};

/** Compiles `/api/*`, `/users/:id`. */
function pathMatcher(pattern: string, where: string): (path: string) => boolean {
  if (!pattern.startsWith("/")) throw configError(`${where}: path pattern ${JSON.stringify(pattern)} must start with /`, 'Write it like "/api/*" or "/users/:id".');
  const segs = pattern.split("/").filter(Boolean);
  const rest = segs[segs.length - 1] === "*";
  const fixed = rest ? segs.slice(0, -1) : segs;
  return (path) => {
    const parts = path.split("/").filter(Boolean);
    if (rest ? parts.length < fixed.length : parts.length !== fixed.length) return false;
    for (let i = 0; i < fixed.length; i++) {
      const s = fixed[i];
      if (s === "*" || s.startsWith(":")) continue;
      if (s !== parts[i]) return false;
    }
    return true;
  };
}

interface Compiled {
  name: string;
  policy: Policy;
  by: By;
  windowSpec: WindowSpec;
  matches(ctx: Context): boolean;
  describe(): Record<string, unknown>;
}

function unsupported(store: RateLimitStore, policy: Policy, where: string) {
  const why = store.unsupported?.(policy);
  if (why) {
    throw errors.config("MIU_E_RATELIMIT_UNSUPPORTED", `${where}: ${store.kind} store cannot enforce this rule: ${why}`, `Change the rule, or use a store that supports it (memoryStore() or durableObjectStore() support every algorithm).`);
  }
}

function compile(rule: RateLimitRule, i: number, defaultBy: By, store: RateLimitStore, names: Set<string>): Compiled {
  if (!rule || typeof rule !== "object") throw configError(`rateLimit rule ${i + 1} is not an object`, 'Write rules like { match: { path: "/api/*" }, limit: 100, window: "1m" }.');
  const name = rule.name ?? `rule_${i + 1}`;
  const where = `rateLimit rule "${name}"`;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw configError(`${where}: invalid name`, "Use 1–64 letters, digits, _ . or -.");
  if (names.has(name)) throw configError(`${where}: duplicate rule name`, "Give each rule a different name: rules with the same name would share counters.");
  names.add(name);
  const windowMs = parseWindow(rule.window);
  const policy = checkPolicy({ algorithm: rule.algorithm ?? "sliding", limit: rule.limit, windowMs, cost: rule.cost ?? 1, burst: rule.burst }, where);
  unsupported(store, policy, where);
  const by = checkBy(rule.by ?? defaultBy, where);
  const m = rule.match ?? {};
  if (typeof m !== "object") throw configError(`${where}: match must be an object`, 'E.g. match: { route: "auth_login" }.');
  for (const k of Object.keys(m)) if (!MATCH_KEYS.has(k)) throw configError(`${where}: unknown match key ${JSON.stringify(k)}`, "Match by route, path, method or tag.");
  const routes = list(m.route, where, "route");
  const paths = list(m.path, where, "path");
  const methods = list(m.method, where, "method")?.map((x) => x.toUpperCase());
  const tags = list(m.tag, where, "tag");
  const pathFns = paths?.map((p) => pathMatcher(p, where));
  return {
    name,
    policy,
    by,
    windowSpec: rule.window,
    matches(ctx) {
      if (methods && !methods.includes(ctx.method)) return false;
      if (routes && !(ctx.route && routes.includes(ctx.route.name))) return false;
      if (tags && !(ctx.route && ctx.route.tags.some((t) => tags.includes(t)))) return false;
      if (pathFns && !pathFns.some((f) => f(ctx.path))) return false;
      return true;
    },
    describe() {
      const match: Record<string, string[]> = {};
      if (routes) match.route = routes;
      if (paths) match.path = paths;
      if (methods) match.method = methods;
      if (tags) match.tag = tags;
      const out: Record<string, unknown> = {
        name,
        match: Object.keys(match).length ? match : "all requests",
        limit: policy.limit,
        window: rule.window,
        windowSeconds: Math.ceil(windowMs / 1000),
        algorithm: policy.algorithm,
        by: typeof by === "function" ? "custom" : by,
      };
      if (policy.burst !== undefined) out.burst = policy.burst;
      if (policy.cost !== 1) out.cost = policy.cost;
      return out;
    },
  };
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
const retrySeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

interface Hit {
  rule: Compiled;
  d: Decision;
}

/**
 * General rate limiting:
 *
 * ```ts
 * rateLimit({
 *   store: durableObjectStore(),            // memoryStore() by default
 *   rules: [
 *     { name: "login", match: { route: "auth_login" }, limit: 10, window: "15m", by: "ip" },
 *     { name: "api", match: { path: "/api/*" }, limit: 100, window: "1m", by: "user" },
 *   ],
 * })
 * ```
 *
 * List it after `auth()` when a rule counts by user. Responses carry `RateLimit-*` headers;
 * blocked requests get 429 `MIU_E_RATE_LIMITED` with `Retry-After`.
 */
export function rateLimit(opts: RateLimitOptions) {
  if (!opts || !Array.isArray(opts.rules) || opts.rules.length === 0) {
    throw configError("rateLimit() needs at least one rule", 'Pass rateLimit({ rules: [{ match: { path: "/api/*" }, limit: 100, window: "1m" }] }).');
  }
  const store = opts.store ?? memoryStore();
  const defaultBy = checkBy(opts.keyBy ?? "ip", "rateLimit keyBy");
  const names = new Set<string>();
  const rules = opts.rules.map((r, i) => compile(r, i, defaultBy, store, names));
  const mode = opts.headers ?? "draft-6";
  const now = opts.now ?? Date.now;
  const onStoreError = opts.onStoreError ?? "deny";
  const proxyHeader = opts.trustProxyHeader?.toLowerCase();

  function clientIp(ctx: Context): string | undefined {
    if (proxyHeader) {
      const v = ctx.headers.get(proxyHeader);
      if (v) {
        const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
    }
    return ctx.ip;
  }

  async function identity(ctx: Context, by: By): Promise<string | null> {
    const ip = () => `ip:${clientIp(ctx) ?? "unknown"}`;
    if (typeof by === "function") {
      const v = await by(ctx);
      return v === null || v === undefined ? null : `fn:${String(v).slice(0, 512)}`;
    }
    if (by === "user") return ctx.user?.id ? `user:${ctx.user.id}` : ip();
    if (by === "apiKey") {
      const auth = ctx.headers.get("authorization");
      const key = ctx.headers.get("x-api-key") ?? (auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : null);
      // Hashed: store keys (Redis/KV) must not hold usable credentials.
      return key ? `key:${(await sha256Hex(key)).slice(0, 32)}` : ip();
    }
    return ip();
  }

  function headerValues(hit: Hit): Record<string, string> {
    const h: Record<string, string> = {};
    if (mode === false) return h;
    const { d, rule } = hit;
    if (mode === "draft-8") {
      h["ratelimit-policy"] = `"${rule.name}";q=${d.limit};w=${seconds(rule.policy.windowMs)}`;
      h["ratelimit"] = `"${rule.name}"${d.remaining === null ? "" : `;r=${d.remaining}`};t=${seconds(d.resetMs)}`;
    } else {
      h["ratelimit-limit"] = String(d.limit);
      if (d.remaining !== null) h["ratelimit-remaining"] = String(d.remaining);
      h["ratelimit-reset"] = String(seconds(d.resetMs));
    }
    return h;
  }

  const plugin = definePlugin({
    name: "ratelimit",
    setup(app) {
      if (rules.some((r) => r.by === "user")) {
        const self = app.plugins.indexOf(plugin);
        const authAt = app.plugins.findIndex((p) => p.name === "auth");
        if (self !== -1 && authAt > self) {
          throw errors.config("MIU_E_RATELIMIT_ORDER", 'rateLimit() runs before auth(), so by: "user" would never see a user', "List auth() before rateLimit() in miu({ plugins }).");
        }
      }
      if (!app.dev && app.runtime === "workerd" && store.kind === "memory") {
        app.log.warn("rateLimit() uses memoryStore() on Workers: each isolate counts separately. Use durableObjectStore(), kvStore() or cloudflareBindingStore().");
      }
    },
    async onRequest(ctx) {
      const t = now();
      let best: Hit | null = null;
      let denied: Hit | null = null;
      for (const rule of rules) {
        if (!rule.matches(ctx)) continue;
        const id = await identity(ctx, rule.by);
        if (id === null) continue;
        let d: Decision;
        try {
          d = await store.consume(`${rule.name}:${id}`, rule.policy, t, ctx.env);
        } catch (err) {
          ctx.log.error("rate limit store failed", { err, store: store.kind, rule: rule.name });
          if (onStoreError === "allow") continue;
          return errors
            .custom({
              code: "MIU_E_RATELIMIT_STORE",
              status: 503,
              message: "Rate limiting is unavailable",
              fix: `Check the ${store.kind} rate limit store (binding, network, credentials), or set rateLimit({ onStoreError: "allow" }) to fail open.`,
            })
            .toResponse({ "retry-after": "5" });
        }
        const hit = { rule, d };
        if (!d.allowed) {
          denied = hit;
          break;
        }
        const r = d.remaining ?? Number.POSITIVE_INFINITY;
        if (!best || r < (best.d.remaining ?? Number.POSITIVE_INFINITY)) best = hit;
      }
      const chosen = denied ?? best;
      if (chosen) ctx.state.rateLimit = chosen;
      if (denied) {
        const retry = retrySeconds(denied.d.retryAfterMs);
        ctx.log.warn("rate limited", { rule: denied.rule.name, route: ctx.route?.name ?? null, retryAfter: retry });
        return errors.tooManyRequests(retry).toResponse({ ...headerValues(denied), "retry-after": String(retry) });
      }
    },
    onResponse(ctx, res) {
      const hit = ctx.state.rateLimit as Hit | undefined;
      if (!hit || mode === false) return;
      const values = headerValues(hit);
      try {
        for (const [k, v] of Object.entries(values)) res.headers.set(k, v);
        return;
      } catch {
        // Immutable headers (e.g. a proxied fetch Response): copy.
        const copy = new Response(res.body, res);
        for (const [k, v] of Object.entries(values)) copy.headers.set(k, v);
        return copy;
      }
    },
    inspect() {
      return {
        store: store.inspect?.() ?? { store: store.kind },
        headers: mode,
        ipFrom: opts.trustProxyHeader ?? "ctx.ip",
        onStoreError,
        rules: rules.map((r) => r.describe()),
      };
    },
    cloudflare(): CloudflareNeeds {
      return store.cloudflare?.() ?? {};
    },
  });
  return plugin;
}

export interface LimiterOptions {
  /** Default `memoryStore()`. */
  store?: RateLimitStore;
  limit: number;
  window: WindowSpec;
  /** Default `"sliding"`. */
  algorithm?: Algorithm;
  burst?: number;
  /** Prefix for store keys. Default `"limiter"`. */
  name?: string;
  now?: () => number;
}

export interface LimitResult extends Decision {
  /** Seconds to wait (rounded up, ≥ 1) when denied; 0 when allowed. */
  retryAfter: number;
  /** Seconds until the window resets. */
  reset: number;
}

export interface Limiter {
  readonly policy: Policy;
  /** Counts one hit (or `cost`) for `key`. */
  check(key: string, opts?: { env?: Env; cost?: number }): Promise<LimitResult>;
  reset(key: string, env?: Env): Promise<void>;
}

/**
 * A limiter for code outside routes, e.g. WebSocket messages:
 *
 * ```ts
 * const perPlayer = limiter({ limit: 20, window: "1s", algorithm: "token-bucket", burst: 40 });
 * if (!(await perPlayer.check(`player:${id}`)).allowed) ws.close(1008, "slow down");
 * ```
 */
export function limiter(opts: LimiterOptions): Limiter {
  const store = opts.store ?? memoryStore();
  const name = opts.name ?? "limiter";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw configError(`limiter name ${JSON.stringify(name)} is invalid`, "Use 1–64 letters, digits, _ . or -.");
  const where = `limiter "${name}"`;
  const policy = checkPolicy({ algorithm: opts.algorithm ?? "sliding", limit: opts.limit, windowMs: parseWindow(opts.window), cost: 1, burst: opts.burst }, where);
  unsupported(store, policy, where);
  const now = opts.now ?? Date.now;
  return {
    policy,
    async check(key, o = {}) {
      const p = o.cost === undefined ? policy : checkPolicy({ ...policy, cost: o.cost }, where);
      const d = await store.consume(`${name}:${key}`, p, now(), o.env ?? {});
      return { ...d, retryAfter: d.allowed ? 0 : retrySeconds(d.retryAfterMs), reset: seconds(d.resetMs) };
    },
    async reset(key, env = {}) {
      if (!store.reset) throw errors.custom({ code: "MIU_E_RATELIMIT_UNSUPPORTED", status: 500, message: `${store.kind} store cannot reset keys`, fix: "Wait for the window to pass, or use a store with reset()." });
      await store.reset(`${name}:${key}`, env, policy, now());
    },
  };
}

/** @miujs/auth's `RateLimiter` shape (structural, so this package does not depend on auth). */
export interface AuthRateLimiter {
  readonly kind: string;
  hit(key: string, limit: number, windowSeconds: number, env?: Env): Promise<{ ok: boolean; retryAfter: number }>;
}

/**
 * Uses any store as @miujs/auth's limiter (fixed windows, like auth's own):
 *
 * ```ts
 * auth({ rateLimit: { limiter: asAuthLimiter(durableObjectStore()) } })
 * ```
 */
export function asAuthLimiter(store: RateLimitStore, opts: { now?: () => number } = {}): AuthRateLimiter {
  const now = opts.now ?? Date.now;
  return {
    kind: `ratelimit:${store.kind}`,
    async hit(key, limit, windowSeconds, env) {
      const policy = checkPolicy({ algorithm: "fixed", limit, windowMs: parseWindow(windowSeconds), cost: 1 }, "asAuthLimiter");
      unsupported(store, policy, "asAuthLimiter");
      const d = await store.consume(`auth:${key}`, policy, now(), env ?? {});
      return { ok: d.allowed, retryAfter: retrySeconds(d.allowed ? d.resetMs : d.retryAfterMs) };
    },
  };
}
