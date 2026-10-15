// The bots() plugin: sets ctx.visitor, applies the policy (full / partial / cached / block), and
// serves cached responses to bots so they never reach handlers or the database.

import { definePlugin, errors, route, type App, type CloudflareNeeds, type Context, type Env } from "miujs";
import { AGENTS, createClassifier, type AgentEntry } from "./agents.ts";
import { buildVisitor, cloudflareSignals, decideKind, type Access, type DetectOptions, type Visitor, type VisitorKind } from "./detect.ts";
import { botsErrors } from "./errors.ts";
import { renderRobots, type RobotsOptions } from "./robots.ts";
import { cacheApiStore, cacheClientStore, memoryBotStore, type BotCacheStore, type CachedResponse } from "./store.ts";

declare module "miujs" {
  interface Context {
    /** Who is asking, and what they get. Set by `bots()` from @miujs/bots. */
    visitor: Visitor;
  }
  interface RouteExtensions {
    /**
     * @miujs/bots settings for this route; `false` exempts it (every visitor gets full access).
     * Wins over a matching `bots({ routes })` entry.
     */
    bots?: false | BotsRouteOptions;
  }
}

type MaybePromise<T> = T | Promise<T>;
type OneOrMany = string | string[];

export interface BotRule {
  when(visitor: Visitor, ctx: Context): boolean;
  action: Access;
}

/** Per-route settings: the `bots` route option, or a `bots({ routes })` entry. */
export interface BotsRouteOptions {
  /** Overrides the plugin policy for these routes, by kind. */
  policy?: Partial<Record<VisitorKind, Access>>;
  /** Every visitor gets full access (the route is outside bot handling). */
  exempt?: boolean;
  /** What partial visitors get: top-level JSON fields to keep, or a function of the parsed JSON body. */
  partial?: string[] | ((data: unknown, ctx: Context) => unknown);
  /** Seconds a response stays fresh in the bot cache. Default: the plugin's `cache.ttl`. */
  ttl?: number;
}

/** Per-route settings matched like @miujs/ratelimit rules. The first matching entry applies. */
export interface BotRouteRule extends BotsRouteOptions {
  /** All given keys must match; a list matches any entry. `path`: `/api/*` is the path and everything below. */
  match: { route?: OneOrMany; path?: OneOrMany; method?: OneOrMany; tag?: OneOrMany };
}

/** A @miujs/ratelimit `limiter()` (structural, so there is no dependency). */
export interface BudgetLimiter {
  check(key: string, opts?: { env?: Env }): Promise<{ allowed: boolean; retryAfter: number }>;
}

export interface BotsCacheOptions {
  /**
   * Default: an in-memory LRU (1000 entries, 32 MiB). On Workers without a store: `ctx.cache`
   * when @miujs/cache is listed first, else the Cache API (`caches.default`).
   */
  store?: BotCacheStore;
  /** Seconds a stored response stays fresh. Default 3600. */
  ttl?: number;
  /** Seconds after `ttl` a stale copy is still served while one request refreshes it. Default 0. */
  staleWhileRevalidate?: number;
  /** Statuses that are stored. Default [200]. */
  statuses?: number[];
  /** Larger bodies are not stored. Default 1 MiB. */
  maxEntryBytes?: number;
  /** One entry per visitor country. Default false. */
  varyByCountry?: boolean;
  /** Query parameters left out of the key. `name*` is a prefix. Default TRACKING_PARAMS. */
  ignoreParams?: string[];
  /** Extra key part, e.g. `(ctx) => ctx.headers.get("accept-language")?.slice(0, 2)`. */
  varyBy?: (ctx: Context) => string | undefined;
  /**
   * Milliseconds a request waits for another in-flight request for the same key. After that it
   * runs the handler itself (the first one still finishes and stores). Default 10000.
   */
  waitMs?: number;
}

