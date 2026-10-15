# miujs

> Core of MiuJS: a no-build TypeScript web framework with typed routes, `t` schemas, stable error codes, plugins, MCP and OpenAPI, for Bun, Deno, Node and Cloudflare Workers.

`miujs` gives you `miu()` (the app), `route.*` (handlers with their schemas), `t` (validation that also produces JSON Schema), `errors.*` (`MiuError`s with a `MIU_E_*` code and a `fix`) and `definePlugin()`. One route definition drives validation, TypeScript types, OpenAPI, MCP tools and test helpers. Use it on its own for an API, or add the `@miujs/*` batteries as plugins.

## Install

```bash
bun add miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { errors, miu, route, t } from "miujs";

export const getUser = route.get("/users/:id", {
  summary: "Get a user by id",
  params: t.object({ id: t.string() }),
  response: t.object({ id: t.string(), name: t.string() }),
  handler: ({ params }) => {
    if (params.id !== "1") throw errors.notFound("user", params.id);
    return { id: "1", name: "Mia" };
  },
});

const app = miu({ name: "hello", routes: [getUser], mcp: true });
export default app; // Bun, `deno serve` and Workers serve the default export

const res = await app.call(getUser, { params: { id: "1" } });
res.expectStatus(200);
console.log(res.body); // { id: "1", name: "Mia" }
```

Run it with `bun app.ts`, `deno serve app.ts`, or `await app.listen(3000)`.

## Routes

`route.get | post | put | patch | delete | head | options(path, config)`. Paths use `:name` params and a trailing `*` wildcard. The handler gets `params`, `query`, `body` (typed from the schemas), plus `user`, `env`, `log`, `cookies`, `set`, `state`, `ip`, `waitUntil` and `upgrade`.

<!-- test -->
```ts
import { route, t } from "miujs";

export const createOrder = route.post("/orders", {
  summary: "Create an order",
  body: t.object({ sku: t.string(), qty: t.integer({ min: 1 }) }),
  query: t.object({ dryRun: t.default(t.boolean(), false) }),
  response: t.object({ id: t.string(), qty: t.integer() }),
  status: 201,
  auth: "required", // or "optional", false, { role: "admin" }
  handler: async ({ body, query, user, set, log }) => {
    log.info("order", { user: user.id, dryRun: query.dryRun });
    set.headers.set("x-order", "o_1");
    return { id: "o_1", qty: body.qty };
  },
});
```

Return an object (JSON), a string (text), `undefined` or `null` (204), or any `Response`. Params and query are coerced from strings; unknown body keys are dropped. In dev mode responses are checked against `response`.

A string is served as `text/plain; charset=utf-8`. When Bun's own server calls the app (`export default app` or `app.listen()` on Bun), no `onResponse` plugin is installed, the method isn't `HEAD` and the route set no headers, the header is left off the `Response` object and Bun adds `text/plain;charset=utf-8` on the wire, which saves ~120 ns per text response. Everywhere the object can be seen (`app.fetch(req)` in tests, `app.tools()` calls, MCP, `app.dispatch`, Node, Deno, Workers) it carries the header.

Other route options: `name`, `description`, `tags`, `mcp: false`, `permission` (checked via `ctx.authorize`, provided by `@miujs/access`), `maxBodySize`, `internal`.

## Schemas

`t.string({ minLength, maxLength, pattern, format, secret })`, `t.number({ min, max })`, `t.integer()`, `t.boolean()`, `t.date()`, `t.literal(v)`, `t.enum([...])`, `t.array(item, { min, max })`, `t.object(shape)`, `t.record(value)`, `t.union([...])`, `t.optional(s)`, `t.default(s, value)`, `t.nullable(s)`, `t.any()`, `t.unknown()`. String formats: `uuid`, `email`, `url`, `date`, `date-time`. `secret: true` marks an API key, password or connection string: the JSON Schema gets `writeOnly: true` and `format: "password"` (unless `format` is set), so admin screens and audit logs redact it; validation is unchanged.

