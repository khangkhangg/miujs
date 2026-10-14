# MiuJS Roadmap

Positioning: **about as fast as Elysia, runs anywhere like Hono, and every route is automatically an agent tool.**

## 1. Analysis

| Framework | Strength | Gap MiuJS targets |
| --- | --- | --- |
| Hono | Runs on every runtime, tiny, Web-standard | Validation, OpenAPI and MCP are separate add-ons; no batteries |
| Elysia | Very fast on Bun, end-to-end types | Bun-first; Workers/Node support is secondary |
| Express / Fastify | Huge ecosystem | Node-only, not edge-ready, no agent story |
| Laravel / Django / FastAPI | Batteries included (auth, queues, ORM) | Not JS; slow to port to the edge |
| NestJS | Structure for big teams | Heavy; decorators; not edge-native |

**Opportunity:** no framework treats *agents as first-class clients*. A route declared once should serve a
browser, an OpenAPI client and an LLM with the same auth, validation and errors. Combined with batteries
(auth, sessions, cache, queues) that default to SQLite and scale to Cloudflare/Redis, and a migration kit for
PHP/Python apps, MiuJS can be the easiest path from a legacy app to an AI-ready edge app.

## 2. Approaches considered

1. **Web-standard core + adapters (chosen).** Core speaks only `Request`/`Response`; thin adapters for Node.
   Same code on Bun, Workers, Deno, Node. Matches Hono's portability; speed comes from a trie router and
   avoiding work (lazy URL/cookie parsing, no body read without a schema).
2. **Bun-native core with compile-time codegen (Elysia-style).** Fastest on Bun, but ties the core to Bun
   APIs and makes Workers a second-class target. Kept as an *optional* optimization later (precompiled
   route handlers) rather than the foundation.
3. **Wrap an existing framework (e.g. Hono + plugins).** Fastest to ship, but MCP/OpenAPI/validation would stay
   bolted on, which is the gap we want to close. Rejected for the core; Hono-compatible middleware shims are a
   later nice-to-have.

## 3. Phases

| Phase | Goal | Status |
| --- | --- | --- |
| 1. Core | Router, schemas, context, middleware, errors, OpenAPI, MCP, Node adapter | **Done (v0.1)** |
| 2. Batteries | Auth, sessions, cache, rate limit, CORS, logger, queues — SQLite default | **Done (v0.2)** |
| 3. Cloudflare | D1/KV/R2/Queues/Durable Objects/Workflows/Hyperdrive adapters | **Done (v0.3)** |
| 4. Realtime | WebSockets + rooms (Bun native & Durable Objects) for games / Kahoot-style apps | **Done (v0.3)** |
| 5. Migration kit | Reverse proxy, shared PHP/Python sessions, contract tests, DB introspection | **Done (v0.3)** |
| 6. DX & launch | CLI, templates, `llms.txt`, client, benchmarks, guides | **Mostly done (v0.3)** — 1.0 items open |
| 7. Toward 1.0 | Compiled build, typed client, Node WebSockets, Elysia-level perf, security/scale drivers, DevTools debugging, CI | In progress |
| 8. App kits | Schema-driven admin back-office; virtual-tour kit (panoramas, hotspots, uploads, viewer) | Planned |

## 4. File structure