/** Timer functions, injectable for tests. Default: setTimeout / clearTimeout. */
export interface BotsTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BotsOptions {
  /** Action per visitor kind. Default: human full; search, ai, bot and unknown cached. */
  policy?: Partial<Record<VisitorKind, Access>>;
  /** Checked first, in order; the first `when` that returns true decides. */
  rules?: BotRule[];
  /** ISO country codes that are blocked. */
  blockCountries?: string[];
  /** When set, other countries are blocked. Visitors with no known country are not. */
  allowCountries?: string[];
  routes?: BotRouteRule[];
  /** Default AGENTS. */
  agents?: readonly AgentEntry[];
  /** Read Cloudflare's cf-* headers off Workers. See DetectOptions. Default false. */
  trustCloudflare?: boolean;
  /** Default 30. */
  botScoreThreshold?: number;
  /** Require sec-fetch-* from Chromium/Firefox on plain http too. Default false. */
  strictHeaders?: boolean;
  /** Confirms a search/AI claim Cloudflare did not verify (e.g. reverse DNS). Return true when genuine. */
  verify?: (req: Request, claim: { kind: "search" | "ai"; name: string }) => MaybePromise<boolean>;
  /** Status for blocked requests. Default 403. */
  blockStatus?: 403 | 404 | 410 | 429 | 451;
  /** Default partial for routes without one. */
  partial?: BotsRouteOptions["partial"];
  /** Bot cache settings, or false to never cache (cached visitors then reach handlers). */
  cache?: BotsCacheOptions | false;
  /** Serve GET /robots.txt. `true` = `{ disallowAI: true }`. */
  robots?: boolean | RobotsOptions;
  /** `X-Robots-Tag` on every response that lacks one, e.g. "noai, noimageai". */
  xRobotsTag?: string | ((visitor: Visitor) => string | undefined);
  /** Rate limits on requests that reach handlers, per kind. Counted per agent name, else per IP. */
  budget?: Partial<Record<VisitorKind, BudgetLimiter>>;
  /** Clock, for tests. */
  now?: () => number;
  /** Timers, for tests. */
  timers?: BotsTimers;
}

const DEFAULT_TIMERS: BotsTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Query parameters that never change a page: dropped from the bot cache key. */
export const TRACKING_PARAMS: readonly string[] = ["utm_*", "gclid", "fbclid", "msclkid", "dclid", "gbraid", "wbraid", "yclid", "mc_cid", "mc_eid", "_ga", "_gl", "igshid", "ref"];

const KINDS: readonly VisitorKind[] = ["human", "search", "ai", "bot", "unknown"];
const ACTIONS: readonly Access[] = ["full", "partial", "cached", "block"];
const DEFAULT_POLICY: Record<VisitorKind, Access> = { human: "full", search: "cached", ai: "cached", bot: "cached", unknown: "cached" };
const BLOCK_STATUSES = new Set([403, 404, 410, 429, 451]);
const MATCH_KEYS = new Set(["route", "path", "method", "tag"]);
const MATCH_ONLY = new Set(["match"]);
const COUNTRY = /^(?:[A-Z]{2}|T1)$/;
const REVALIDATE_HEADER = "x-miu-bots-revalidate";
const ROBOTS_ROUTE = "bots_robots_txt";
const STATE = "bots";

/** Keeps `fields` of an object, or of each object in an array. Anything else is returned as is. */
export function pickFields(data: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(data)) return data.map((d) => pickFields(d, fields));
  if (data === null || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(data, f)) out[f] = (data as Record<string, unknown>)[f];
  return out;
}

// ---------------------------------------------------------------- option checks

const cfg = botsErrors.config;

function checkPolicy(p: unknown, where: string): Partial<Record<VisitorKind, Access>> {
  if (p === undefined) return {};
  if (!p || typeof p !== "object") throw cfg(`${where} must be an object`, 'E.g. { ai: "block", bot: "cached" }.');
  for (const [k, v] of Object.entries(p)) {
    if (!KINDS.includes(k as VisitorKind)) throw cfg(`${where}: unknown visitor kind ${JSON.stringify(k)}`, `Use one of: ${KINDS.join(", ")}.`);
    if (!ACTIONS.includes(v as Access)) throw cfg(`${where}.${k}: unknown action ${JSON.stringify(v)}`, `Use one of: ${ACTIONS.join(", ")}.`);
  }
  return p as Partial<Record<VisitorKind, Access>>;
}

