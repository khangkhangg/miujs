# Getting started with MiuJS

This guide takes you from an empty folder to a tested API that AI agents can call, deployed to
Cloudflare Workers. Each package has its own README with the full API; this page links to them.

MiuJS is at 0.1: APIs may still change, and the packages are not on npm yet. Until they are,
work inside a clone of the repo (`bun install` links the workspace packages).

## 1. A new project

```bash
bun add -d @miujs/cli
miu new my-app          # app.ts, routes/health.ts, AGENTS.md, package.json, tsconfig.json
cd my-app && bun install
miu dev                 # bun --hot app.ts
```

The app is the default export of `app.ts`. Bun serves it as-is, `deno serve app.ts` does too, and
it is a complete Cloudflare Worker. On Node, call `await app.listen(3000)`.

<!-- test -->
```ts
import { miu, route, t } from "miujs";

// miu new puts this in routes/health.ts; app.ts then does `import * as health from "./routes/health.ts"`.
export const health = route.get("/health", {
  summary: "Check that the app is up",
  response: t.object({ ok: t.boolean() }),
  handler: () => ({ ok: true }),
});

export default miu({ name: "my-app", routes: [{ health }], mcp: true });
```

Passing a route module (or any object of routes) registers every route in it, named after its
export, and collects its `tests`. See [`@miujs/cli`](../packages/cli/README.md) for every command.

## 2. Routes and schemas

One `t` schema per input gives you validation, TypeScript types, OpenAPI and the MCP tool schema.
Params and query are coerced from strings; unknown body keys are dropped.

<!-- test -->
```ts
import { route, t } from "miujs";

export const createOrder = route.post("/orders", {
  summary: "Create an order", // agents see this as the tool description
  body: t.object({ sku: t.string(), qty: t.integer({ min: 1 }) }),
  query: t.object({ dryRun: t.default(t.boolean(), false) }),
  response: t.object({ id: t.string(), qty: t.integer() }),
  status: 201,
  auth: "required", // or "optional", false, { role: "admin" }
  handler: async ({ body, query, user, log }) => {
    log.info("order", { user: user.id, dryRun: query.dryRun });
    return { id: "o_1", qty: body.qty };
  },
});
```

