# MiuJS

**Fast (ahead of Hono, ~90% of Elysia), secure by default, runs anywhere, and every route is automatically an agent tool.**

MiuJS is an open-source TypeScript web framework for Bun, Node and Cloudflare Workers, built for apps that
humans *and* AI agents use. Declare a route with a schema once, and you get:

- validated, typed handler input (params, query, JSON or form body, headers)
- an **MCP tool** that agents (Claude, ChatGPT, Cursor, …) can call — through the same auth and middleware as browsers
- an **OpenAPI 3.1** operation
- consistent **RFC 9457 problem+json** errors

> Status: **v0.5 — app kits.** Core, batteries, Cloudflare, realtime, migration kit, CLI, typed client, DevTools,
> plus a schema-generated admin back-office and a virtual-tour kit, validated by a reference app with end-to-end,
> browser and load tests (915 tests). See [docs/ROADMAP.md](docs/ROADMAP.md),
> [docs/guide.md](docs/guide.md), [docs/deploy.md](docs/deploy.md) and [docs/debugging.md](docs/debugging.md).

## Quick start

```bash
bunx miujs create my-app            # --template bun | node | workers
cd my-app && bun install && bun dev
```

Or by hand:

```ts
// app.ts — run with: bun app.ts
import { Miu, t, mcp, openapi, HttpError } from "miujs";

const app = new Miu({ name: "todo-api", version: "1.0.0" })
  .use(openapi()) // GET  /openapi.json
  .use(mcp())     // POST /mcp  — every route below is an agent tool
  .get(
    "/todos/:id",
    { summary: "Get a todo", params: t.object({ id: t.integer() }) },
    (c) => {
      if (c.params.id > 100) throw new HttpError(404, "Todo not found");
      return { id: c.params.id, title: "Buy milk" }; // c.params.id is a number
    },
  )
  .post(
    "/todos",
    { summary: "Create a todo", body: t.object({ title: t.string({ min: 1 }) }) },
    (c) => {
      c.status(201);
      return { id: 1, title: c.body.title };
    },
  );

export default app; // Bun auto-serves this on :3000
```

Ask an agent to call it:

```bash
curl -X POST localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"post_todos","arguments":{"title":"Ship it"}}}'
```

> **Bun note:** `app.listen(port)` (or `Bun.serve(app.serveOptions({ port }))`) is the fastest way to serve: it
> registers routes with Bun's native router. `export default app` also works (via `fetch`) — use one or the other.

## Runs anywhere

| Runtime            | How                                                                 |
| ------------------ | ------------------------------------------------------------------- |
| Bun                | `export default app` or `app.listen(3000)`                          |
| Node 22+           | `import { serve } from "miujs/node"; await serve(app, { port })`    |
| Cloudflare Workers | `export default app` — `app.fetch(request, env, ctx)` is the Workers signature |
| Deno / Vercel / Netlify | anything that accepts a `(Request) => Response` handler: `app.fetch` |

The source uses only erasable TypeScript syntax, so Node 22 can run it directly with `--experimental-strip-types`.

## Guide

### Routes and handlers

```ts
app.get(path, handler)
app.get(path, meta, handler)        // also post, put, patch, delete, options, all
```

Handlers return a value and Miu picks the response: object → JSON, string → `text/plain`, `undefined` → 204,
`Response` → sent as-is. Paths support `:params`, static-over-param priority, and a trailing `*` wildcard.

### Schemas (`t`)

```ts
t.string({ min, max, pattern, format: "email" | "uuid" | "url" | "date" | "date-time" })
t.number({ min, max }) · t.integer() · t.boolean() · t.literal(v) · t.enum([...])
t.array(item) · t.object(shape) · t.record(value) · t.union(a, b)
t.optional(s) · t.nullable(s) · t.default(s, value) · t.any()
```

Params, query and form bodies are coerced (`"42"` → `42`, `"1"` → `true`). Unknown object keys are stripped.
Any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype) works wherever a `t` schema does.

Route meta also takes `response`, `summary`, `description`, `tags`, `operationId`, `deprecated`,
`hidden` (hide from OpenAPI), `tool` (`false` to hide from MCP, or `{ name, description }`) and `use`
(per-route middleware).

### Context

```ts
c.req · c.url · c.method · c.params · c.query · c.body · c.env · c.executionCtx
c.set(key, v) · c.get(key)                 // request-scoped variables
c.cookie(name) · c.setCookie(name, v, opts) · c.deleteCookie(name)
c.status(201) · c.header(name, v)
c.json(data, status?) · c.text() · c.html() · c.redirect(url, 302)
```

### Middleware

```ts
app.use(async (c, next) => { const t0 = Date.now(); await next(); c.res.headers.set("x-time", `${Date.now() - t0}`); });
app.use("/admin/*", (c, next) => (c.get("user") ? next() : c.json({ error: "unauthorized" }, 401)));
```