function checkCountries(list: unknown, where: string): Set<string> | null {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.some((c) => typeof c !== "string" || !COUNTRY.test(c.toUpperCase()))) {
    throw cfg(`${where} must be a list of two-letter ISO country codes`, 'E.g. ["US", "VN"] ("T1" is Tor).');
  }
  return new Set(list.map((c: string) => c.toUpperCase()));
}

function checkSeconds(v: unknown, where: string, allowZero = false): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) throw cfg(`${where} must be a ${allowZero ? "non-negative" : "positive"} number of seconds, got ${String(v)}`, `E.g. ${where.split(".").pop()}: 3600.`);
  return v;
}

const list = (v: OneOrMany | undefined, where: string): string[] | undefined => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length || arr.some((x) => typeof x !== "string" || !x)) throw cfg(`${where} must be a non-empty string or list of strings`, 'E.g. match: { path: "/blog/*" }.');
  return arr;
};

/** `/api/*` (the path and everything below), `:param` and `*` match one segment. */
function pathMatcher(pattern: string, where: string): (path: string) => boolean {
  if (!pattern.startsWith("/")) throw cfg(`${where}: path pattern ${JSON.stringify(pattern)} must start with /`, 'Write it like "/blog/*" or "/posts/:id".');
  const segs = pattern.split("/").filter(Boolean);
  const rest = segs[segs.length - 1] === "*";
  const fixed = rest ? segs.slice(0, -1) : segs;
  return (path) => {
    const parts = path.split("/").filter(Boolean);
    if (rest ? parts.length < fixed.length : parts.length !== fixed.length) return false;
    for (let i = 0; i < fixed.length; i++) if (fixed[i] !== "*" && !fixed[i].startsWith(":") && fixed[i] !== parts[i]) return false;
    return true;
  };
}

interface CompiledRoute extends BotRouteRule {
  matches(ctx: Context): boolean;
}

const ROUTE_OPTION_KEYS = new Set(["policy", "exempt", "partial", "ttl"]);

function checkRouteOptions(r: BotsRouteOptions, where: string, extra: Set<string> | null): void {
  for (const k of Object.keys(r)) if (!ROUTE_OPTION_KEYS.has(k) && !extra?.has(k)) throw cfg(`${where}: unknown option ${JSON.stringify(k)}`, `Use ${[...ROUTE_OPTION_KEYS].join(", ")}.`);
  checkPolicy(r.policy, `${where}.policy`);
  checkSeconds(r.ttl, `${where}.ttl`);
  if (r.exempt !== undefined && typeof r.exempt !== "boolean") throw cfg(`${where}.exempt must be true or false`, "E.g. exempt: true.");
  if (r.partial !== undefined && typeof r.partial !== "function" && !(Array.isArray(r.partial) && r.partial.every((f) => typeof f === "string"))) {
    throw cfg(`${where}.partial must be a list of field names or a function`, 'E.g. partial: ["id", "title"].');
  }
}

const EXEMPT: BotsRouteOptions = Object.freeze({ exempt: true });

/** The `bots` route option, checked. `false` is exempt. */
function compileRouteOption(o: unknown, route: string): BotsRouteOptions {
  const where = `route "${route}" option bots`;
  if (o === false) return EXEMPT;
  if (!o || typeof o !== "object") throw cfg(`${where} must be false or an object`, 'E.g. bots: { policy: { ai: "block" } }, or bots: false to exempt the route.');
  checkRouteOptions(o as BotsRouteOptions, where, null);
  return o as BotsRouteOptions;
}