<!-- test -->
```ts
import { t, validate, type Infer } from "miujs";

const User = t.object({
  email: t.string({ format: "email" }),
  role: t.enum(["admin", "member"]),
  tags: t.optional(t.array(t.string())),
});
type User = Infer<typeof User>;

const r = validate(User, { email: "a@b.co", role: "member" });
if (r.ok) {
  const u: User = r.value;
  console.log(u.role);
} else {
  console.log(r.issues); // [{ path, message }]
}
console.log(User.json); // JSON Schema, as used by OpenAPI and MCP
```

## Errors and plugins

Throw `errors.notFound`, `badRequest`, `unauthorized`, `forbidden`, `conflict`, `tooManyRequests`, `internal`, or `errors.custom({ code, status, message, fix })`. Every error body is:

```json
{ "error": { "code": "MIU_E_NOT_FOUND", "message": "user \"9\" not found",
  "docs": "https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#miu_e_not_found" } }
```

Plugins add routes, hooks, services, MCP tools and Cloudflare bindings:

<!-- test -->
```ts
import { definePlugin, miu, route } from "miujs";

const timing = definePlugin({
  name: "timing",
  onRequest(ctx) {
    ctx.state.start = performance.now();
  },
  onResponse(ctx, res) {
    res.headers.set("server-timing", `app;dur=${performance.now() - (ctx.state.start as number)}`);
  },
  inspect: () => ({ header: "server-timing" }),
});

const app = miu({ routes: [route.get("/", { handler: () => "ok" })], plugins: [timing] });
const res = await app.fetch(new Request("http://localhost/"));
console.log(res.headers.get("server-timing"));
```

