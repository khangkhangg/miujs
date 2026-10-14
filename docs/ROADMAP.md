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
| 2. Batteries | Auth, sessions, cache, rate limit, CORS, logger, queues — SQLite default | Next |
| 3. Cloudflare | D1/KV/R2/Queues/Durable Objects/Workflows/Hyperdrive adapters, realtime rooms | Planned |
| 4. Realtime | WebSockets + rooms (Bun native & Durable Objects) for games / Kahoot-style apps | Planned |
| 5. Migration kit | Reverse proxy, shared PHP/Python sessions, contract tests, DB introspection | Planned |
| 6. DX & launch | CLI (`create-miu`), docs site, `llms.txt`, benchmarks, 1.0 | Planned |

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
│   │   └── llms.ts           # llms.txt generator                                          ⏳
│   ├── adapters/
│   │   ├── node.ts           # node:http adapter                                           ✅
│   │   └── cloudflare/       # D1, KV, R2, Queues, DO bindings                             ⏳
│   ├── batteries/
│   │   ├── store/            # KV store interface: memory, sqlite, redis, cloudflare-kv    ⏳
│   │   ├── sessions.ts       ⏳   ├── auth/ (password, jwt, api-keys, oauth)               ⏳
│   │   ├── cache.ts          ⏳   ├── queue/ (sqlite, cloudflare-queues, redis)            ⏳
│   │   ├── cors.ts           ⏳   ├── rate-limit.ts                                         ⏳
│   │   └── logger.ts         ⏳
│   ├── realtime/             # websocket rooms, presence, broadcast                        ⏳
│   └── migrate/              # proxy, php/python session bridges, contract tests           ⏳
├── test/                     # bun test suites (one per module)
├── examples/                 # basic.ts, node.ts, cloudflare/worker.ts
├── bench/                    # vs Hono / Elysia / Express                                  ⏳
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

### Phase 2 — Batteries
- [ ] `Store` interface (get/set/delete/ttl/incr) + memory and SQLite (`bun:sqlite` / `node:sqlite`) drivers
- [ ] Sessions: signed cookie id, store-backed, rotation, flash messages
- [ ] Auth: password hashing (argon2/scrypt), login/logout helpers, `requireAuth()` middleware
- [ ] API keys + bearer JWT (HS256/RS256/EdDSA) for agents
- [ ] OAuth 2.1 resource-server metadata for MCP auth
- [ ] CORS, security headers, request id, structured logger
- [ ] Rate limiter (fixed window + token bucket) on any Store
- [ ] Cache: `cache()` middleware + `c.cache.remember(key, ttl, fn)`
- [ ] Queue: `defineJob`, retries with backoff, SQLite driver, worker loop

### Phase 3 — Cloudflare
- [ ] Store drivers: Workers KV, D1, Durable Object
- [ ] Queue driver: Cloudflare Queues (`queue()` export helper)
- [ ] R2 file helper; Hyperdrive Postgres helper
- [ ] Workflows wrapper for long-running agent tasks
- [ ] `miu deploy` → wrangler config generation

### Phase 4 — Realtime
- [ ] WebSocket routes (`app.ws(path, handlers)`) on Bun and Workers
- [ ] Rooms, broadcast, presence; Durable Object backing on Cloudflare
- [ ] Game-loop helpers (timed rounds, scoreboard) — Kahoot-style example

### Phase 5 — Migration kit
- [ ] Strangler reverse proxy: unmatched routes forwarded to the legacy PHP/Python app
- [ ] Read PHP (`PHPSESSID`, serialized) and Django/Flask sessions
- [ ] Contract tests: record legacy responses, replay against Miu routes
- [ ] DB introspection → `t` schemas + CRUD route scaffolds (MySQL, Postgres, SQLite, MongoDB)

### Phase 6 — DX & launch
- [ ] `bun create miu` / `npm create miu` templates (Bun, Node, Workers)
- [ ] `llms.txt` + `llms-full.txt` generation from routes
- [ ] Benchmarks vs Hono, Elysia, Express in CI
- [ ] Docs site, typed client (`miu/client`), 1.0 release

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
