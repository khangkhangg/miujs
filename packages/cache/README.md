# @miujs/cache

> Key/value cache for MiuJS with TTLs, tag invalidation and `remember()`, backed by memory, Cloudflare KV or Redis.

`@miujs/cache` adds `ctx.cache` to every request. Values are JSON-serialized, reads return fresh copies, and `remember()` shares one computation between concurrent callers for the same key. With no options it uses an in-process LRU locally and the KV namespace bound as `CACHE` on Cloudflare Workers. Use it to cache expensive reads, API responses or computed data.

## Install

```bash
bun add @miujs/cache miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { cache } from "@miujs/cache";

let hits = 0;

export const counter = route.get("/count/:id", {
  params: t.object({ id: t.string() }),
  handler: async ({ params, cache }) => {
    return cache.remember(`count:${params.id}`, 60, async () => ({ computed: ++hits }));
  },
});

const app = miu({ name: "cache-demo", routes: [counter], plugins: [cache()] });
export default app;
```

`cache()` with no options uses `memoryStore()` (1000 entries) locally, and `kvStore` over `env.CACHE` on Workers when that binding exists.

## The client

`ctx.cache` (and `createCache(store)`) is a `CacheClient`:

| Method | What it does |
| --- | --- |
| `get<T>(key)` | Value or `undefined`. Corrupt entries read as a miss. |
| `set(key, value, { ttl?, tags? })` | `ttl` in seconds; omit to keep until evicted or deleted. |
| `delete(key)` | Removes one key. |
| `remember<T>(key, ttlSeconds, fn)` | Returns the cached value or runs `fn`, caches its result and returns it. Errors and `undefined` are not cached. |
| `invalidateTag(tag)` | Deletes every key that was `set` with this tag. |

Tag indexes are stored under keys starting with `TAG_PREFIX` (`"__miu:tag:"`); do not use that prefix for your own keys. An index drops keys that expired or were deleted once it has doubled in size, and when all of its keys have a TTL it expires a minute after the last one, so tags that are never invalidated do not pile up in Redis or KV.

<!-- test -->
```ts
import { createCache, memoryStore } from "@miujs/cache";

const cache = createCache(memoryStore({ maxEntries: 500 }));

await cache.set("user:1", { name: "Mia" }, { ttl: 300, tags: ["users"] });
const user = await cache.get<{ name: string }>("user:1");
console.log(user?.name);

await cache.invalidateTag("users");
console.log(await cache.get("user:1")); // undefined
```

Use `createCache(store)` outside requests (jobs, scripts). Clients over the same store share in-flight `remember()` calls.

## Stores

### Memory

`memoryStore({ maxEntries, now })` is an in-process LRU with TTLs. Each process (and each Workers isolate) has its own copy, so it is not shared between servers.

### Cloudflare KV

`kvStore(binding)` takes a KV binding or its name. A name is resolved from `ctx.env` on each request, and a missing binding fails only the requests that use the cache (`MIU_E_CACHE_BINDING`).

<!-- test -->
```ts
import { miu } from "miujs";
import { cache, kvStore } from "@miujs/cache";

export default miu({ name: "kv-cache", plugins: [cache({ store: kvStore("MY_KV") })] });
```

Notes:

- TTLs under 60 seconds are raised to 60 (`KV_MIN_TTL`, KV's minimum).
- KV is eventually consistent (up to about 60 s across locations), so `delete` and `invalidateTag` may take that long to be seen everywhere, and tag indexes written from two locations at once can lose a key.

### Redis

`redisStore(client, { prefix })` stores entries in Redis and lets Redis expire them (`SET ... PX`). The client is any `RedisLike`:

- `bunRedis(url?, options?)` wraps Bun's built-in client. `url` defaults to `REDIS_URL`, then `VALKEY_URL`, then `redis://localhost:6379`. Bun only.
- `redisFromCommand(send)` adapts anything that can send a raw command (node-redis `sendCommand`, ioredis `call`, ...).

<!-- test -->
```ts
import { miu } from "miujs";
import { bunRedis, cache, redisStore } from "@miujs/cache";

const store = redisStore(bunRedis(), { prefix: "myapp:cache:" });

export default miu({ name: "redis-cache", plugins: [cache({ store })] });
```

With another client:

```ts
import { createClient } from "redis";
import { redisFromCommand, redisStore } from "@miujs/cache";

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const store = redisStore(redisFromCommand((cmd, args) => client.sendCommand([cmd, ...args])));
```

`RedisLike` avoids MULTI and EVAL, so Valkey, Dragonfly, KeyDB and Upstash work. The same client also serves `redisQueue` from `@miujs/queue`.

### Custom stores

A `CacheStore` moves strings: `name`, `get(key)`, `set(key, value, { ttl })`, `delete(key)`, and optionally `size()`, `forEnv(env)` and `inspect()`.

## Options

`cache(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `store` | `CacheStore` | `memoryStore()`; on Workers `kvStore(env.CACHE)` when bound | Where entries live. |

`memoryStore(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxEntries` | `number` | `1000` | Entries kept before the least recently used is evicted. |
| `now` | `() => number` | `Date.now` | Clock in milliseconds, for tests. |

`redisStore(client, options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `prefix` | `string` | `"miu:cache:"` | Prepended to every key. `""` for none. |

`set(key, value, options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `ttl` | `number` | none | Seconds until the entry expires. Must be positive. |
| `tags` | `string[]` | `[]` | Tags for `invalidateTag`. |

## Errors

- [`MIU_E_CACHE_CONFIG`](../../docs/errors.md#miu_e_cache_config): invalid store options (e.g. `maxEntries`, Redis client, prefix).
- [`MIU_E_CACHE_KEY`](../../docs/errors.md#miu_e_cache_key): a key or tag is not a non-empty string.
- [`MIU_E_CACHE_TTL`](../../docs/errors.md#miu_e_cache_ttl): `ttl` is not a positive number of seconds.
- [`MIU_E_CACHE_VALUE`](../../docs/errors.md#miu_e_cache_value): the value is not JSON-serializable (`undefined`, BigInt, cycles).
- [`MIU_E_CACHE_BINDING`](../../docs/errors.md#miu_e_cache_binding): the named KV binding is missing from `env`.
- [`MIU_E_CACHE_REDIS`](../../docs/errors.md#miu_e_cache_redis): a Redis command failed.
- [`MIU_E_CACHE_REDIS_RUNTIME`](../../docs/errors.md#miu_e_cache_redis_runtime): `bunRedis()` called outside Bun.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

With no `store`, the plugin uses the KV namespace bound as `CACHE` (`DEFAULT_KV_BINDING`) and falls back to memory if it is absent. With `kvStore("NAME")`, the plugin reports the binding to `miu deploy cloudflare`.

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<namespace-id>"
```

`memoryStore()` works on Workers but is per isolate. `bunRedis()` is Bun only; on Workers use `kvStore`, or `redisFromCommand` over an HTTP Redis client.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/queue](../queue/README.md), [@miujs/ratelimit](../ratelimit/README.md), [@miujs/db](../db/README.md)