function compileRoute(r: BotRouteRule, i: number): CompiledRoute {
  const where = `bots routes[${i}]`;
  if (!r || typeof r !== "object" || !r.match || typeof r.match !== "object") throw cfg(`${where} needs a match`, 'E.g. { match: { route: "get_post" }, policy: { ai: "block" } }.');
  for (const k of Object.keys(r.match)) if (!MATCH_KEYS.has(k)) throw cfg(`${where}: unknown match key ${JSON.stringify(k)}`, "Match by route, path, method or tag.");
  checkRouteOptions(r, where, MATCH_ONLY);
  const routes = list(r.match.route, `${where}.match.route`);
  const methods = list(r.match.method, `${where}.match.method`)?.map((m) => m.toUpperCase());
  const tags = list(r.match.tag, `${where}.match.tag`);
  const paths = list(r.match.path, `${where}.match.path`)?.map((p) => pathMatcher(p, where));
  return {
    ...r,
    matches(ctx) {
      if (methods && !methods.includes(ctx.method)) return false;
      if (routes && !(ctx.route && routes.includes(ctx.route.name))) return false;
      if (tags && !(ctx.route && ctx.route.tags.some((t) => tags.includes(t)))) return false;
      if (paths && !paths.some((f) => f(ctx.path))) return false;
      return true;
    },
  };
}

// ---------------------------------------------------------------- helpers

/** Sets a header, copying the response when its headers are immutable (e.g. from fetch()). */
function withHeader(res: Response, name: string, value: string): Response {
  try {
    res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set(name, value);
    return copy;
  }
}

async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function hostOf(url: string): string {
  const start = url.indexOf("//") + 2;
  const end = url.indexOf("/", start);
  return (end === -1 ? url.slice(start) : url.slice(start, end)).toLowerCase();
}

interface Deferred {
  promise: Promise<CachedResponse | null>;
  resolve(v: CachedResponse | null | Promise<CachedResponse | null>): void;
}

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  const promise = new Promise<CachedResponse | null>((r) => (resolve = r));
  return { promise, resolve };
}

/** Per-request bookkeeping, kept in ctx.state only for partial or cacheable requests. */
interface State {
  rule: BotsRouteOptions | undefined;
  key?: string;
  leader?: Deferred;
  /** The handler set a cookie: never store. */
  cookie?: boolean;
}

/**
 * Detect bots, AI crawlers and visitor location, then decide per visitor what they get:
 *
 * ```ts
 * miu({ plugins: [auth(), bots({ policy: { ai: "block" }, robots: { disallowAI: true } })] })
 * ```
 *
 * Defaults: humans get full access; search engines, AI crawlers, other bots and unknown clients
 * get cached GET/HEAD responses (one handler run per URL per hour). List `auth()` first so
 * signed-in users bypass bot handling. Handlers read `ctx.visitor`.
 */