```
miujs/
├── src/
│   ├── index.ts              # public API
│   ├── core/
│   │   ├── app.ts            # Miu class: routing, middleware, input validation, errors   ✅
│   │   ├── router.ts         # segment-trie router                                         ✅
│   │   ├── context.ts        # per-request Context                                         ✅
│   │   ├── schema.ts         # `t` builder, validation, JSON Schema, Standard Schema       ✅
│   │   └── errors.ts         # HttpError, ValidationError, problem+json                    ✅
│   ├── ai/
│   │   ├── mcp.ts            # MCP server: routes -> tools                                 ✅
│   │   ├── openapi.ts        # OpenAPI 3.1 generator                                       ✅
│   │   ├── shared.ts         # operation ids, path helpers                                 ✅
│   │   └── llms.ts           # llms.txt generator                                          ✅
│   ├── adapters/
│   │   ├── node.ts           # node:http adapter                                           ✅
│   │   └── cloudflare/       # KV/D1/DO stores, Queues, R2, Workflows, Hyperdrive          ✅
│   ├── sqlite.ts             # "miujs/sqlite" entry (native SQLite drivers)                ✅
│   ├── batteries/
│   │   ├── store/            # Store interface, memory + sqlite drivers                    ✅
│   │   ├── session.ts        # signed-cookie sessions                                      ✅
│   │   ├── auth/             # password, jwt, api-keys, auth middleware                    ✅
│   │   ├── queue/            # jobs: memory + sqlite drivers, worker                       ✅
│   │   ├── cors.ts, secure-headers.ts, request-id.ts, logger.ts                            ✅
│   │   ├── rate-limit.ts, cache.ts                                                         ✅
│   │   └── sqlite.ts         # shared bun:sqlite / node:sqlite opener                      ✅
│   ├── realtime/             # app.ws backends, rooms, MiuRoom DO, game engine             ✅
│   ├── migrate/              # proxy, PHP/Django sessions, bcrypt, contracts, introspection ✅
│   ├── client/               # HTTP + MCP client                                           ✅
│   └── cli/                  # miu CLI (bin/miu.ts)                                        ✅
├── test/                     # bun test suites (one per module)
├── examples/                 # basic.ts, node.ts, cloudflare/worker.ts
├── bin/miu.ts                # CLI entry                                                   ✅
├── templates/                # bun / node / workers starters                               ✅
├── bench/                    # vs Hono / Elysia (network + in-process)                     ✅
└── docs/ROADMAP.md
```

## 5. Feature checklist

### Phase 1 — Core ✅
- [x] Trie router: static > param > wildcard priority, HEAD→GET, `ALL`, 405 + `Allow`
- [x] `t` schema builder with type inference, coercion, defaults, unknown-key stripping
- [x] JSON Schema output (draft 2020-12 compatible)
- [x] Standard Schema interop (zod / valibot / arktype)
- [x] Context: params, query, body, env, executionCtx, vars, cookies, response helpers
- [x] JSON, form-urlencoded and multipart bodies; 400 on malformed JSON, 415 on unknown types
- [x] Onion middleware, path-scoped middleware, per-route middleware, short-circuit
- [x] RFC 9457 errors; 422 validation issues with paths; 500s never leak messages
- [x] `onError`, `notFound`, sub-app mounting with `route(prefix, app)`
- [x] OpenAPI 3.1 generator + `openapi()` endpoint
- [x] MCP server: tools/list, tools/call through full pipeline, annotations, outputSchema
- [x] Node adapter (streaming bodies, multiple Set-Cookie)
- [x] Bun `listen()`, Workers `fetch(req, env, ctx)` signature
- [x] Source runs on Node 22 with type stripping (`erasableSyntaxOnly`)

### Phase 2 — Batteries ✅
- [x] `Store` interface (get/set/delete/has/incr/ttl/prefix) + memory and SQLite (`bun:sqlite` / `node:sqlite`) drivers
- [x] Sessions: signed session id cookie, key rotation, store-backed, lazy load, save-on-change, flash, regenerate, destroy
- [x] Passwords: PBKDF2-SHA256, Django-compatible hash format, `needsRehash`
- [x] Auth: `auth()`, `login`/`logout`, `requireAuth()` (401 problem+json for agents, redirect for HTML)
- [x] API keys (hashed at rest) + HS256 JWT sign/verify, WebCrypto only
- [x] CORS, security headers, request id, structured logger
- [x] Rate limiter (fixed window) on any Store with `RateLimit-*` headers
- [x] Cache: `cache()` middleware + `remember(store, key, ttl, fn)` with in-flight coalescing
- [x] Queue: `define`/`dispatch`, retries with backoff, timeouts, dedupe keys, memory + SQLite drivers, worker loop
- [x] Errors resolve inside the middleware chain so CORS/request-id/logging apply to error responses
- [x] `miujs/sqlite` entry point keeps native SQLite out of edge bundles

**Follow-ups (from Phase 2 review)**
- [ ] Verify bcrypt (`$2y$`) hashes from PHP apps; EdDSA/RS256 JWT
- [ ] OAuth 2.1 resource-server metadata for MCP auth
- [ ] Token-bucket / sliding-window rate limit option
- [ ] Queue: fence `complete`/`fail` with a lock token so a reclaimed long job can't be double-completed
- [ ] Queue: cap `runOnce()` iterations (zero-backoff unlimited retries loop today); dedupe across running jobs
- [ ] Redis store + queue drivers