Plugin hooks: `setup(app)`, `routes`, `onRequest`, `onResponse`, `onError`, `mcpTools()`, `inspect()`, `cloudflare()`. In `setup`, plugins can call `app.add(...)`, `app.on("queue" | "scheduled", fn)` and `app.provide(name, value)`; code outside requests reads services with `app.service(name)`. Add typed context fields with `declare module "miujs" { interface Context { ... } }`, and typed per-route options with `declare module "miujs" { interface RouteExtensions { myOption?: ... } }`: routes then accept `myOption`, and hooks read it from `ctx.route.config.myOption` (the route's own config object; absent on internal `/_miu/*` and MCP routes).

## MCP, OpenAPI and inspect

- `miu({ mcp: true })` serves every route as an MCP tool at `POST /mcp` (Streamable HTTP). A tool call dispatches a real request, so auth and validation apply. Routes with `mcp: false` are skipped.
- `GET /_miu/openapi.json` (dev, or `openapi: true`) and `GET /_miu/app.json` (dev only). In code: `app.openapi()`, `app.inspect()` (after `await app.ready()`).
- `app.tools()` returns the same tools with a `call(args, { headers })` method, for model tool use (`@miujs/ai`).

## WebSockets

```ts
route.get("/ws", {
  handler: (ctx) =>
    ctx.upgrade({
      data: { n: 0 },
      message(ws, msg) { ws.data.n++; ws.send(`echo ${msg}`); },
    }),
});
```

Works on Bun (the default export or `app.listen()` carry `websocket`), Deno and Workers (`WebSocketPair`).

## Node

<!-- test -->
```ts
import { miu, route } from "miujs";
import { serveNode } from "miujs/node";

const app = miu({ routes: [route.get("/hi", { handler: () => ({ hi: true }) })] });
const server = await serveNode(app, { port: 3000, hostname: "127.0.0.1" });
console.log(server.url);
await server.stop();
```

`app.listen()` on Node loads this adapter for you.

## Testing

- `await app.fetch(new Request("http://localhost/path"))` or `await app.request("/path", init)`: full pipeline, no network.
- `await app.call(route, { params, query, body, headers })` returns `{ status, ok, headers, text, body, expectStatus(n) }`.
- Route modules may export `tests = { "name": async (call: CallFn) => {...} }`; `app.tests` collects them and `miu test` runs them.
- `await app.drain()` waits for `waitUntil` work.
- When you call `app.fetch()` yourself, read or cancel every response body (`await res.text()`,
  `await res.body?.cancel()`). A dropped body keeps its source (an open file, an upstream request)
  alive until garbage collection. Servers (`Bun.serve`, `listen()`, Workers) do this for you.
- `await app.stop()` waits for background work and calls each plugin's `stop()`, so timers and
  sockets are released and the process can exit. Stopping a `listen()` server calls it for you.

## Options

`miu(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `"miujs-app"` | App name (MCP server info, OpenAPI title, logs). |
| `version` | `string` | `"0.0.0"` | App version. |
| `routes` | `RouteSource[]` | `[]` | Routes, arrays, or route modules (export names become route names; `tests` are collected). |
| `plugins` | `Plugin[]` | `[]` | Plugins, run in order. |
| `mcp` | `boolean \| McpOptions` | off | Serve routes as MCP tools. `McpOptions`: `path` (default `/mcp`), `instructions`, `include`, `allowedOrigins`. |
| `openapi` | `boolean \| { path?, info? }` | on in dev | Serve OpenAPI 3.1 at `/_miu/openapi.json`. |
| `dev` | `boolean` | on unless `MIU_ENV`/`NODE_ENV` is `production` or on Workers | Response checks and `/_miu/*` routes. |
| `logLevel` | `LogLevel \| "silent"` | `"info"` in dev, else `"warn"` | Logger level. |
| `logRequests` | `boolean` | `false` | One log line per request. |
| `maxBodySize` | `number` | `10485760` (10 MiB) | Largest request body in bytes. Routes can override. |
| `trustProxy` | `{ header: string; hops?: number }` | none | Your reverse proxy's header, so `ctx.ip` is the real client. |

## Errors

- `MIU_E_ROUTE_NOT_FOUND`: no route matches the method and path; the `fix` suggests the closest route.
- `MIU_E_NOT_FOUND`: thrown by `errors.notFound()` for a missing resource ([docs](../../docs/errors.md#miu_e_not_found)).
- `MIU_E_METHOD_NOT_ALLOWED`: the path exists for other methods.
- `MIU_E_VALIDATION`: params, query or body do not match the schema; `details.issues` lists each problem.
- `MIU_E_RESPONSE_INVALID`: dev only; the handler returned data that does not match `response`.
- `MIU_E_BAD_JSON`, `MIU_E_BODY_TOO_LARGE`: unreadable or oversized body.
- `MIU_E_UNAUTHORIZED`, `MIU_E_FORBIDDEN`: `auth` requirement not met.
- `MIU_E_PARAM_MISSING`, `MIU_E_ROUTE_DUPLICATE`, `MIU_E_ROUTE_CONFLICT`: route configuration mistakes, thrown at startup.
- `MIU_E_SERVICE_MISSING`, `MIU_E_SERVICE_DUPLICATE`: a plugin service is absent or provided twice.
- `MIU_E_LISTEN_UNSUPPORTED`: `listen()` called on Workers.
- `MIU_E_INTERNAL`: an unexpected exception.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

`export default app` is a complete Worker: `app.fetch(req, env, ctx)`, plus `app.queue` and `app.scheduled` for handlers plugins register with `app.on(...)`. On Workers `ctx.env` holds your bindings and vars, `ctx.waitUntil` uses the execution context, `ctx.ip` comes from Cloudflare, and dev mode is off by default. `app.listen()` throws `MIU_E_LISTEN_UNSUPPORTED`. The core has no `node:*` imports outside `miujs/node`, which is Node only. Plugins declare the bindings they need through `cloudflare()`; `app.inspect().cloudflare` merges them and `miu deploy cloudflare` writes `wrangler.toml` from it.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [@miujs/cli](../cli/README.md), [@miujs/web](../web/README.md), [@miujs/ai](../ai/README.md), [@miujs/auth](../auth/README.md), [@miujs/cache](../cache/README.md), [@miujs/db](../db/README.md)