export function bots(opts: BotsOptions = {}) {
  const policy: Record<VisitorKind, Access> = { ...DEFAULT_POLICY, ...checkPolicy(opts.policy, "bots policy") };
  const rules = opts.rules ?? [];
  if (!Array.isArray(rules)) throw cfg("bots rules must be a list", 'E.g. rules: [{ when: (v) => v.country === "XX", action: "block" }].');
  rules.forEach((r, i) => {
    if (!r || typeof r.when !== "function") throw cfg(`bots rules[${i}] needs a when(visitor, ctx) function`, 'E.g. { when: (v) => v.kind === "ai", action: "block" }.');
    if (!ACTIONS.includes(r.action)) throw cfg(`bots rules[${i}]: unknown action ${JSON.stringify(r.action)}`, `Use one of: ${ACTIONS.join(", ")}.`);
  });
  const blockCountries = checkCountries(opts.blockCountries, "bots blockCountries");
  const allowCountries = checkCountries(opts.allowCountries, "bots allowCountries");
  const routeRules = (opts.routes ?? []).map(compileRoute);
  const blockStatus = opts.blockStatus ?? 403;
  if (!BLOCK_STATUSES.has(blockStatus)) throw cfg(`bots blockStatus must be one of ${[...BLOCK_STATUSES].join(", ")}, got ${String(blockStatus)}`, "Use 403 (default), 404, 410, 429 or 451.");
  const agents = opts.agents ?? AGENTS;
  const classify = createClassifier(agents);
  const detectOpts: DetectOptions = { trustCloudflare: opts.trustCloudflare, botScoreThreshold: opts.botScoreThreshold, strictHeaders: opts.strictHeaders, classify };
  const workersDetect: DetectOptions = { ...detectOpts, runtime: "workerd" };
  const now = opts.now ?? Date.now;
  const verify = opts.verify;
  const budget = opts.budget ?? {};
  checkPolicy(Object.fromEntries(Object.keys(budget).map((k) => [k, "full"])), "bots budget");

  const c = opts.cache === false ? null : (opts.cache ?? {});
  const ttl = checkSeconds(c?.ttl, "cache.ttl") ?? 3600;
  const waitMs = c?.waitMs === undefined ? 10_000 : (checkSeconds(c.waitMs, "cache.waitMs") as number);
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const swr = checkSeconds(c?.staleWhileRevalidate, "cache.staleWhileRevalidate", true) ?? 0;
  const statuses = new Set(c?.statuses ?? [200]);
  const maxEntryBytes = c?.maxEntryBytes ?? 1024 * 1024;
  const ignore = c?.ignoreParams ?? TRACKING_PARAMS;
  const ignoreExact = new Set(ignore.filter((p) => !p.endsWith("*")));
  const ignorePrefixes = ignore.filter((p) => p.endsWith("*")).map((p) => p.slice(0, -1));
  const explicitStore = c?.store;
  const memory = explicitStore ?? memoryBotStore({ now });
  let clientStore: BotCacheStore | undefined;
  let apiStore: BotCacheStore | undefined;
  const storeFor = (ctx: Context): BotCacheStore => {
    if (explicitStore) return explicitStore;
    if (ctx.runtime === "workerd") {
      if ((ctx as { cache?: unknown }).cache) return (clientStore ??= cacheClientStore({ now }));
      if ((globalThis as { caches?: { default?: unknown } }).caches?.default) return (apiStore ??= cacheApiStore({ now }));
    }
    return memory;
  };

  const robots = opts.robots === undefined || opts.robots === false ? null : renderRobots(opts.robots === true ? {} : opts.robots, agents);
  const xRobotsTag = opts.xRobotsTag;

  const counters = {
    kinds: { human: 0, search: 0, ai: 0, bot: 0, unknown: 0 } as Record<VisitorKind, number>,
    actions: { full: 0, partial: 0, cached: 0, block: 0 } as Record<Access, number>,
    cache: { hit: 0, stale: 0, miss: 0, coalesced: 0, stored: 0, skipped: 0, errors: 0, waitTimeouts: 0 },
    budgetDenied: 0,
  };
  const inflight = new Map<string, Promise<CachedResponse | null>>();
  const revalidating = new Set<string>();
  const revalidations = new Map<string, { key: string; visitor: Visitor }>();
  let app: App | undefined;

  const ignored = (k: string) => ignoreExact.has(k) || ignorePrefixes.some((p) => k.startsWith(p));

  function keyFor(ctx: Context, access: Access): string {
    const url = ctx.req.url;
    let key = `GET:${access}:${hostOf(url)}${ctx.path}`;
    if (url.indexOf("?") !== -1) {
      const params: [string, string][] = [];
      for (const [k, v] of ctx.url.searchParams) if (!ignored(k)) params.push([k, v]);
      if (params.length) {
        params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        key += "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      }
    }
    if (c?.varyByCountry) key += `|c=${ctx.visitor.country ?? ""}`;
    const extra = c?.varyBy?.(ctx);
    if (extra) key += `|v=${extra}`;
    return key;
  }

  const exempt = (ctx: Context) => {
    const name = ctx.route?.name;
    return name !== undefined && (name.startsWith("_miu") || name === ROBOTS_ROUTE);
  };

  // Checked route options, by the route's own config object (compiled once per route).
  const fromRoute = new WeakMap<object, BotsRouteOptions>();
  /** The route's `bots` option, else the first matching `routes` entry. */
  function ruleFor(ctx: Context): BotsRouteOptions | undefined {
    const config = ctx.route?.config;
    if (config !== undefined && config.bots !== undefined) {
      let r = fromRoute.get(config);
      if (r === undefined) fromRoute.set(config, (r = compileRouteOption(config.bots, ctx.route!.name)));
      return r;
    }
    return routeRules.length ? routeRules.find((r) => r.matches(ctx)) : undefined;
  }

  function decide(v: Visitor, ctx: Context, rule: BotsRouteOptions | undefined): Access {
    if (rule?.exempt) return "full";
    for (const r of rules) if (r.when(v, ctx)) return r.action;
    if (v.country !== undefined) {
      if (blockCountries?.has(v.country)) return "block";
      if (allowCountries && !allowCountries.has(v.country)) return "block";
    }
    if (ctx.user) return "full";
    return rule?.policy?.[v.kind] ?? policy[v.kind];
  }

  function respond(e: CachedResponse, head: boolean, state: "hit" | "stale"): Response {
    const h = new Headers(e.headers);
    h.set("x-miu-bot-cache", state);
    h.set("age", String(Math.max(0, Math.floor((now() - e.storedAt) / 1000))));
    return new Response(head ? null : (e.body as BodyInit), { status: e.status, headers: h });
  }

  function blocked(v: Visitor): Response {
    const who = v.name ?? (v.kind === "human" ? `visitors from ${v.country ?? "your location"}` : `${v.kind} clients`);
    return botsErrors.blocked(blockStatus, who).toResponse(blockStatus === 429 ? { "retry-after": "3600" } : undefined);
  }

  async function overBudget(ctx: Context, v: Visitor): Promise<Response | undefined> {
    const lim = budget[v.kind];
    if (!lim) return undefined;
    const r = await lim.check(`${v.kind}:${v.name ?? `ip:${ctx.ip ?? "unknown"}`}`, { env: ctx.env });
    if (r.allowed) return undefined;
    counters.budgetDenied++;
    return errors.tooManyRequests(r.retryAfter).toResponse({ "retry-after": String(r.retryAfter) });
  }

  function storable(ctx: Context, res: Response, st: State): boolean {
    if (!statuses.has(res.status) || st.cookie || ctx.user || ctx.headers.has("authorization")) return false;
    const h = res.headers;
    if (h.has("set-cookie")) return false;
    const cc = h.get("cache-control");
    if (cc !== null && /private|no-store|no-cache/i.test(cc)) return false;
    const vary = h.get("vary");
    if (vary !== null && vary.split(",").some((x) => x.trim() !== "" && x.trim().toLowerCase() !== "accept-encoding")) return false;
    if (h.get("content-type")?.startsWith("text/event-stream")) return false;
    const len = h.get("content-length");
    if (len !== null && Number(len) > maxEntryBytes) return false;
    return true;
  }

  function startRevalidate(ctx: Context, key: string, v: Visitor): void {
    if (!app || revalidating.has(key)) return;
    revalidating.add(key);
    const id = crypto.randomUUID();
    revalidations.set(id, { key, visitor: { ...v } });
    const headers = new Headers(ctx.req.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    headers.set(REVALIDATE_HEADER, id);
    const req = new Request(ctx.req.url, { method: "GET", headers });
    const a = app;
    const run = async () => {
      try {
        const res = await (ctx.runtime === "workerd" ? a.fetch(req, ctx.env, { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), passThroughOnException() {} }) : a.fetch(req));
        await res.arrayBuffer();
        await inflight.get(key);
      } finally {
        revalidating.delete(key);
        revalidations.delete(id);
      }
    };
    ctx.waitUntil(run());
  }

  const routes = robots === null ? [] : [route.get("/robots.txt", { name: ROBOTS_ROUTE, internal: true, mcp: false, handler: () => new Response(robots, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } }) })];

  const plugin = definePlugin({
    name: "bots",
    routes,
    setup(a: App) {
      app = a;
      const self = a.plugins.indexOf(plugin);
      const authAt = a.plugins.findIndex((p) => p.name === "auth");
      if (self !== -1 && authAt > self) throw botsErrors.order("auth");
    },
    async onRequest(ctx: Context): Promise<Response | void> {
      // A background refresh of a stale entry (started below): same visitor, skip the lookup.
      const revId = ctx.headers.get(REVALIDATE_HEADER);
      const reval = revId === null ? undefined : revalidations.get(revId);
      if (reval) {
        revalidations.delete(revId!);
        ctx.visitor = reval.visitor;
        const st: State = { rule: ruleFor(ctx), key: reval.key };
        if (!inflight.has(reval.key)) {
          st.leader = deferred();
          inflight.set(reval.key, st.leader.promise);
        }
        ctx.state[STATE] = st;
        watchCookies(ctx, st);
        return;
      }

      const ua = classify(ctx.headers.get("user-agent"));
      const dOpts = ctx.runtime === "workerd" ? workersDetect : detectOpts;
      const cf = cloudflareSignals(ctx.req, dOpts);
      let hookVerified = false;
      if (verify && (ua.kind === "search" || ua.kind === "ai") && !cf?.verifiedBot) hookVerified = (await verify(ctx.req, { kind: ua.kind, name: ua.name! })) === true;
      const v = buildVisitor(ua, cf, decideKind(ctx.req, ua, cf, dOpts, hookVerified));
      ctx.visitor = v;
      counters.kinds[v.kind]++;
      if (exempt(ctx)) {
        counters.actions.full++;
        return;
      }
      const rule = ruleFor(ctx);
      const action = decide(v, ctx, rule);
      v.access = action;
      counters.actions[action]++;
      if (action === "block") {
        ctx.log.debug("bot blocked", { kind: v.kind, name: v.name, country: v.country, score: v.score, route: ctx.route?.name ?? null });
        return blocked(v);
      }
      if (action === "full") return overBudget(ctx, v);

      const st: State = { rule };
      ctx.state[STATE] = st;
      const method = ctx.method;
      const head = method === "HEAD";
      const cacheable = c !== null && (method === "GET" || head) && ctx.route !== null && !ctx.user && !ctx.headers.has("authorization") && !ctx.headers.has("upgrade");
      if (cacheable) {
        const key = keyFor(ctx, action);
        const store = storeFor(ctx);
        let e: CachedResponse | undefined;
        try {
          e = await store.get(key, ctx);
        } catch (err) {
          counters.cache.errors++;
          ctx.log.warn("bot cache read failed", { err, store: store.name });
        }
        if (e !== undefined) {
          const t = now();
          if (e.expires > t) {
            counters.cache.hit++;
            return respond(e, head, "hit");
          }
          if (e.staleUntil > t) {
            counters.cache.stale++;
            startRevalidate(ctx, key, v);
            return respond(e, head, "stale");
          }
        }
        const running = inflight.get(key);
        if (running) {
          const shared = await waitFor(running);
          if (shared) {
            counters.cache.coalesced++;
            counters.cache.hit++;
            return respond(shared, head, "hit");
          }
        } else if (!head) {
          // Registered synchronously after the lookup: concurrent misses for this key wait on it.
          st.leader = deferred();
          inflight.set(key, st.leader.promise);
        }
        counters.cache.miss++;
        if (!head) {
          st.key = key;
          watchCookies(ctx, st);
        }
      }
      const denied = await overBudget(ctx, v);
      if (denied) {
        if (st.key) settle(st, null);
        st.key = undefined;
        return denied;
      }
    },
    async onResponse(ctx: Context, res: Response): Promise<Response | void> {
      const v = ctx.visitor as Visitor | undefined;
      if (v === undefined) return;
      let out = res;
      const st = v.access === "partial" || v.access === "cached" ? (ctx.state[STATE] as State | undefined) : undefined;
      if (v.access === "partial" && !ctx.user) {
        const partial = st?.rule?.partial ?? opts.partial;
        if (partial && out.status === 200 && (out.headers.get("content-type") ?? "").includes("json")) out = await trim(out, partial, ctx);
      }
      if (xRobotsTag !== undefined && !out.headers.has("x-robots-tag")) {
        const tag = typeof xRobotsTag === "function" ? xRobotsTag(v) : xRobotsTag;
        if (tag) out = withHeader(out, "x-robots-tag", tag);
      }
      if (st?.key !== undefined) {
        const key = st.key;
        if (storable(ctx, out, st)) {
          const copy = out.clone();
          out = withHeader(out, "x-miu-bot-cache", "miss");
          const store = storeFor(ctx);
          const life = (st.rule?.ttl ?? ttl) * 1000;
          const p = readLimited(copy, maxEntryBytes)
            .then(async (body) => {
              if (body === null) {
                counters.cache.skipped++;
                return null;
              }
              const t = now();
              const headers: [string, string][] = [];
              copy.headers.forEach((value, name) => {
                if (name !== "x-miu-bot-cache") headers.push([name, value]);
              });
              const e: CachedResponse = { status: copy.status, headers, body, storedAt: t, expires: t + life, staleUntil: t + life + swr * 1000 };
              await store.set(key, e, ctx);
              counters.cache.stored++;
              return e;
            })
            .catch((err) => {
              counters.cache.errors++;
              ctx.log.warn("bot cache write failed", { err, store: store.name });
              return null;
            });
          settle(st, p);
          ctx.waitUntil(p);
        } else {
          counters.cache.skipped++;
          out = withHeader(out, "x-miu-bot-cache", "miss");
          settle(st, null);
        }
      }
      if (out !== res) return out;
    },
    inspect() {
      return {
        policy,
        rules: rules.length,
        routes: routeRules.map((r) => ({ match: r.match, policy: r.policy, exempt: r.exempt, partial: typeof r.partial === "function" ? "function" : r.partial, ttl: r.ttl })),
        blockCountries: blockCountries ? [...blockCountries] : undefined,
        allowCountries: allowCountries ? [...allowCountries] : undefined,
        blockStatus,
        trustCloudflare: opts.trustCloudflare === true,
        verify: verify ? "custom" : "Cloudflare verifiedBot only",
        cache: c === null ? false : { store: explicitStore ? explicitStore.name : `${memory.name} (Workers: ctx.cache, else caches.default)`, ttl, staleWhileRevalidate: swr, statuses: [...statuses], maxEntryBytes, waitMs, varyByCountry: c.varyByCountry === true, ...memory.inspect?.() },
        robots: robots !== null,
        budget: Object.keys(budget),
        agents: { known: agents.length, memo: classify.memoSize() },
        counters: { kinds: { ...counters.kinds }, actions: { ...counters.actions }, cache: { ...counters.cache }, budgetDenied: counters.budgetDenied },
      };
    },
    cloudflare(): CloudflareNeeds {
      return explicitStore?.cloudflare?.() ?? {};
    },
  });

  /** The in-flight result, or null once waitMs passes. The timer is cleared either way. */
  function waitFor(running: Promise<CachedResponse | null>): Promise<CachedResponse | null> {
    let handle: unknown;
    const timeout = new Promise<null>((resolve) => {
      handle = timers.set(() => {
        counters.cache.waitTimeouts++;
        resolve(null);
      }, waitMs);
    });
    return Promise.race([running, timeout]).finally(() => timers.clear(handle));
  }

  function settle(st: State, value: CachedResponse | null | Promise<CachedResponse | null>): void {
    const key = st.key!;
    const leader = st.leader;
    if (!leader) return;
    st.leader = undefined;
    leader.resolve(value);
    leader.promise.then(() => {
      if (inflight.get(key) === leader.promise) inflight.delete(key);
    });
  }

  return plugin;
}

/** Notes when the handler sets a cookie (those are added after response hooks run). */
function watchCookies(ctx: Context, st: State): void {
  const jar = ctx.cookies;
  const set = jar.set;
  const del = jar.delete;
  jar.set = (...a) => {
    st.cookie = true;
    return set(...a);
  };
  jar.delete = (...a) => {
    st.cookie = true;
    return del(...a);
  };
}

async function trim(res: Response, partial: NonNullable<BotsRouteOptions["partial"]>, ctx: Context): Promise<Response> {
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  const out = typeof partial === "function" ? partial(data, ctx) : pickFields(data, partial);
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(out), { status: res.status, headers });
}