### Phase 3 — Cloudflare ✅
- [x] Store drivers: Workers KV (exact expiry via metadata), D1 (atomic incr), Durable Object (`MiuStoreObject`, `doStore`)
- [x] Cloudflare Queues: `cloudflareQueue` producer + `queueConsumer` reusing Miu job definitions
- [x] R2: `r2Files` (ETag/304, Range/206) and multipart `uploadHandler`; `hyperdriveUrl`
- [x] Workflows: `defineWorkflow` with validated params; `toWorker()` export helper
- [x] `miu wrangler` generates wrangler.toml with bindings
- [x] Bindings accepted as getters (Workers `env` exists per request)

### Phase 4 — Realtime ✅
- [x] `app.ws(path, meta, handlers)`: middleware + validation before upgrade, typed `ws.data`, 426 for plain requests
- [x] Bun backend (native pub/sub, `export default app` support) and Workers backend (`WebSocketPair`)
- [x] Room hub with presence; `MiuRoom` Durable Object (hibernation API) + `roomRoute()`
- [x] `createGame` Kahoot-style engine (speed scoring, streaks, reveal/leaderboard); `examples/quiz`

### Phase 5 — Migration kit ✅
- [x] `legacyProxy` / `legacyFallback` strangler proxy (streams, cookies, manual redirects, Location rewrite)
- [x] PHP `serialize` + sessions (`php`, `php_serialize`) and Django signed/DB sessions, read-only bridges
- [x] Pure-TS bcrypt (`$2a/$2b/$2y`) + `verifyLegacyPassword` (Django bcrypt/pbkdf2, opt-in md5/sha1)
- [x] `recordContract` / `verifyContract` response diffing
- [x] Introspection for SQLite/MySQL/Postgres/Mongo → `t` schemas + CRUD route source; `miu introspect`

### Phase 6 — DX & launch
- [x] `miu` CLI: create (bun/node/workers templates), routes, openapi, llms, tools, wrangler, introspect
- [x] `llms.txt` + `llms-full.txt` generation (`llms()` middleware)
- [x] `miujs/client`: HTTP client + MCP client
- [x] Benchmarks vs Hono and Elysia (network + in-process), honest results in `bench/results.md`
- [x] Hot-path optimization (~2.5x in-process; Hono parity over the network)
- [x] Guides: `docs/guide.md`, `docs/deploy.md`
- [ ] Separate `create-miu` package so `bun create miu` works (today: `bunx miujs create`)
- [ ] Benchmarks in CI; Express comparison
- [ ] Docs site

### Phase 7 — Toward 1.0 ✅ (v0.4)
- [x] Compiled build (`dist/`, ESM + `.d.ts` + source maps); conditional exports (bun → src, Node/bundlers → dist); `miu` runs on plain Node
- [x] `create-miu` package (`bun create miu` / `npm create miu`)
- [x] Typed client: `Miu<E, R>` accumulates a route table; `createClient<typeof app>()` checks paths/params/query/body and infers output
- [x] Speed: server-only native text responses, Bun native routes via `app.serveOptions()`/`listen()` — ~90% of Elysia on simple GETs, ahead of Hono on JSON/POST
- [x] WebSockets on Node (zero-dependency RFC 6455 server with strict limits); `app.publish()` on Bun/Node/Workers
- [x] Cloudflare binding types verified against `@cloudflare/workers-types` (`typecheck:cf`)
- [x] Redis store + queue drivers (tested against real redis-server); queue dedupe across running jobs
- [x] MCP OAuth 2.1 protected-resource auth (`mcpAuth`); EdDSA/RS256/ES256 JWT + remote JWKS
- [x] Laravel encrypted cookie/session decoding
- [x] GitHub Actions CI (test, typecheck, Workers types, build, Node smoke, bundle checks, pack) + weekly bench
- [x] DevTools: `Server-Timing`, dev error pages, `/__miu` request inspector, dev logger, source maps, `--inspect` guide
- [x] `c.route` and `c.error` for logging and tooling
- [ ] Remaining: per-route compiled handlers for the last ~10% vs Elysia; Workers tests in workerd/Miniflare; Cloudflare Queues dedupe; SQLite datetime coercion in generated CRUD; typed `c.json()` output; PS256/ES384 JWT

