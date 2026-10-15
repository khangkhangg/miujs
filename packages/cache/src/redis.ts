import { detectRuntime, MiuError, processEnv } from "miujs";
import { cacheErrors } from "./errors.ts";
import type { CacheStore } from "./store.ts";

export interface RedisSetOptions {
  /** Expire after this many seconds (SET ... EX). */
  ex?: number;
  /** Expire after this many milliseconds (SET ... PX). */
  px?: number;
  /** Only set when the key does not exist (SET ... NX). */
  nx?: boolean;
}

/**
 * The few Redis commands MiuJS batteries use, as a structural interface: no npm client needed.
 * `bunRedis()` adapts Bun's built-in client; `redisFromCommand(fn)` adapts anything that can send
 * a raw command (node-redis `sendCommand`, ioredis `call`, ...). Values are strings.
 * Deliberately MULTI- and EVAL-free so any Redis-compatible server (Valkey, Dragonfly, KeyDB,
 * Upstash) works.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** Resolves true when the value was written (false when `nx` found the key). */
  set(key: string, value: string, opts?: RedisSetOptions): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  pexpire(key: string, ms: number): Promise<boolean>;
  zadd(key: string, score: number, member: string): Promise<number>;
  /** Members with min <= score <= max, lowest first, at most `limit`. */
  zrangebyscore(key: string, min: number, max: number, limit?: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
  zscore(key: string, member: string): Promise<number | null>;
  zcard(key: string): Promise<number>;
  lpush(key: string, value: string): Promise<number>;
  /** Atomically pop the tail of `src` and push it onto the head of `dst`. */
  rpoplpush(src: string, dst: string): Promise<string | null>;
  /** Remove every occurrence of `value`. */
  lrem(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  close?(): void;
  /** Shown in `miu inspect`. Never secrets. */
  inspect?(): Record<string, unknown>;
}

/** Sends one raw command, e.g. `("SET", ["k", "v", "PX", "1000"])`. */
export type RedisCommand = (command: string, args: string[]) => Promise<unknown>;

const num = (n: number): string => (n === -Infinity ? "-inf" : n === Infinity ? "+inf" : String(n));
const truthy = (v: unknown): boolean => v === true || Number(v) === 1;
const int = (v: unknown): number => Number(v ?? 0);

/** A `RedisLike` over any function that sends a raw Redis command. */
export function redisFromCommand(send: RedisCommand): RedisLike {
  return {
    get: async (key) => ((await send("GET", [key])) as string | null) ?? null,
    async set(key, value, o) {
      const args = [key, value];
      if (o?.ex !== undefined) args.push("EX", String(o.ex));
      if (o?.px !== undefined) args.push("PX", String(o.px));
      if (o?.nx) args.push("NX");
      return (await send("SET", args)) != null;
    },
    del: async (...keys) => int(await send("DEL", keys)),
    incr: async (key) => int(await send("INCR", [key])),
    expire: async (key, s) => truthy(await send("EXPIRE", [key, String(s)])),
    pexpire: async (key, ms) => truthy(await send("PEXPIRE", [key, String(ms)])),
    zadd: async (key, score, member) => int(await send("ZADD", [key, num(score), member])),
    async zrangebyscore(key, min, max, limit) {
      const args = [key, num(min), num(max)];
      if (limit !== undefined) args.push("LIMIT", "0", String(limit));
      return ((await send("ZRANGEBYSCORE", args)) as string[] | null) ?? [];
    },
    zrem: async (key, member) => int(await send("ZREM", [key, member])),
    async zscore(key, member) {
      const v = await send("ZSCORE", [key, member]);
      return v == null ? null : Number(v);
    },
    zcard: async (key) => int(await send("ZCARD", [key])),
    lpush: async (key, value) => int(await send("LPUSH", [key, value])),
    rpoplpush: async (src, dst) => ((await send("RPOPLPUSH", [src, dst])) as string | null) ?? null,
    lrem: async (key, value) => int(await send("LREM", [key, "0", value])),
    lrange: async (key, start, stop) => ((await send("LRANGE", [key, String(start), String(stop)])) as string[] | null) ?? [],
    llen: async (key) => int(await send("LLEN", [key])),
  };
}

const REDIS_METHODS = ["get", "set", "del"] as const;

export function isRedisLike(v: unknown, methods: readonly string[] = REDIS_METHODS): v is RedisLike {
  const o = v as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && methods.every((m) => typeof o[m] === "function");
}

/** `redis://user:pass@host` → `redis://user:***@host`. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

interface BunRedisClient {
  send(command: string, args: string[]): Promise<unknown>;
  close(): void;
}
type BunRedisCtor = new (url?: string, options?: Record<string, unknown>) => BunRedisClient;

/** Options passed through to Bun's `RedisClient` (connectionTimeout, autoReconnect, tls, ...). */
export type BunRedisOptions = Record<string, unknown>;

/** @internal `bunRedis` with the runtime and client class injected, for tests. */
export function _bunRedisWith(Ctor: BunRedisCtor | undefined, runtime: string, url?: string, options?: BunRedisOptions): RedisLike {
  if (runtime !== "bun" || !Ctor) {
    throw new MiuError({
      code: "MIU_E_CACHE_REDIS_RUNTIME",
      status: 500,
      message: `bunRedis() needs Bun's built-in Redis client; this is ${runtime}`,
      fix: "Run on Bun 1.2.9+, or pass any RedisLike client: wrap your Redis library with redisFromCommand((cmd, args) => client.sendCommand([cmd, ...args])). On Cloudflare Workers use kvStore / kvSessionStore / cloudflareQueue instead.",
    });
  }
  const resolved = url ?? processEnv().REDIS_URL ?? processEnv().VALKEY_URL;
  const client = options ? new Ctor(resolved, options) : new Ctor(resolved);
  return {
    ...redisFromCommand((cmd, args) => client.send(cmd, args)),
    close: () => client.close(),
    inspect: () => ({ client: "bun", url: redactUrl(resolved ?? "redis://localhost:6379") }),
  };
}

/**
 * Bun's built-in Redis client (`import { RedisClient } from "bun"`) as a `RedisLike`. `url`
 * defaults to `REDIS_URL` (or `VALKEY_URL`), then `redis://localhost:6379`. Bun only: other
 * runtimes get MIU_E_CACHE_REDIS_RUNTIME.
 */
export function bunRedis(url?: string, options?: BunRedisOptions): RedisLike {
  const Ctor = (globalThis as { Bun?: { RedisClient?: BunRedisCtor } }).Bun?.RedisClient;
  return _bunRedisWith(Ctor, detectRuntime(), url, options);
}

// ---------------------------------------------------------------------------------------------

export interface RedisStoreOptions {
  /** Prepended to every key. Default "miu:cache:". */
  prefix?: string;
}

/**
 * Redis-backed cache shared by every instance of the app. TTLs map to `SET ... PX`, so Redis
 * expires entries itself. `redisStore(bunRedis())` on Bun.
 */
export function redisStore(client: RedisLike, opts: RedisStoreOptions = {}): CacheStore {
  if (!isRedisLike(client)) {
    throw cacheErrors.config("redisStore needs a Redis client with get/set/del", "Pass bunRedis() on Bun, or wrap another client with redisFromCommand(...).");
  }
  const prefix = opts.prefix ?? "miu:cache:";
  if (typeof prefix !== "string") {
    throw cacheErrors.config(`redisStore prefix must be a string, got ${String(prefix)}`, 'Pass a prefix such as "myapp:cache:", or "" for none.');
  }
  const call = async <T>(op: string, key: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw cacheErrors.redis(op, key, err);
    }
  };
  return {
    name: "redis",
    get: (key) => call("GET", key, async () => (await client.get(prefix + key)) ?? undefined),
    set: (key, value, o) =>
      call("SET", key, async () => {
        await client.set(prefix + key, value, o?.ttl ? { px: Math.ceil(o.ttl * 1000) } : undefined);
      }),
    delete: (key) =>
      call("DEL", key, async () => {
        await client.del(prefix + key);
      }),
    inspect: () => ({ prefix, ...(client.inspect ? { client: client.inspect() } : {}) }),
  };
}
