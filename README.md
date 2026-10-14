# MiuJS

**About as fast as Elysia, runs anywhere like Hono, and every route is automatically an agent tool.**

MiuJS is an open-source TypeScript web framework for Bun, Node and Cloudflare Workers, built for apps that
humans *and* AI agents use. Declare a route with a schema once, and you get:

- validated, typed handler input (params, query, JSON or form body, headers)
- an **MCP tool** that agents (Claude, ChatGPT, Cursor, …) can call — through the same auth and middleware as browsers
- an **OpenAPI 3.1** operation
- consistent **RFC 9457 problem+json** errors

> Status: **v0.2 — core + batteries.** Router, schemas, middleware, errors, OpenAPI, MCP, Node adapter, stores,
> sessions, auth, HTTP middleware, rate limiting, caching and job queues are done and tested. Cloudflare bindings,
> realtime and the migration kit are next — see [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

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

> **Bun note:** Bun automatically serves an entry file's default export if it has a `fetch` method. Use either
> `export default app` *or* `app.listen(port)` in your entry file, not both.

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

## Development

```bash
bun install
bun test           # 199 tests
bun run typecheck
bun examples/basic.ts
```

## License

MiuJS is dual-licensed: [AGPL-3.0-or-later](LICENSE) for everyone, free to use and modify, with a commercial
license available from the author for teams that cannot meet the AGPL's terms.