A handler returns an object (JSON), a string (text), `undefined` (204) or any `Response`. In dev,
responses are checked against `response`. The schema builders (`t.string`, `t.enum`, `t.array`,
`t.union`, `t.optional`, ...) are listed in the [`miujs` README](../packages/miujs/README.md#schemas).

## 3. Errors

Throw `errors.*` instead of plain `Error`s. Every error has a stable `MIU_E_*` code, a message and a
`fix` that says what to change:

<!-- test -->
```ts
import { errors, route, t } from "miujs";

export const getUser = route.get("/users/:id", {
  params: t.object({ id: t.string() }),
  handler: ({ params }) => {
    if (params.id !== "1") throw errors.notFound("user", params.id);
    return { id: "1", name: "Mia" };
  },
});
```

```json
{ "error": { "code": "MIU_E_NOT_FOUND", "message": "user \"2\" not found",
  "docs": "https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#miu_e_not_found" } }
```

Configuration mistakes fail at startup with the same shape, for example `MIU_E_PARAM_MISSING` when
a path has `:id` but the params schema doesn't. Every code is in [errors.md](errors.md).

## 4. Plugins

Batteries are plugins. Each adds typed fields to the handler context and picks a local or
Cloudflare backend on its own:

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { cache } from "@miujs/cache";
import { db } from "@miujs/db";

const migrations = [{ id: "001_notes", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);" }];

export const listNotes = route.get("/notes", {
  query: t.object({ limit: t.default(t.integer({ min: 1, max: 100 }), 20) }),
  handler: async ({ query, db, cache }) =>
    cache.remember(`notes:${query.limit}`, 30, async () => {
      const { results } = await db.prepare("SELECT id, body FROM notes ORDER BY id LIMIT ?").bind(query.limit).all();
      return { notes: results };
    }),
});

export default miu({ name: "notes", routes: [listNotes], plugins: [db({ migrations }), cache()] });
```

| Package | Adds |
| --- | --- |
| [`@miujs/auth`](../packages/auth/README.md) | Email and password accounts, API tokens, roles (`user`, `auth: "required"`) |
| [`@miujs/session`](../packages/session/README.md) | Signed-cookie or server-side sessions, flash, CSRF protection |
| [`@miujs/db`](../packages/db/README.md) | D1-compatible SQL on SQLite or Cloudflare D1, migrations; [Postgres over Hyperdrive](postgres.md) |
| [`@miujs/cache`](../packages/cache/README.md) | `remember()`, tags; memory, KV or Redis |
| [`@miujs/queue`](../packages/queue/README.md) | Typed jobs, retries, cron; Cloudflare Queues |
| [`@miujs/ratelimit`](../packages/ratelimit/README.md) | Rate limiting rules |
| [`@miujs/bots`](../packages/bots/README.md) | Detect bots, AI crawlers and visitor location; block them or serve them cached responses |
| [`@miujs/realtime`](../packages/realtime/README.md) | Authoritative rooms over WebSockets, Durable Objects |
| [`@miujs/files`](../packages/files/README.md) | Uploads and signed URLs; disk, R2, S3 |
| [`@miujs/web`](../packages/web/README.md) | HTML and JSX without a build, static files, htmx, security headers |
| [`@miujs/mail`](../packages/mail/README.md) | Transactional email |
| [`@miujs/access`](../packages/access/README.md) | Roles, permissions, per-record policies, organizations |
| [`@miujs/audit`](../packages/audit/README.md) | Tamper-evident audit log |
| [`@miujs/workflows`](../packages/workflows/README.md) | Durable workflows with steps, sleeps and events |
| [`@miujs/ai`](../packages/ai/README.md) | Model calls, tool use over your routes, RAG |

Your own plugin is a `definePlugin({ name, routes, setup, onRequest, onResponse, mcpTools, inspect })`;
see [AGENTS.md](../AGENTS.md#plugins-how-batteries-plug-in).

## 5. MCP for AI agents

With `mcp: true` every route is an MCP tool at `POST /mcp` (Streamable HTTP). A tool call runs the
real route, so auth and validation apply, and errors come back with their `fix`. Routes with
`mcp: false` are hidden.

```bash
bun app.ts                                          # serves on http://localhost:3000
claude mcp add --transport http my-app http://localhost:3000/mcp
miu inspect --json                                  # what agents (and you) can see
```

`GET /_miu/openapi.json` serves OpenAPI 3.1 in dev (or with `openapi: true`).

## 6. Testing

`app.call(route, input)` runs the full pipeline without a network and returns
`{ status, body, text, headers, expectStatus(n) }`. Use it from `bun test`:

<!-- test -->
```ts
import { expect, test } from "bun:test";
import { errors, miu, route, t } from "miujs";

const getUser = route.get("/users/:id", {
  params: t.object({ id: t.string() }),
  handler: ({ params }) => {
    if (params.id !== "1") throw errors.notFound("user", params.id);
    return { id: "1", name: "Mia" };
  },
});
const app = miu({ routes: [getUser], logLevel: "silent" });

test("unknown users are 404 with a stable code", async () => {
  const res = await app.call(getUser, { params: { id: "2" } });
  res.expectStatus(404);
  expect(res.body.error.code).toBe("MIU_E_NOT_FOUND");
});

test("the full HTTP pipeline", async () => {
  const res = await app.fetch(new Request("http://localhost/users/1"));
  expect(await res.json()).toEqual({ id: "1", name: "Mia" });
});
```

Route files can also export `tests = { "name": async (call) => { ... } }`; `miu test` runs them.
`miu check` looks for leaked secrets and mutations without `auth`.

## 7. Deploy to Cloudflare Workers

```bash
miu deploy cloudflare --dry-run   # write wrangler.toml from your plugins and print it
miu deploy cloudflare             # write it, then bunx wrangler deploy (needs wrangler login)
wrangler secret put SESSION_SECRET
```

Plugins declare the bindings they need (KV for cache, D1 for db, Queues, R2, Durable Objects for
realtime rooms), and `miu deploy cloudflare` turns them into `wrangler.toml`. Secrets are never
written to it; set them with `wrangler secret put`. On Workers, `ctx.env` holds your bindings and
`app.listen()` is not available: the default export is the Worker.

Cloudflare support is tested against in-test fakes but has not been deployed to a real account yet;
see the README's [known limitations](../README.md#known-limitations-01).

## Next

- [AGENTS.md](../AGENTS.md): the rules for changing a MiuJS app (test first, erasable TypeScript, web standards).
- [errors.md](errors.md): every error code with its fix.
- [examples/api](../examples/api) and [examples/quiz](../examples/quiz): a notes API using the batteries and a Kahoot-style quiz.
- [llms.txt](../llms.txt): an index of these docs for LLMs.
