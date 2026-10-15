# @miujs/bots

> Bot, AI crawler and visitor-location detection for MiuJS, with a per-visitor policy that blocks, trims, or serves cached responses so crawlers never reach your handlers or database.

`@miujs/bots` adds `ctx.visitor` to every request: what kind of client it is (`human`, `search`, `ai`, `bot` or `unknown`), its name (`GPTBot`, `Googlebot`, `curl`), whether Cloudflare verified it, its bot score, and its country, region, city and network. A policy then decides what each visitor gets: `full` (the handler runs), `partial` (the handler runs and the JSON body is trimmed), `cached` (a stored response, the handler runs once per URL per hour), or `block`. Signals come from Cloudflare first (`request.cf` on Workers, trusted `cf-*` headers behind Cloudflare elsewhere), then the User-Agent, then the headers real browsers send.

## Install

```bash
bun add @miujs/bots miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

With no options, humans get full access and every other visitor gets cached GET and HEAD responses: the first crawler request for a URL runs the handler, the rest are served from memory for an hour.

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { bots } from "@miujs/bots";

let queries = 0;

export const getPost = route.get("/posts/:id", {
  params: t.object({ id: t.string() }),
  handler: ({ params, visitor }) => {
    queries++; // stands in for a database query
    return { id: params.id, title: "Hello", servedTo: visitor.kind };
  },
});

const app = miu({ name: "blog", routes: [getPost], plugins: [bots()] });
export default app;

const crawler = { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" } };
const first = await app.fetch(new Request("http://localhost/posts/1", crawler));
console.log(first.headers.get("x-miu-bot-cache")); // "miss": the handler ran
await first.text();
await app.drain(); // the copy is stored in the background
const second = await app.fetch(new Request("http://localhost/posts/1?utm_source=feed", crawler));
console.log(second.headers.get("x-miu-bot-cache"), queries); // "hit" 1
```

Responses carry `x-miu-bot-cache: miss | hit | stale` when the bot cache was used.

## Visitors

`ctx.visitor` is set on every request, before validation and auth checks:

| Field | Description |
| --- | --- |
| `kind` | `"human"`, `"search"` (verified search engine), `"ai"`, `"bot"` or `"unknown"`. |
| `name` | The agent, e.g. `"GPTBot"`, `"ClaudeBot"`, `"Googlebot"`, `"curl"`, `"AhrefsBot"`. |
| `verified` | Cloudflare (`verifiedBot`) or your `verify` hook confirmed the claim. |
| `score` | Cloudflare bot score, 1–99 (lower is more bot-like). Needs Bot Management. |
| `country`, `region`, `city`, `continent`, `asn`, `asOrg` | Location from Cloudflare. `country` is ISO 3166-1 alpha-2 (`T1` is Tor). |
| `access` | What this request gets: `"full"`, `"partial"`, `"cached"` or `"block"`. |

How the kind is decided, strongest signal first:

1. A User-Agent naming an AI agent or automation tool (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Bytespider`, `curl`, `python-requests`, `HeadlessChrome`, any `...bot`/`crawler`/`spider`/`scraper`) is `ai` or `bot`. A good score never upgrades a client that says it is a bot.
2. A User-Agent claiming a search engine (`Googlebot`, `Bingbot`, `DuckDuckBot`, `Applebot`, `YandexBot`, `Baiduspider`) is `search` only when verified, else `bot`. Anyone can send `Googlebot` in a header.
3. Cloudflare verified bots get their kind from `verifiedBotCategory` (AI categories are `ai`, "Search Engine Crawler" is `search`, others `bot`). A bot score below `botScoreThreshold` (default 30) is `bot`.
4. A browser User-Agent is `human` when Cloudflare scored it (30 or more) or passed JavaScript detection; otherwise it must send `accept-language`, and Chromium 80+ and Firefox 90+ must also send `sec-fetch-mode` on secure origins (https, `x-forwarded-proto: https`, or localhost; Chrome omits `sec-fetch-*` on plain http). Safari is not required to send them. A browser User-Agent failing these is `unknown`.
5. No User-Agent, or one that is neither a browser nor a known agent, is `unknown`.

The header checks only catch careless clients: a crawler that copies every browser header looks human. For real detection, put the site behind Cloudflare and turn on Bot Fight Mode (free) or Bot Management (bot scores), plus AI Crawl Control to see and block AI crawlers at the edge.

The agent list is exported as `AGENTS` (`AI_AGENTS`, `SEARCH_AGENTS`, `AUTOMATION_AGENTS`) and replaceable with `bots({ agents })`. `classifyUserAgent(ua)` and `detectVisitor(request, { runtime })` work outside the plugin. Classification is one precompiled regex over the list (plus one for generic automation words) and is memoized per User-Agent string in a bounded LRU.

## Blocking AI crawlers

<!-- test -->
```ts
import { miu, route } from "miujs";
import { bots } from "@miujs/bots";

const app = miu({
  routes: [route.get("/articles", { handler: () => ({ articles: [] }) })],
  plugins: [
    bots({
      policy: { ai: "block" },
      robots: { disallowAI: true, disallow: ["/admin"], sitemap: "https://example.com/sitemap.xml" },
      xRobotsTag: "noai, noimageai",
    }),
  ],
});

const res = await app.fetch(new Request("http://localhost/articles", { headers: { "user-agent": "ClaudeBot/1.0" } }));
console.log(res.status); // 403, error code MIU_E_BOT_BLOCKED
```

Blocked requests get `MIU_E_BOT_BLOCKED` with status `blockStatus` (403 by default; 404, 410, 429 with `Retry-After`, or 451) and a debug log line. `robots` serves `GET /robots.txt`: one group disallowing `/` for every AI agent in the list plus the robots-only opt-out tokens (`Google-Extended`, `Applebot-Extended`, ...), then your rules for everyone else. robots.txt is a request; `block` is enforcement.

## Partial data for bots

<!-- test -->
```ts
import { miu, route } from "miujs";
import { bots, pickFields } from "@miujs/bots";

export const listProducts = route.get("/products", {
  name: "listProducts",
  handler: ({ visitor }) => {
    // Read access yourself to skip expensive work...
    const withStock = visitor.access === "full";
    return { items: [{ id: 1, name: "Lamp", price: 30, stock: withStock ? 4 : undefined }] };
  },
});

export const getProduct = route.get("/products/:id", {
  handler: ({ params }) => ({ id: params.id, name: "Lamp", price: 30, supplier: "ACME", margin: 0.4 }),
});

miu({
  routes: [listProducts, getProduct],
  plugins: [
    bots({
      policy: { search: "partial", bot: "partial", unknown: "partial" },
      routes: [
        // ...or let the plugin trim the JSON body: a list of top-level fields, or a function.
        { match: { route: "listProducts" }, partial: (data: any) => ({ items: pickFields(data.items, ["id", "name"]) }) },
        { match: { path: "/products/:id" }, partial: ["id", "name", "price"] },
      ],
    }),
  ],
});
```

Partial GET responses are cached too, under a key separate from `cached` ones.

### Per-route settings

Set them on the route with the typed `bots` option (`false` exempts the route), or from the plugin with `routes` entries:

<!-- test -->
```ts
import { miu, route } from "miujs";
import { bots } from "@miujs/bots";

export const members = route.get("/members", {
  bots: { policy: { ai: "block", bot: "block" } },
  handler: () => ({ members: [] }),
});
export const status = route.get("/status", { bots: false, handler: () => ({ up: true }) });
export const card = route.get("/cards/:id", {
  bots: { policy: { bot: "partial" }, partial: ["id", "title"], ttl: 600 },
  handler: ({ params }) => ({ id: params.id, title: "Card", body: "..." }),
});

miu({ routes: [members, status, card], plugins: [bots({ routes: [{ match: { path: "/admin/*" }, policy: { ai: "block" } }] })] });
```

The route option takes `policy`, `exempt`, `partial` and `ttl`, and wins over any matching `routes` entry. An invalid one fails that route's requests with `MIU_E_BOTS_CONFIG`. Route rules match like `@miujs/ratelimit` rules (`route`, `path`, `method`, `tag`; `/blog/*` is the path and everything below); the first match applies. A route rule can also set `policy` (e.g. `{ ai: "block" }` on one route), `exempt: true` (full access for everyone) and `ttl`.

## Per-country rules

<!-- test -->
```ts
import { miu, route } from "miujs";
import { bots } from "@miujs/bots";

export const home = route.get("/", {
  handler: ({ visitor }) => ({ greeting: visitor.country === "VN" ? "Xin chào" : "Hello", city: visitor.city ?? null }),
});

export default miu({
  routes: [home],
  plugins: [
    bots({
      trustCloudflare: true, // Bun/Node behind Cloudflare only; Workers read request.cf automatically
      blockCountries: ["KP"],
      rules: [
        { when: (v) => v.verified, action: "cached" }, // verified crawlers are never country-blocked
        { when: (v) => v.kind === "ai" && v.country === "CN", action: "block" },
      ],
      cache: { varyByCountry: true },
    }),
  ],
});
```

The decision order is: always-exempt routes (`/_miu/*`, the MCP endpoint, `/robots.txt`), a route rule with `exempt`, `rules` in order, `blockCountries`, `allowCountries` (visitors with no known country are not blocked), signed-in users (full), the route rule's `policy`, then `policy`.

## Signed-in users and what is never cached

List `auth()` before `bots()` (startup fails with `MIU_E_BOTS_ORDER` otherwise). A request with `ctx.user` bypasses kind-based caching, partial trimming and blocking, whatever its User-Agent; `rules` and country lists still apply. The bot cache only serves and stores:

- GET (HEAD is answered from the GET entry, never stored) on a matched route, without `Authorization` or `Upgrade` headers;
- responses with a status in `cache.statuses` (default 200), no `Set-Cookie` (including `ctx.cookies.set`), no `Cache-Control: private | no-store | no-cache`, no `Vary` other than `Accept-Encoding`, not `text/event-stream`, at most `maxEntryBytes`.

The key is `GET` + access level + host + path + sorted query without tracking parameters (`TRACKING_PARAMS`: `utm_*`, `gclid`, `fbclid`, `msclkid`, `ref`, ...), plus the country with `varyByCountry` and your `varyBy(ctx)`. Concurrent misses for one key run the handler once; the others wait for its response, for up to `cache.waitMs` (default 10000 ms). After that they run the handler themselves rather than hang behind a stuck request; the first request still finishes and stores its response. With `staleWhileRevalidate`, an expired copy is served (`x-miu-bot-cache: stale`) while one background request refreshes it.

## Budgets

Cap how often each kind may reach your handlers with a `limiter()` from `@miujs/ratelimit`. Cache hits are free; requests are counted per agent name (all GPTBot traffic shares one budget), else per IP.

```ts
import { limiter } from "@miujs/ratelimit";
bots({ budget: { ai: limiter({ limit: 60, window: "1m", name: "ai" }), unknown: limiter({ limit: 600, window: "1m", name: "unknown" }) } });
```

Over budget: 429 `MIU_E_RATE_LIMITED` with `Retry-After`.

## Stores

| Store | Shared by | Notes |
| --- | --- | --- |
| `memoryBotStore({ maxEntries, maxBytes })` | one process / isolate | Default. LRU, 1000 entries and 32 MiB by default. |
| `cacheClientStore()` | everything on the same backend | Uses `ctx.cache` from `@miujs/cache` (KV on Workers, Redis, memory). List `cache()` first. Long keys are hashed. |
| `cacheApiStore()` | one Cloudflare data center | Workers Cache API (`caches.default`), no binding needed. |

On Workers without `cache.store`, the plugin uses `ctx.cache` when `@miujs/cache` is listed first, else the Cache API, else memory. A store is `{ name, get(key, ctx), set(key, entry, ctx), delete?, size?, bytes?, purge?, inspect?, cloudflare? }`.

## Options

`bots(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `policy` | `{ [kind]: Access }` | human `full`, others `cached` | Action per visitor kind. |
| `rules` | `{ when(visitor, ctx), action }[]` | `[]` | Checked first; first match decides. |
| `blockCountries` | `string[]` | none | Countries that are blocked. |
| `allowCountries` | `string[]` | none | Only these countries (unknown country passes). |
| `routes` | `BotRouteRule[]` | `[]` | Per-route `policy`, `exempt`, `partial`, `ttl` by `match`; the route's own `bots` option wins. |
| `partial` | `string[] \| (data, ctx) => unknown` | none | Default trimming for partial visitors. |
| `agents` | `AgentEntry[]` | `AGENTS` | Known agents: `{ token, kind, name? }`. |
| `trustCloudflare` | `boolean` | `false` | Read `cf-*` headers off Workers. Only when all traffic comes through Cloudflare. |
| `botScoreThreshold` | `number` | `30` | Cloudflare scores below it are bots. |
| `strictHeaders` | `boolean` | `false` | Require `sec-fetch-*` on plain http too. |
| `verify` | `(req, { kind, name }) => boolean` | none | Confirm a search/AI claim Cloudflare did not (e.g. reverse DNS). |
| `blockStatus` | `403 \| 404 \| 410 \| 429 \| 451` | `403` | Status of blocked responses. |
| `cache` | `BotsCacheOptions \| false` | memory | `store`, `ttl` (3600 s), `staleWhileRevalidate` (0), `statuses` ([200]), `maxEntryBytes` (1 MiB), `waitMs` (10000), `varyByCountry`, `ignoreParams`, `varyBy`. `false`: cached visitors reach handlers. |
| `robots` | `boolean \| RobotsOptions` | off | Serve `/robots.txt`: `disallowAI` (true), `disallow`, `allow`, `sitemap`, `extra`. |
| `xRobotsTag` | `string \| (visitor) => string` | none | `X-Robots-Tag` on responses without one. |
| `budget` | `{ [kind]: limiter }` | none | Rate limits on handler-reaching requests. |
| `now` | `() => number` | `Date.now` | Clock, for tests. |
| `timers` | `{ set(fn, ms), clear(handle) }` | `setTimeout` / `clearTimeout` | Timers for `waitMs`, for tests. |

`miu inspect` shows the policy, cache settings and counters by kind, by action and for the cache (hit, stale, miss, coalesced, stored, skipped, waitTimeouts).

## Admin (`manage()`)

With `@miujs/admin`, `bots()` shows a **Bots** section:

- **Status**: requests by kind and by decision, blocked and over-budget counts, and the bot cache: store, entries and size (memory store; other stores say they cannot count), hits, misses, hit rate, stale served, stored, not stored, errors and wait timeouts. Counters are per instance since it started.
- **Settings**: `policy` per kind, `blockCountries`, `allowCountries` (empty = no restriction), `botScoreThreshold` (1–99) and `cacheTtl` (when the cache is on). They apply at once in this instance; the admin persists them and re-applies them on start.
- **Recently blocked** list: the last 200 blocked visits in this instance (time, kind, agent, country, path without the query string, and the reason: policy, route policy, rule n, country blocked, country not allowed). Filter by kind; search agent, country or path.
- **Actions**: `purgeCache` (danger; all or under a path prefix, memory store only), `purgeUrl` (one page on any store with `delete`; on KV or the Cache API, entries varied by country or `varyBy` cannot be found), and `classifyUserAgent` (what a User-Agent claims and the access its kind gets; nothing is verified without Cloudflare or `verify`).

## Errors

- [`MIU_E_BOT_BLOCKED`](../../docs/errors.md#miu_e_bot_blocked): the policy blocked this visitor (status `blockStatus`).
- [`MIU_E_BOTS_CONFIG`](../../docs/errors.md#miu_e_bots_config): an invalid option, or a store used where it cannot work.
- [`MIU_E_BOTS_ORDER`](../../docs/errors.md#miu_e_bots_order): `auth()` is listed after `bots()`.
- [`MIU_E_RATE_LIMITED`](../../docs/errors.md#miu_e_rate_limited): a `budget` limiter is exhausted.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

On Workers, `request.cf` gives location, ASN and (with Bot Management) `botManagement.score`, `verifiedBot`, `verifiedBotCategory` and `jsDetection.passed`; nothing needs configuring. Turn on Bot Fight Mode or Bot Management and AI Crawl Control in the dashboard so most bad traffic never reaches the Worker, and use this plugin for what gets through. Each isolate has its own memory store: use `cacheClientStore()` with a KV-backed `cache()` (binding `CACHE`) or `cacheApiStore()` to share cached responses. On Bun, Deno or Node behind Cloudflare (proxy or Tunnel), enable the "Add visitor location headers" and "Add bot protection headers" managed transforms and set `trustCloudflare: true`; never set it when clients can reach the origin directly.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/cache](../cache/README.md), [@miujs/ratelimit](../ratelimit/README.md), [@miujs/auth](../auth/README.md)