Middleware runs in onion order and may return a `Response` to short-circuit.

### Errors

Throw `new HttpError(status, message, { code, details })` anywhere. Validation failures are 422 with an `issues`
array (`path` like `["body", "email"]`). Unexpected errors become a 500 that never leaks the message. Override with
`app.onError((err, c) => …)` and `app.notFound((c) => …)`.

### Composition

```ts
const users = new Miu().get("/", list).get("/:id", show);
app.route("/api/users", users);
```

### MCP details

`mcp({ path = "/mcp", forwardHeaders = ["authorization", "cookie", "x-api-key"], instructions })` implements the
MCP Streamable HTTP transport (JSON responses; protocol versions 2025-06-18, 2025-03-26, 2024-11-05).
Tool names default to `get_todos_by_id`-style operation ids. Input schemas merge path params, query and body.
`GET` tools are marked `readOnlyHint`, `DELETE` tools `destructiveHint`. A tool call is replayed as a real HTTP
request through `app.fetch`, so middleware, auth and validation apply. HTTP errors come back as tool errors
(`isError: true`) the model can read and recover from.

## Batteries

Everything below runs on Bun, Node and Workers. SQLite drivers come from `miujs/sqlite` (kept out of the root
entry so edge bundles never see `bun:sqlite` / `node:sqlite`).

```ts
import { Miu, t, HttpError, sessions, auth, login, logout, requireAuth, currentUser, verifyPassword,
         verifyApiKey, cors, secureHeaders, requestId, logger, rateLimit, cache, createQueue } from "miujs";
import { sqliteStore, sqliteQueueDriver } from "miujs/sqlite";

const store = sqliteStore({ path: "app.sqlite" }); // or memoryStore() in tests

const app = new Miu()
  .use(requestId())
  .use(logger())
  .use(secureHeaders())
  .use(cors({ origin: ["https://app.example.com"], credentials: true }))
  .use(sessions({ store, secret: process.env.SESSION_SECRET! }))   // ≥ 32 chars; pass an array to rotate
  .use(auth({
    loadUser: (id) => db.users.find(id),                             // session-based (browsers)
    bearer: async (token) => {                                       // API keys / tokens (agents)
      const key = await verifyApiKey(store, token);
      return key && db.users.find(key.userId);
    },
  }))
  .use("/api/*", rateLimit({ store, limit: 100, window: 60 }))
  .post("/login", { body: t.object({ email: t.string(), password: t.string() }) }, async (c) => {
    const user = await db.users.byEmail(c.body.email);
    if (!user || !(await verifyPassword(c.body.password, user.passwordHash))) throw new HttpError(401, "Bad credentials");
    await login(c, user); // regenerates the session id
    return { ok: true };
  })
  .get("/me", { use: [requireAuth()] }, (c) => currentUser(c))
  .get("/stats", { use: [cache({ store, ttl: 30 })] }, () => expensiveStats());
```

| Feature | API | Notes |
| --- | --- | --- |
| Stores | `memoryStore()`, `sqliteStore()` | `get/set/delete/has/incr/ttl/prefix`; TTL in seconds |
| Sessions | `sessions()`, `session(c)` | HMAC-signed cookie, lazy load, save-on-change, `flash()`, `regenerate()`, `destroy()` |
| Passwords | `hashPassword`, `verifyPassword`, `needsRehash` | PBKDF2-SHA256, **Django-compatible** hashes — migrated users keep their passwords |
| Auth | `auth()`, `login`, `logout`, `requireAuth()`, `currentUser` | 401 problem+json for agents, optional redirect for browsers |
| API keys / JWT | `createApiKey`, `verifyApiKey`, `revokeApiKey`, `signJwt`, `verifyJwt` | keys stored as SHA-256 hashes; HS256 only |
| HTTP | `cors`, `secureHeaders`, `requestId`, `logger` | |
| Rate limit | `rateLimit({ store, limit, window })` | `RateLimit-*` headers; 429 detail tells agents when to retry |
| Cache | `cache({ store, ttl })`, `remember(store, key, ttl, fn)` | skips `set-cookie`, `no-store`, `private`, authorized requests |
| Queues | `createQueue({ driver })`, `define`, `dispatch`, `work`, `runOnce` | retries + backoff, timeouts, dedupe keys, `failed()`/`retry()` |

```ts
const queue = createQueue({ driver: sqliteQueueDriver({ path: "app.sqlite" }) });
const welcome = queue.define("welcome-email", {
  schema: t.object({ to: t.string({ format: "email" }) }),
  handler: async ({ to }) => sendEmail(to, "Welcome!"),
  retries: 5,
});
await welcome.dispatch({ to: "ann@example.com" }, { delay: 60, key: "welcome:ann" });
queue.work({ concurrency: 4 }); // in a worker process
```