### Phase 8 — App kits
- [ ] `miujs/admin`: back-office generated from `t` schemas (list/search/create/edit/delete, uploads, auth, roles)
- [ ] Virtual-tour kit: scenes (equirectangular panoramas), hotspots linking scenes, info points, tour publishing
- [ ] Image pipeline: uploads to local disk or R2, thumbnails/tiles, signed URLs
- [ ] Tour viewer (vanilla JS/WebGL, no build step) + editor for placing hotspots by clicking the panorama
- [ ] `miu create --template tour` and `--template admin`

## 6. Prompts per feature

Use these to drive each feature with Claude Code (TDD: failing test first).

1. **Store:** "Add `src/batteries/store/` with a `Store` interface (`get`, `set(key, value, { ttl })`, `delete`, `incr`) and memory + SQLite drivers that work on Bun (`bun:sqlite`) and Node (`node:sqlite`). Shared contract test suite run against both drivers."
2. **Sessions:** "Implement `sessions({ store, secret, cookie })` middleware: HMAC-signed session id cookie, lazy load, save only when changed, `c.session.get/set/flash/regenerate/destroy`. Test rotation and tampering."
3. **Auth:** "Add `auth/password.ts` (scrypt via WebCrypto-compatible lib), `login(c, user)`, `logout(c)`, and `requireAuth()` that 401s for JSON/agents and redirects for HTML. Make MCP tool calls honor it."
4. **API keys & JWT:** "Add `bearer()` middleware supporting hashed API keys in a Store and JWT verification (HS256, EdDSA) using WebCrypto only, so it runs on Workers."
5. **CORS/security/logger:** "Add `cors()`, `secureHeaders()`, `requestId()` and `logger()` middleware with tests for preflight, credentials and JSON log lines."
6. **Rate limit:** "Add `rateLimit({ store, limit, window, key })` returning 429 with `Retry-After` and RateLimit headers; tool errors explain the limit to agents."
7. **Cache:** "Add `cache({ ttl })` route middleware keyed on method+URL+vary headers, and `remember(key, ttl, fn)` helper on any Store."
8. **Queue:** "Add `defineJob(name, schema, handler)`, `queue.dispatch()`, retries with exponential backoff, SQLite driver with a polling worker, and Cloudflare Queues driver."
9. **Cloudflare stores:** "Implement Store drivers for Workers KV, D1 and a Durable Object, tested with Miniflare."
10. **WebSockets:** "Add `app.ws(path, { open, message, close })` working on Bun and Workers, with rooms and broadcast; Durable Object backed on Cloudflare."
11. **Migration proxy:** "Add `legacyProxy({ target })` that forwards unmatched routes to a PHP/Python origin, preserving cookies and streaming bodies."
12. **Session bridge:** "Read PHP serialized sessions from files/Redis/MySQL and Django sessions so users stay logged in across both apps."
13. **Introspection:** "Add `miu introspect <db-url>` that reads MySQL/Postgres/SQLite/MongoDB schemas and emits `t` schemas + CRUD routes."
14. **llms.txt:** "Generate `/llms.txt` from route metadata and README sections; add `llms()` middleware."
15. **Benchmarks:** "Add `bench/` comparing Miu, Hono and Elysia on Bun with oha/bombardier; publish results in README via CI."

### Phase 7 prompts
16. **Compiled build:** "Add a `bun build`/`tsc` emit step producing `dist/` ESM + `.d.ts` for every entry in package.json `exports`, point `exports`/`bin` at `dist/` with `types` conditions, and add a test that `node dist/bin/miu.js --version` works without type stripping."
17. **Typed client:** "Accumulate route types on `Miu` (method, path, input, output) through `.get/.post/...` return types, and make `createClient<typeof app>()` infer params/query/body/response per path. Keep `bunx tsc` time reasonable; add type tests with `@ts-expect-error`."
18. **Elysia-level GET speed:** "Precompile a per-route handler at registration (no middleware → direct call; constant-returning handlers cached as a cloned Response). Measure with `bench/micro.ts` and `bench/run.ts`; no behavior changes."
19. **Node WebSockets:** "Add an optional `ws`-based adapter in `miujs/node` that implements the `app.ws()` backend, with the same tests as Bun."
20. **CI:** "Add GitHub Actions: bun test, typecheck, Node 22 smoke scripts, Workers bundle checks for edge entry points, and a weekly benchmark job publishing `bench/results.md`."
