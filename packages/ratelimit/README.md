# @miujs/ratelimit

> Rules-based rate limiting for MiuJS with fixed, sliding and token-bucket algorithms, IETF RateLimit headers, and memory, KV, Durable Object, Cloudflare binding and Redis stores.

`@miujs/ratelimit` provides the `rateLimit()` plugin: each rule matches requests by route, path, method or tag, counts them per IP, user, API key or a function, and blocks with 429 `MIU_E_RATE_LIMITED` and `Retry-After` when the limit is reached. `limiter()` applies the same algorithms outside routes (WebSocket messages, jobs), and `asAuthLimiter()` lets `@miujs/auth` use any of these stores.

## Install

```bash
bun add @miujs/ratelimit miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route } from "miujs";
import { rateLimit } from "@miujs/ratelimit";

const login = route.post("/auth/login", { name: "auth_login", handler: () => ({ ok: true }) });
const items = route.get("/api/items", { name: "items", handler: () => ({ items: [] }) });

const app = miu({
  name: "ratelimit-demo",
  routes: [login, items],
  plugins: [
    rateLimit({
      rules: [
        { name: "login", match: { route: "auth_login" }, limit: 10, window: "15m", by: "ip" },
        { name: "api", match: { path: "/api/*" }, limit: 100, window: "1m" },
      ],
    }),
  ],
});
export default app;
```

Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` for the matching rule with the fewest requests left.

## Rules

- `match` takes `route` (route name), `path` (`/api/*` matches the path and everything below; `:param` and `*` match one segment), `method` and `tag`. Every given key must match; a list matches any of its entries. A rule without `match` applies to every request.
- `by` is `"ip"`, `"user"` (signed-in user, else IP), `"apiKey"` (`x-api-key` or `Authorization: Bearer`, hashed; else IP; a key with no signed-in user behind it also counts against the client's IP, so made-up keys cannot buy a fresh bucket per request) or `(ctx) => string | null`. Returning `null` exempts the request.
- `window` is seconds or `"10s"`, `"1m"`, `"15m"`, `"1h"`, `"1d"`.
- Rules with `by: "user"` need `auth()` listed before `rateLimit()` in `plugins`; otherwise setup fails with `MIU_E_RATELIMIT_ORDER`.
- Behind a proxy, set `trustProxyHeader` (e.g. `"x-forwarded-for"`). The rightmost address is used. Never name a header clients can set directly.

### Algorithms

| Algorithm | Behavior |
| --- | --- |
| `"sliding"` (default) | Weighted sliding window over the current and previous window. |
| `"fixed"` | Counter reset at each window boundary. |
| `"token-bucket"` | Refills `limit` tokens per `window`; `burst` sets the capacity. |

## limiter() outside routes

<!-- test -->
```ts
import { limiter } from "@miujs/ratelimit";

const perPlayer = limiter({ limit: 20, window: "1s", algorithm: "token-bucket", burst: 40, name: "player" });

const result = await perPlayer.check("player:42");
if (!result.allowed) console.log(`retry in ${result.retryAfter}s`);

await perPlayer.reset("player:42");
```

`check(key, { env, cost })` returns the decision plus `retryAfter` (seconds, 0 when allowed) and `reset` (seconds until the window resets). On Workers pass `env` so binding-based stores can find their binding.

## Stores

| Store | Exact | Algorithms | Runtimes |
| --- | --- | --- | --- |
| `memoryStore({ maxKeys })` | per process | all | all (per isolate on Workers) |
| `redisStore(client, { prefix })` | yes | fixed, sliding | any with a Redis client |
| `kvStore(binding, { prefix })` | no (eventually consistent) | all | Workers |
| `durableObjectStore(binding)` | yes | all | Workers |
| `cloudflareBindingStore(binding, { limit, period })` | no (per location) | fixed, sliding; `cost` 1 | Workers |

A rule a store cannot enforce fails at startup with `MIU_E_RATELIMIT_UNSUPPORTED`.

`redisStore` accepts ioredis, Upstash, Bun's client (`incrby`, `pexpire`, `get`) or node-redis v4 (`incrBy`, `pExpire`, `get`); `del` is needed for `reset`.

<!-- test -->
```ts
import { miu } from "miujs";
import { durableObjectStore, rateLimit } from "@miujs/ratelimit";

export { RateLimiterDurableObject } from "@miujs/ratelimit";

export default miu({
  name: "edge-limits",
  plugins: [
    rateLimit({
      store: durableObjectStore(),
      trustProxyHeader: "cf-connecting-ip",
      headers: "draft-8",
      rules: [{ match: { path: "/api/*", method: "POST" }, limit: 30, window: "1m", algorithm: "token-bucket", burst: 10 }],
    }),
  ],
});
```

### With @miujs/auth

```ts
auth({ rateLimit: { limiter: asAuthLimiter(durableObjectStore()) } });
```

`asAuthLimiter(store)` uses fixed windows, like auth's own limiter.

## Options

`rateLimit(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rules` | `RateLimitRule[]` | required | At least one rule. |
| `store` | `RateLimitStore` | `memoryStore()` | Where counters live. |
| `keyBy` | `By` | `"ip"` | Identity for rules without `by`. |
| `trustProxyHeader` | `string` | none (`ctx.ip`) | Proxy header holding the client IP; rightmost entry used. |
| `headers` | `"draft-6" \| "draft-8" \| false` | `"draft-6"` | `RateLimit-*` headers, or `RateLimit` + `RateLimit-Policy`, or none. |
| `onStoreError` | `"deny" \| "allow"` | `"deny"` | On store failure: 503, or log and allow. |
| `now` | `() => number` | `Date.now` | Clock, for tests. |

Rule fields:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `rule_<n>` | Counter and policy name. Letters, digits, `_ . -`. |
| `match` | `{ route?, path?, method?, tag? }` | every request | Which requests the rule counts. |
| `limit` | `number` | required | Requests (or cost units) per window. |
| `window` | `number \| string` | required | Seconds, or `"1m"` style. |
| `algorithm` | `"fixed" \| "sliding" \| "token-bucket"` | `"sliding"` | Counting algorithm. |
| `burst` | `number` | `limit` | Token bucket capacity. |
| `cost` | `number` | `1` | Units each request costs. |
| `by` | `By` | plugin `keyBy` | Who the rule counts. |

`limiter(options)` takes `limit`, `window`, `algorithm` (default `"sliding"`), `burst`, `store` (default `memoryStore()`), `name` (default `"limiter"`, the key prefix) and `now`.

Store options: `memoryStore` `maxKeys` (default `100000`); `kvStore` and `redisStore` `prefix` (default `"ratelimit:"`); `durableObjectStore` binding (default `"RATE_LIMITER"`); `cloudflareBindingStore` `limit`, `period` (10 or 60) and optional `namespaceId`.

## Admin (`manage()`)

With `@miujs/admin`, `rateLimit()` shows a **Rate limits** section:

- **Status**: store, number of rules, keys tracked (memory store only; other stores say they cannot count), 429s and store errors in this instance since it started, and a table of rules with their rejections.
- **Settings**: `limit` and `window` per rule (e.g. `{ api: { limit: 200, window: "1m" } }`). They apply at once in this instance; the admin persists them and re-applies them on start. A value the store cannot enforce (e.g. a Cloudflare binding's fixed limit) is rejected and nothing changes. Lowering a limit can start affected clients on a fresh window.
- **Limited clients** list (memory store only; paged, search, filter limited/all). API keys appear only as their hash. Row action: reset.
- **Action** `resetKey`: forget one client (`ip:203.0.113.7`, `user:<id>`, `key:<hash>`) for a rule. Not available on `cloudflareBindingStore()`, which cannot reset.

Counters are per instance; `limiter()` instances are not part of the plugin and do not appear.

## Errors

- [`MIU_E_RATE_LIMITED`](../../docs/errors.md#miu_e_rate_limited): 429, the request exceeded a rule; see `Retry-After`.
- [`MIU_E_RATELIMIT_CONFIG`](../../docs/errors.md#miu_e_ratelimit_config): invalid rule, window, algorithm or option.
- [`MIU_E_RATELIMIT_UNSUPPORTED`](../../docs/errors.md#miu_e_ratelimit_unsupported): the store cannot enforce a rule, or cannot reset keys.
- [`MIU_E_RATELIMIT_ORDER`](../../docs/errors.md#miu_e_ratelimit_order): a `by: "user"` rule but `auth()` is listed after `rateLimit()`.
- [`MIU_E_RATELIMIT_BINDING`](../../docs/errors.md#miu_e_ratelimit_binding): KV, Durable Object or rate limiting binding missing.
- [`MIU_E_RATELIMIT_STORE`](../../docs/errors.md#miu_e_ratelimit_store): 503, the store failed and `onStoreError` is `"deny"`.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

`memoryStore()` counts per isolate on Workers (the plugin logs a warning outside dev). Use one of the Workers stores; each reports its binding to `miu deploy cloudflare`.

`durableObjectStore()` (exact) needs the class exported from your Worker entry, as in the example above, and a binding:

```toml
[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterDurableObject"
```

`kvStore("RL_KV")` needs a KV namespace (`[[kv_namespaces]] binding = "RL_KV"`). It is approximate and allows about one write per second per key.

`cloudflareBindingStore("RL", { limit: 100, period: 60 })` uses Cloudflare's Rate Limiting binding. Every rule using it must have the same `limit` and `window`:

```toml
[[ratelimits]]
name = "RL"
namespace_id = "1001"
simple = { limit = 100, period = 60 }
```

`redisStore` works wherever your Redis client does (e.g. Upstash over HTTP on Workers).

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/cache](../cache/README.md), [@miujs/queue](../queue/README.md), [@miujs/db](../db/README.md)