## Cloudflare (`miujs/cloudflare`)

```ts
import { Miu, sessions, rateLimit, mcp } from "miujs";
import { d1Store, doStore, MiuStoreObject, queueConsumer, toWorker, workerEnv } from "miujs/cloudflare";

const env = workerEnv<Env>();                    // bindings exist per request; stores take getters
const app = new Miu<{ Bindings: Env }>()
  .use(sessions({ store: d1Store(() => env.current.DB), secret: SECRET }))
  .use(rateLimit({ store: doStore(() => env.current.LIMITS), limit: 60, window: 60 })) // atomic counters
  .use(mcp());

export { MiuStoreObject };                       // Durable Object class for doStore()
export default toWorker(app, { env, queue: queueConsumer(queue) });
```

Stores for KV, D1 and Durable Objects; Cloudflare Queues producer/consumer that reuse Miu job definitions;
R2 file serving (ETag, Range) and uploads; Workflows and Hyperdrive helpers. `miu wrangler --d1 DB --kv CACHE …`
writes the matching `wrangler.toml`. KV is eventually consistent — use D1 or a Durable Object for counters.

## Realtime (`app.ws`, `miujs/realtime`)

```ts
import { createRoomHub } from "miujs/realtime";
const rooms = createRoomHub<{ name: string }>();

app.ws("/rooms/:id", {
  params: t.object({ id: t.string() }),
  use: [requireAuth()],                               // middleware runs before the upgrade
  upgrade: (c) => ({ user: currentUser(c), room: c.params.id }),
}, {
  open: (ws) => rooms.join(ws.data.room, ws, { name: ws.data.user.name }),
  message: (ws, msg) => rooms.broadcast(ws.data.room, { from: ws.data.user.name, msg }, { except: ws }),
});
```

Works on Bun (native pub/sub) and Workers (`WebSocketPair`); `MiuRoom` is a hibernating Durable Object room for
cross-connection state on Cloudflare; `createGame()` runs Kahoot-style rounds with speed-based scoring — see
`examples/quiz`. On Node, `serve(app)` from `miujs/node` handles WebSockets with a built-in, dependency-free
server (size, masking, UTF-8, idle and backpressure limits). `app.publish(topic, data)` broadcasts on every runtime.

## Migrating from PHP / Python (`miujs/migrate`)

```ts
import { legacyProxy, phpSessionBridge, verifyLegacyPassword } from "miujs/migrate";

app
  .get("/api/products", listProducts)                  // ported routes are served by Miu…
  .use(legacyProxy({ target: "https://legacy.internal" })); // …everything else still goes to the old app
```

- **Strangler proxy** forwards unported routes (method-aware) with cookies, streaming and redirects intact.
- **Shared logins:** read PHP (`PHPSESSID`) and Django sessions; verify PHP `password_hash` bcrypt and Django
  password hashes, so users keep their passwords.
- **Contract tests:** `recordContract()` against the legacy app, `verifyContract()` against Miu.
- **Introspection:** `miu introspect sqlite:app.db` (or MySQL/Postgres/Mongo via the API) generates `t` schemas
  and CRUD routes.

## CLI and agent tooling

| Command | Does |
| --- | --- |
| `miu create <dir> --template bun\|node\|workers` | scaffold a project |
| `miu routes [entry]` | table of routes and their MCP tool names |
| `miu openapi` / `miu llms [--full]` / `miu tools` | export OpenAPI, llms.txt, MCP tool list |
| `miu wrangler --d1 DB --kv CACHE …` | generate `wrangler.toml` |
| `miu introspect sqlite:app.db` | database → schemas |

`app.use(llms())` serves `/llms.txt` and `/llms-full.txt`. `miujs/client` has `createClient()` (HTTP, problem+json
errors) and `createMcpClient()` for testing agent access.

## Typed client

```ts
export const app = new Miu()
  .get("/todos/:id", { params: t.object({ id: t.integer() }), response: Todo }, (c) => db.todo(c.params.id))
  .post("/todos", { body: t.object({ title: t.string() }) }, (c) => db.create(c.body));
export type App = typeof app;

// elsewhere
import { createClient } from "miujs/client";
const api = createClient<App>("https://api.example.com");
const todo = await api.get("/todos/:id", { params: { id: 1 } }); // typed from the Todo schema
// api.get("/todos/:id")  -> type error: params required
```

Chain route registrations so the type records them; handlers returning `c.json(...)` give `unknown` — add a
`response` schema for a typed result.

## Security and scale

- **Agents with OAuth:** `app.use(mcpAuth({ resource, authorizationServers, verify: mcpJwtVerifier({ key: jwks, algorithms: ["RS256"] }) }))`
  serves RFC 9728 metadata and makes MCP tool calls run as the token's user.
