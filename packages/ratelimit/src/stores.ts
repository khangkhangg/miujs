// Rate limit stores: memory, Workers KV, Durable Objects, Cloudflare's Rate Limiting binding, Redis.

import { errors, type CloudflareNeeds, type Env } from "miujs";
import { checkPolicy, configError, step, type Decision, type Policy } from "./algorithms.ts";

export interface RateLimitStore {
  readonly kind: string;
  /** Counts one hit of `policy.cost` units for `key` at `now` (epoch ms) and decides. */
  consume(key: string, policy: Policy, now: number, env?: Env): Promise<Decision>;
  /** Forgets `key` (e.g. after a successful sign-in). Window-keyed stores (Redis) need `policy` and `now`. */
  reset?(key: string, env?: Env, policy?: Policy, now?: number): Promise<void>;
  /** Why this store cannot enforce `policy`, or null. Checked when rules are configured. */
  unsupported?(policy: Policy): string | null;
  inspect?(): Record<string, unknown>;
  cloudflare?(): CloudflareNeeds;
  /** Keys held, when the store can tell cheaply (memory). Used by `manage()`. */
  size?(): number;
  /** Page through live keys (memory). Used by `manage()`. */
  scan?(q: RateLimitScanQuery): Promise<{ keys: RateLimitKeyInfo[]; next?: string }>;
}

export interface RateLimitScanQuery {
  /** Opaque cursor from the previous page's `next`. */
  cursor?: string;
  limit: number;
  now: number;
  /** Only keys whose last hit used up the limit or was denied. */
  limitedOnly?: boolean;
  /** Only keys containing this text. */
  search?: string;
}

export interface RateLimitKeyInfo {
  /** `<rule>:<identity>`. */
  key: string;
  limited: boolean;
  /** Epoch ms after which the key's state is dropped. */
  expiresAt: number;
}

const missingBinding = (binding: string, what: string, fix: string) =>
  errors.config("MIU_E_RATELIMIT_BINDING", `Rate limit ${what} binding "${binding}" is not configured`, fix);

interface MemoryEntry {
  state: unknown;
  exp: number;
  /** The last hit used up the limit (or was denied). Such keys are evicted last. */
  blocked: boolean;
}

/**
 * Makes room in a Map of rate limit windows, oldest first: drops expired entries, then (when still
 * at `maxKeys`) a batch of the least recently allowed keys that are not blocked, and only then
 * blocked ones. Evicting in batches keeps the cost O(1) per new key, amortized; sparing blocked
 * keys means a flood of fresh keys cannot reset an attacker's own exhausted counter.
 * Returns the size at which the next sweep should run.
 */
function sweepWindows<E extends { blocked: boolean }>(map: Map<string, E>, maxKeys: number, expired: (e: E) => boolean): number {
  for (const [k, v] of map) if (expired(v)) map.delete(k);
  if (map.size >= maxKeys) {
    const target = maxKeys - Math.max(1, maxKeys >> 4);
    for (const [k, v] of map) {
      if (map.size <= target) break;
      if (!v.blocked) map.delete(k);
    }
    for (const k of map.keys()) {
      if (map.size <= target) break;
      map.delete(k);
    }
  }
  return Math.min(maxKeys, Math.max(1024, map.size * 2));
}

/**
 * In-process counters: exact on one Bun/Deno/Node server; per isolate (approximate) on Workers.
 * Bounded by `maxKeys`. Expired windows are swept whenever the store has doubled since the last
 * sweep; when it is full, the least recently allowed keys that are not blocked are evicted first,
 * so a flood of new keys cannot reset a client that is currently rate limited.
 */
