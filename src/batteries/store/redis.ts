import { prefixed, type Store } from "./types.ts";

/**
 * Redis-backed store for apps running on several servers. Portable: it imports no `node:`/`bun:`
 * modules and talks to an injected client, so it works with Bun's built-in `RedisClient`, ioredis and
 * node-redis (and any Redis-protocol server: Valkey, KeyDB, Dragonfly, Upstash over TCP).
 */

/**
 * The one method Miu needs from a Redis client: send a raw command. `Bun.RedisClient` implements it
 * as-is; wrap ioredis with `fromIoredis()` and node-redis with `fromNodeRedis()` (or pass those clients
 * directly and let `toRedisLike()` detect them). Command signatures differ between clients
 * (`eval(script, numKeys, ...)` vs `eval(script, { keys, arguments })`), so raw commands are the
 * only shape all of them share.
 */
export interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>;
}

/** ioredis: `client.call(command, ...args)`. */
export interface IoredisLike {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

/** node-redis v4/v5: `client.sendCommand([command, ...args])`. */
export interface NodeRedisLike {
  sendCommand(args: string[]): Promise<unknown>;
}

export type AnyRedisClient = RedisLike | IoredisLike | NodeRedisLike;

export function fromIoredis(client: IoredisLike): RedisLike {
  return { send: (command, args) => client.call(command, ...args) };
}

export function fromNodeRedis(client: NodeRedisLike): RedisLike {
  return { send: (command, args) => client.sendCommand([command, ...args]) };
}

/** Accept a Bun `RedisClient`, ioredis, node-redis, or anything with `send(command, args)`. */
export function toRedisLike(client: AnyRedisClient): RedisLike {
  const c = client as Partial<RedisLike & IoredisLike & NodeRedisLike>;
  if (typeof c.send === "function") return client as RedisLike;
  if (typeof c.call === "function") return fromIoredis(client as IoredisLike);
  if (typeof c.sendCommand === "function") return fromNodeRedis(client as NodeRedisLike);
  throw new TypeError("Unsupported Redis client: expected send(cmd, args) (Bun), call(cmd, ...args) (ioredis) or sendCommand(args) (node-redis)");
}

/** A Lua script run with EVALSHA, falling back to EVAL (which also caches it) on NOSCRIPT. */
export interface RedisScript {
  run(redis: RedisLike, keys: string[], args: (string | number)[]): Promise<unknown>;
}

export function redisScript(source: string): RedisScript {
  let sha: Promise<string> | undefined;
  return {
    async run(redis, keys, args) {
      sha ??= sha1Hex(source);
      const rest = [String(keys.length), ...keys, ...args.map(String)];
      try {
        return await redis.send("EVALSHA", [await sha, ...rest]);
      } catch (e) {
        if (!/NOSCRIPT/i.test(e instanceof Error ? e.message : String(e))) throw e;
        return redis.send("EVAL", [source, ...rest]);
      }
    },
  };
}

async function sha1Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RedisStoreOptions {
  /** Prefix for every key. Default `"miu:"`. */
  prefix?: string;
}

// Atomic: create-with-TTL happens in the same step as the increment, so a crash can't leave
// a counter without expiry (which would rate-limit someone forever).
const INCR = redisScript(`
local created = redis.call('EXISTS', KEYS[1]) == 0
local v
if string.find(ARGV[1], '[%.eE]') then
  v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
else
  v = redis.call('INCRBY', KEYS[1], ARGV[1])
end
if created and tonumber(ARGV[2]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v
`);

/**
 * Store backed by Redis. Values are JSON strings; TTLs use Redis expiry (server clock), and
 * `incr` runs as one Lua script. `close()` leaves the client open: you created it, you close it.
 */
export function redisStore(client: AnyRedisClient, opts: RedisStoreOptions = {}): Store {
  const redis = toRedisLike(client);
  const p = opts.prefix ?? "miu:";
  const k = (key: string) => p + key;
  const ms = (ttl: number) => String(Math.max(1, Math.round(ttl * 1000)));

  const store: Store = {
    async get<T>(key: string) {
      const v = await redis.send("GET", [k(key)]);
      return v === null || v === undefined ? undefined : (JSON.parse(String(v)) as T);
    },
    async set(key, value, o) {
      const v = JSON.stringify(value) ?? "null";
      await redis.send("SET", o?.ttl ? [k(key), v, "PX", ms(o.ttl)] : [k(key), v]);
    },
    async delete(key) {
      return Number(await redis.send("DEL", [k(key)])) > 0;
    },
    async has(key) {
      return Number(await redis.send("EXISTS", [k(key)])) > 0;
    },
    async incr(key, by = 1, o) {
      if (!Number.isFinite(by)) throw new TypeError("incr: `by` must be a finite number");
      return Number(await INCR.run(redis, [k(key)], [String(by), o?.ttl ? ms(o.ttl) : "0"]));
    },
    async ttl(key) {
      const t = Number(await redis.send("PTTL", [k(key)]));
      if (t === -2) return undefined;
      if (t === -1) return -1;
      return Math.max(0, Math.ceil(t / 1000));
    },
    prefix: (q) => prefixed(store, q),
    async close() {},
  };
  return store;
}