- **JWT:** HS256, EdDSA, RS256, ES256 and remote JWKS; algorithms are an explicit allow-list bound to the key type.
- **Redis:** `redisStore(client)` and `redisQueueDriver(client)` work with `Bun.RedisClient`, ioredis or node-redis —
  swap them in for SQLite when you run more than one instance.
- **Laravel:** `laravelSessionBridge({ appKey, read })` in `miujs/migrate` reads encrypted Laravel sessions.
- **Client IPs:** `c.ip` is the socket address (Bun, Node). `rateLimit()` ignores forwarding headers unless you
  set `trustProxy: true` (behind your proxy) or `"cloudflare"` — headers alone can't reset a rate limit.
- **CSRF:** `app.use(csrf())` protects cookie-authenticated HTML forms and APIs (fetch metadata + Origin).

## Debugging in browser DevTools

```ts
import { inspector, timing, devLogger, devErrors } from "miujs";
app.use(inspector()).use(timing()).use(devLogger()).onError(devErrors());
```

`Server-Timing` shows up in the Network tab, dev errors render with stack traces (secrets redacted), and
`/__miu` is a live request inspector. All of it is off in production; the inspector only answers on loopback and
requires a token printed to the console. Run `MIU_ENV=development bun --inspect app.ts` for breakpoints — see
[docs/debugging.md](docs/debugging.md).

## Performance

Measured on the same machine against Hono and Elysia ([bench/results.md](bench/results.md)): over the network Miu is
level with Hono on plain text, ~15% ahead of Hono on JSON params and validated POSTs, ~90% of Elysia on simple
GETs, and level with Elysia on validated POSTs. Under a realistic mixed load (the Tour Studio app: public
bundles, panoramas with 304/206, creator reads and writes, MCP) it serves ~3.5k req/s on Bun and ~1.6k on Node
with zero errors on 4 shared cores ([bench/results-tour-studio.md](bench/results-tour-studio.md)).

## App kits

### Admin back-office (`miujs/admin`)

```ts
import { admin } from "miujs/admin";
import { sqliteRepository } from "miujs/sqlite";
import { diskBlobStore } from "miujs/node";

const posts = sqliteRepository<Post>({ path: "app.sqlite", table: "posts", searchFields: ["title"] });
app.route("/admin", admin({
  resources: {
    posts: {
      schema: Post, repo: posts, files: diskBlobStore({ root: "./uploads" }),
      fields: { cover: { widget: "image" }, body: { widget: "markdown" } },
    },
  },
}));
```

A CRUD API and a no-build UI (search, sort, pagination, generated forms, uploads, relations, dark mode) from your
`t` schemas. Every route requires a user with the `admin` role by default (roles or predicates per action),
cookie writes need a same-origin request plus a session-bound CSRF token, pages ship a nonce CSP, changes are
audited, and admin actions are MCP tools for agents. `miu create my-admin --template admin` scaffolds one.

### Virtual tours (`miujs/tour`)

```ts
import { tourKit } from "miujs/tour";
import { diskBlobStore } from "miujs/node";

app.route("/", tourKit({ tours, scenes, hotspots, files: diskBlobStore({ root: "./panoramas" }) }));
// /editor — creators upload 2:1 panoramas, click to place hotspots, link scenes, publish
// /t/:slug — public WebGL viewer; /api/public/tours/:slug — cached bundle with ETag
```

Uploads are validated from the image bytes (real type, 2:1 equirectangular, size), publishing checks the scene
graph, panoramas of drafts are private, and every JSON route is an MCP tool — an agent can build and publish a
tour. `miu create my-tours --template tour --with-admin` scaffolds a site. A full reference app lives in
[`apps/tour-studio`](apps/tour-studio) (`bun run e2e`, `bun run bench:app`).

### Files and data

`Repository` (memory, `sqliteRepository`, `d1Repository`) and `BlobStore` (memory, `diskBlobStore`, `r2BlobStore`)
are shared building blocks: `uploadFiles()` sniffs real types from bytes, `serveBlob()` handles ETag/Range and
sandboxes active content, `signBlobUrl()` makes expiring links, and `create(…, { unique: ["slug"] })` enforces
uniqueness atomically on every driver.

## Development

```bash
bun install
bun test           # 915 tests
bun run e2e        # reference-app journeys (functional, browser, Node, load)
bun run bench:app  # realistic mixed load on Bun and Node
bun run build      # dist/ with source maps
bun run typecheck:cf  # Cloudflare binding types
bun run bench:micro  # in-process framework benchmark
bun run typecheck
bun examples/basic.ts
```

## License

MiuJS is dual-licensed: [AGPL-3.0-or-later](LICENSE) for everyone, free to use and modify, with a commercial
license available from the author for teams that cannot meet the AGPL's terms.