export function memoryStore(opts: { maxKeys?: number } = {}): RateLimitStore {
  const maxKeys = opts.maxKeys ?? 100_000;
  const map = new Map<string, MemoryEntry>();
  let sweepAt = Math.min(maxKeys, 1024);
  return {
    kind: "memory",
    async consume(key, policy, now) {
      const e = map.get(key);
      const r = step(e && e.exp > now ? e.state : null, policy, now);
      if (r.decision.allowed) {
        // Re-inserted, so Map order is least recently allowed first.
        if (e) map.delete(key);
        else if (map.size >= sweepAt) sweepAt = sweepWindows(map, maxKeys, (v) => v.exp <= now);
        map.set(key, { state: r.state, exp: now + r.ttlMs, blocked: r.decision.remaining === 0 });
      } else if (e) {
        e.blocked = true;
      }
      return r.decision;
    },
    async reset(key) {
      map.delete(key);
    },
    size: () => map.size,
    // Cursor = matches already returned. Map order changes as clients are allowed, so paging is
    // approximate under traffic; the walk is bounded by `maxKeys`.
    async scan(q) {
      const skip = q.cursor ? Number(q.cursor) || 0 : 0;
      const keys: RateLimitKeyInfo[] = [];
      let seen = 0;
      for (const [key, e] of map) {
        if (e.exp <= q.now || (q.limitedOnly && !e.blocked) || (q.search && !key.includes(q.search))) continue;
        if (seen++ < skip) continue;
        if (keys.length === q.limit) return { keys, next: String(skip + keys.length) };
        keys.push({ key, limited: e.blocked, expiresAt: e.exp });
      }
      return { keys };
    },
    inspect: () => ({ store: "memory", exact: "per process", keys: map.size, maxKeys }),
  };
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/**
 * Workers KV. **Approximate**: KV is eventually consistent (writes take up to ~60 s to reach other
 * locations) and read-modify-write is not atomic, so concurrent or multi-region clients can exceed
 * the limit. KV also allows ~1 write per second per key. Fine for coarse abuse limits; use
 * `durableObjectStore` for exact counts.
 */
export function kvStore(binding: string, opts: { prefix?: string } = {}): RateLimitStore {
  const prefix = opts.prefix ?? "ratelimit:";
  const kv = (env: Env | undefined): KvLike => {
    const b = env?.[binding] as KvLike | undefined;
    if (!b || typeof b.get !== "function" || typeof b.put !== "function") {
      throw missingBinding(binding, "KV", `Add a KV namespace binding named ${binding} to wrangler.toml (miu deploy cloudflare does this), or use memoryStore() locally.`);
    }
    return b;
  };
  return {
    kind: `kv:${binding}`,
    async consume(key, policy, now, env) {
      const b = kv(env);
      const r = step(parseJson(await b.get(prefix + key)), policy, now);
      // Denied hits change nothing; skipping the write also respects KV's per-key write rate.
      if (r.decision.allowed) await b.put(prefix + key, JSON.stringify(r.state), { expirationTtl: Math.max(60, Math.ceil(r.ttlMs / 1000)) });
      return r.decision;
    },
    async reset(key, env) {
      await kv(env).delete(prefix + key);
    },
    inspect: () => ({ store: "kv", binding, exact: false, note: "eventually consistent; may over-admit under concurrency" }),
    cloudflare: () => ({ kv: [binding] }),
  };
}

interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

const DO_ORIGIN = "https://ratelimit.miujs.internal";

/**
 * Exact, globally consistent counts on Workers: one Durable Object per key. Export the class from
 * your Worker entry: `export { RateLimiterDurableObject } from "@miujs/ratelimit";`.
 */
export function durableObjectStore(binding = "RATE_LIMITER"): RateLimitStore {
  const ns = (env: Env | undefined): DoNamespaceLike => {
    const b = env?.[binding] as DoNamespaceLike | undefined;
    if (!b || typeof b.idFromName !== "function" || typeof b.get !== "function") {
      throw missingBinding(
        binding,
        "Durable Object",
        `Add a durable_objects binding named ${binding} with class_name "RateLimiterDurableObject" (miu deploy cloudflare does this) and export the class: export { RateLimiterDurableObject } from "@miujs/ratelimit".`,
      );
    }
    return b;
  };
  const call = async (env: Env | undefined, key: string, path: string, body: unknown) => {
    const n = ns(env);
    const res = await n.get(n.idFromName(key)).fetch(`${DO_ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw errors.internal(`RateLimiterDurableObject answered ${res.status}: ${await res.text()}`);
    return res;
  };
  return {
    kind: `durable-object:${binding}`,
    async consume(key, policy, now, env) {
      return (await (await call(env, key, "/consume", { policy, now })).json()) as Decision;
    },
    async reset(key, env) {
      await call(env, key, "/reset", {});
    },
    inspect: () => ({ store: "durable-object", binding, className: "RateLimiterDurableObject", exact: true }),
    cloudflare: () => ({ durableObjects: [{ binding, className: "RateLimiterDurableObject" }] }),
  };
}

interface DoStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
  deleteAll(): Promise<unknown>;
  setAlarm?(t: number): Promise<unknown>;
}

/** The Durable Object behind `durableObjectStore`. One instance holds one key's state. */
export class RateLimiterDurableObject {
  private storage: DoStorageLike;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(state: { storage: DoStorageLike }, _env?: unknown) {
    this.storage = state.storage;
  }

  /** Runs one operation at a time (input gates already do this; this keeps it true for any storage). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || (path !== "/consume" && path !== "/reset")) return new Response("not found", { status: 404 });
    if (path === "/reset") return this.serial(async () => (await this.storage.deleteAll(), new Response(null, { status: 204 })));
    let policy: unknown;
    let now: unknown;
    try {
      ({ policy, now } = (await req.json()) as { policy: unknown; now: unknown });
      const p = policy as Policy;
      checkPolicy({ algorithm: p.algorithm, limit: p.limit, windowMs: p.windowMs, cost: p.cost, burst: p.burst }, "RateLimiterDurableObject");
      if (!Number.isInteger(p.windowMs) || p.windowMs <= 0) throw new Error("windowMs");
      if (typeof now !== "number" || !Number.isFinite(now)) throw new Error("now");
    } catch (err) {
      return new Response(`bad request: ${(err as Error).message}`, { status: 400 });
    }
    return this.serial(async () => {
      const r = step(await this.storage.get("s"), policy as Policy, now as number);
      if (r.decision.allowed) {
        await this.storage.put("s", r.state);
        // State older than its ttl equals no state: let the alarm free the storage.
        await this.storage.setAlarm?.((now as number) + r.ttlMs);
      }
      return Response.json(r.decision);
    });
  }

  async alarm(): Promise<void> {
    await this.serial(() => this.storage.deleteAll() as Promise<unknown>);
  }
}

interface CfRateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface CloudflareBindingOptions {
  /** Must match the binding's `simple.limit` in wrangler.toml. */
  limit: number;
  /** Seconds; Cloudflare supports 10 or 60. */
  period: 10 | 60;
  /** `namespace_id` for wrangler.toml (a unique positive integer as a string). */
  namespaceId?: string;
}

/**
 * Cloudflare's native Rate Limiting binding (`[[ratelimits]]`): fast and shared across isolates
 * per location, but counts are per Cloudflare location and approximate, it reports no remaining
 * count, and its limit/period are fixed in wrangler.toml, so every rule using it must match them.
 */
export function cloudflareBindingStore(binding: string, opts: CloudflareBindingOptions): RateLimitStore {
  if (!opts || !Number.isInteger(opts.limit) || opts.limit < 1) throw configError(`cloudflareBindingStore("${binding}"): limit must be a positive integer`, "Pass the binding's configured limit, e.g. { limit: 100, period: 60 }.");
  if (opts.period !== 10 && opts.period !== 60) throw configError(`cloudflareBindingStore("${binding}"): period must be 10 or 60`, "Cloudflare's Rate Limiting binding supports periods of 10 or 60 seconds.");
  const windowMs = opts.period * 1000;
  return {
    kind: `cloudflare:${binding}`,
    unsupported(p) {
      if (p.algorithm === "token-bucket") return "the Cloudflare binding has no token bucket; use durableObjectStore()";
      if (p.cost !== 1) return "the Cloudflare binding counts one per call (cost must be 1)";
      if (p.limit !== opts.limit || p.windowMs !== windowMs) return `binding "${binding}" is configured for ${opts.limit} per ${opts.period} s; give the rule limit: ${opts.limit}, window: "${opts.period}s", or use another binding`;
      return null;
    },
    async consume(key, _policy, _now, env) {
      const b = env?.[binding] as CfRateLimitBinding | undefined;
      if (!b || typeof b.limit !== "function") {
        throw missingBinding(binding, "Cloudflare Rate Limiting", `Add [[ratelimits]] name = "${binding}" with simple = { limit = ${opts.limit}, period = ${opts.period} } to wrangler.toml (miu deploy cloudflare does this).`);
      }
      const { success } = await b.limit({ key });
      return { allowed: success, limit: opts.limit, remaining: null, resetMs: windowMs, retryAfterMs: success ? 0 : windowMs };
    },
    inspect: () => ({ store: "cloudflare-ratelimit", binding, limit: opts.limit, period: opts.period, exact: false }),
    cloudflare: () => ({ ratelimits: [{ binding, limit: opts.limit, period: opts.period, ...(opts.namespaceId ? { namespaceId: opts.namespaceId } : {}) }] }),
  };
}

/**
 * The Redis commands used, structurally: ioredis, Upstash and Bun's client use lower case
 * (`incrby`, `pexpire`); node-redis v4 uses camelCase (`incrBy`, `pExpire`). Both work.
 */
export interface RedisLike {
  incrby?(key: string, n: number): Promise<number | string>;
  incrBy?(key: string, n: number): Promise<number | string>;
  pexpire?(key: string, ms: number): Promise<unknown>;
  pExpire?(key: string, ms: number): Promise<unknown>;
  get(key: string): Promise<string | number | null>;
  del?(...keys: string[]): Promise<unknown>;
}

/**
 * Redis (fixed and sliding windows). Exact across servers: INCRBY is atomic, and a denied hit is
 * given back with a negative INCRBY. Window keys expire on their own.
 */
export function redisStore(client: RedisLike, opts: { prefix?: string } = {}): RateLimitStore {
  const incrby = client?.incrby?.bind(client) ?? client?.incrBy?.bind(client);
  const pexpire = client?.pexpire?.bind(client) ?? client?.pExpire?.bind(client);
  if (!incrby || !pexpire || typeof client.get !== "function") {
    throw configError("redisStore() needs a client with incrby, pexpire and get", "Pass an ioredis, node-redis, Upstash or Bun Redis client, or any object with incrby(key, n), pexpire(key, ms) and get(key).");
  }
  const prefix = opts.prefix ?? "ratelimit:";
  const windowKey = (key: string, ws: number) => `${prefix}${key}:${ws}`;
  return {
    kind: "redis",
    unsupported(p) {
      return p.algorithm === "token-bucket" ? 'redisStore() supports "fixed" and "sliding"; the token bucket needs an atomic read-modify-write: use memoryStore() or durableObjectStore()' : null;
    },
    async consume(key, policy, now) {
      const ws = Math.floor(now / policy.windowMs) * policy.windowMs;
      const k = windowKey(key, ws);
      const n = Number(await incrby(k, policy.cost));
      if (n === policy.cost) await pexpire(k, policy.windowMs * (policy.algorithm === "sliding" ? 2 : 1) + 1000);
      const before = Math.min(policy.limit, Math.max(0, n - policy.cost));
      const state =
        policy.algorithm === "fixed"
          ? { a: "f", s: ws, c: before }
          : { a: "s", s: ws, c: before, p: Math.min(policy.limit, Math.max(0, Number((await client.get(windowKey(key, ws - policy.windowMs))) ?? 0) || 0)) };
      const r = step(state, policy, now);
      if (!r.decision.allowed) await incrby(k, -policy.cost);
      return r.decision;
    },
    async reset(key, _env, policy, now = Date.now()) {
      if (!policy || typeof client.del !== "function") {
        throw errors.custom({
          code: "MIU_E_RATELIMIT_UNSUPPORTED",
          status: 500,
          message: "redisStore().reset needs the policy and a client with del",
          fix: "Call limiter.reset(key) (it passes the policy), and give redisStore a client with del(...keys).",
        });
      }
      const ws = Math.floor(now / policy.windowMs) * policy.windowMs;
      await client.del(windowKey(key, ws), windowKey(key, ws - policy.windowMs));
    },
    inspect: () => ({ store: "redis", prefix, exact: true, algorithms: ["fixed", "sliding"] }),
  };
}
