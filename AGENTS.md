# AGENTS.md — working on MiuJS

Instructions for coding agents (and humans) changing this repo.

## Layout

- `packages/miujs` — core (`miujs`): router, `t` schemas, errors, app, OpenAPI, MCP, WebSockets, Node adapter.
- `packages/<name>` — official batteries, published as `@miujs/<name>` (auth, session, cache, queue, db, realtime, ratelimit, bots, cli, ...).
- `examples/*` — runnable apps. `bench/` — benchmarks.

Bun workspaces link packages, so `import { miu } from "miujs"` works everywhere in the repo.

## Commands

```bash
bun test                        # whole suite
bun test packages/cache         # one package
bun run typecheck               # tsc --noEmit over the repo
```

On this machine Bun may not be on PATH: use `~/.bun/bin/bun`.

## Rules

1. **Test first.** Write the failing test, watch it fail for the right reason, then write the minimal code. Tests live in `packages/<pkg>/test/*.test.ts` and use `bun:test`. No mocks of our own code; use real in-memory adapters.
2. **Erasable TypeScript only.** No `enum`, `namespace`, parameter properties or decorators. Files must run with type-stripping. Import local files with the `.ts` extension.
3. **Web standards only** in runtime code: `Request`, `Response`, `Headers`, `crypto.subtle`, `URL`. No `node:*` imports outside `packages/miujs/src/node.ts` and code that only runs on Bun/Node (guard with `detectRuntime()`).
4. **No `eval` / `new Function`** — Cloudflare Workers forbid them.
5. **Errors are `MiuError`s** with a stable `MIU_E_*` code, a human message, and a `fix` that tells the reader what to change. Use `errors.*` from `miujs`.
6. **One obvious way.** Each battery exposes one API and swaps backends via adapters. Defaults need zero config (in-memory or SQLite locally; Cloudflare bindings on Workers).
7. Do not commit unless asked.

## Core API in one screen

```ts
import { miu, route, t, errors, definePlugin, type Context } from "miujs";

export const getUser = route.get("/users/:id", {
  summary: "Get a user by id",              // becomes the MCP tool description
  params: t.object({ id: t.string() }),    // also: query, body, response
  auth: "required",                        // or { role: "admin" }, "optional", false
  handler: async ({ params, user, env, log, cookies, set, waitUntil }) => {
    if (params.id !== user.id) throw errors.forbidden();
    return { id: params.id };              // object → JSON; string → text; undefined → 204; Response → as-is
  },
});

const app = miu({ name: "demo", routes: [getUser], plugins: [], mcp: true });
export default app;                        // Bun / Deno serve / Workers
// await app.listen(3000);                 // or start a server yourself
```

### Plugins (how batteries plug in)

```ts
export const myPlugin = (opts = {}) => definePlugin({
  name: "my-plugin",
  routes: [/* extra RouteDefs */],
  setup(app) { /* once, before first request; app.on("queue" | "scheduled", fn) for Workers */ },
  onRequest(ctx) { /* after route match, before auth/validation; return a Response to stop */ },
  onResponse(ctx, res) { /* every response, incl. errors; return a Response to replace */ },
  mcpTools() { return []; },               // extra MCP tools
  inspect() { return { /* shown in miu inspect */ } },
});

// Typed context fields via module augmentation:
declare module "miujs" {
  interface Context { cache: CacheClient }
}
```

`ctx.state` is free per-request storage for plugins. `ctx.env` holds env vars (Bun/Deno/Node) or bindings (Workers). `ctx.runtime` is `"bun" | "deno" | "node" | "workerd"`.

### WebSockets

`ctx.upgrade({ data, open(ws), message(ws, msg), close(ws, code, reason) })` returns a `Response` to return from the handler. Works on Bun (via `app.websocket` / `app.listen`), Deno and Workers (`WebSocketPair`).

### Testing helpers

- `await app.fetch(new Request("http://localhost/path"))` — full pipeline, no network.
- `await app.call(routeDef, { params, query, body, headers })` → `{ status, body, text, headers, expectStatus(n) }`.
- Route modules may export `tests = { "name": async (call) => {...} }`; `app.tests` collects them and `miu test` runs them.
- `app.inspect()` (after `await app.ready()`) and `app.openapi()` describe the app as JSON.
