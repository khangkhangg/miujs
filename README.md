# MiuJS

A fast TypeScript web framework that runs with **no build step**, is tuned for **Bun**, also
runs on **Deno, Node and Cloudflare Workers**, and makes every route usable by **AI agents**
(MCP + OpenAPI out of the box).

```ts
import { miu, route, t, errors } from "miujs";

export const getUser = route.get("/users/:id", {
  summary: "Get a user by id",
  params: t.object({ id: t.string() }),
  response: t.object({ id: t.string(), name: t.string() }),
  handler: ({ params }) => {
    if (params.id !== "1") throw errors.notFound("user", params.id);
    return { id: "1", name: "Mia" };
  },
});

export default miu({ name: "hello", routes: [getUser], mcp: true });
```

```bash
bun app.ts          # Bun serves the default export
deno serve app.ts   # Deno
wrangler deploy     # Cloudflare Workers (or: miu deploy cloudflare)
```

> Status: **0.1 MVP**. APIs may still change. See [the spec](https://claude.ai/code/artifact/cea50b68-c0e3-4821-a540-fb6b0f4903fc) for the full plan.

## Why MiuJS

| | |
| --- | --- |
| **One schema per route** | `t.object(...)` gives types, validation, OpenAPI, the MCP tool schema and test helpers. |
| **Agent-native** | `mcp: true` serves every route as an MCP tool at `/mcp`. `miu inspect --json` describes the whole app. Errors carry a stable `MIU_E_*` code and a `fix`. |
| **No build** | Erasable TypeScript, run as written. Validators are composed at startup without `eval`, so they work on Workers. |
| **Batteries** | Auth, sessions, cache, queues, SQL and realtime rooms as official `@miujs/*` packages with swappable adapters (memory/SQLite locally, Cloudflare bindings in production). |
| **Games** | `@miujs/realtime` rooms run on Durable Objects or in-process — enough for a Kahoot-style quiz. See [examples/quiz](examples/quiz). |

## Packages

| Package | What it does |
| --- | --- |
| [`miujs`](packages/miujs) | Core: router, `t` schemas, errors, app, OpenAPI, MCP, WebSockets, Node adapter |
| [`@miujs/cli`](packages/cli) | `miu new / dev / test / inspect / openapi / check / add / deploy` |
| [`@miujs/auth`](packages/auth) | Email + password, API tokens, roles, legacy hash verification |
| [`@miujs/session`](packages/session) | Signed-cookie or server-side sessions, flash, CSRF protection |
| [`@miujs/db`](packages/db) | D1-compatible SQL on SQLite (Bun) and Cloudflare D1, migrations |
| [`@miujs/cache`](packages/cache) | `remember()`, tags, memory LRU or Cloudflare KV |
| [`@miujs/queue`](packages/queue) | Typed jobs, retries with backoff, cron schedules, Cloudflare Queues |
| [`@miujs/realtime`](packages/realtime) | Authoritative rooms over WebSockets, Durable Objects, client SDK |

## Core concepts

### Routes

```ts
route.post("/orders", {
  summary: "Create an order",            // shown to agents as the tool description
  body: t.object({ sku: t.string(), qty: t.integer({ min: 1 }) }),
  query: t.object({ dryRun: t.default(t.boolean(), false) }),
  response: t.object({ id: t.string() }),
  status: 201,
  auth: "required",                      // or { role: "admin" }, "optional"
  handler: async ({ body, query, user, log, set, cookies, env, waitUntil }) => ({ id: "o_1" }),
});
```

Return an object (JSON), a string (text), `undefined` (204), bytes/stream, or any `Response`.
Params and query are coerced from strings. Unknown body keys are dropped. In dev, responses are
checked against `response`.

### Errors

```json
{ "error": { "code": "MIU_E_VALIDATION", "message": "Invalid body: body.qty must be >= 1",
  "fix": "Send body that matches the route schema (see /_miu/openapi.json or the MCP tool input schema).",
  "docs": "https://miujs.dev/errors/MIU_E_VALIDATION", "details": { "issues": [...] } } }
```

Configuration mistakes fail at startup with the same shape, e.g. `MIU_E_PARAM_MISSING` when a
path has `:id` but the params schema doesn't.

### Plugins

```ts
const timing = definePlugin({
  name: "timing",
  onRequest(ctx) { ctx.state.start = performance.now(); },
  onResponse(ctx, res) { res.headers.set("server-timing", `app;dur=${performance.now() - (ctx.state.start as number)}`); },
});
```

Plugins can add routes, MCP tools, Workers `queue`/`scheduled` handlers, typed context fields
(module augmentation) and the Cloudflare bindings they need.

### MCP and OpenAPI

- `miu({ mcp: true })` → `POST /mcp` (Streamable HTTP). Tools are built from route schemas; a
  tool call runs the real route, so auth and validation apply. Point Claude or any MCP client at it.
- `GET /_miu/openapi.json` (dev, or `openapi: true`), `GET /_miu/app.json` (dev), `miu inspect --json`.

### Testing

```ts
export const tests = {
  "returns 404 for unknown id": async (call: CallFn) => {
    (await call(getUser, { params: { id: "nope" } })).expectStatus(404);
  },
};
```

`miu test` runs every route file's `tests`. For unit tests use `bun test` with
`app.fetch(new Request(...))` or `app.call(route, input)`.

### Realtime rooms (games, quizzes, chat)

```ts
import { defineRoom, rooms } from "@miujs/realtime";

export const quiz = defineRoom("quiz", {
  state: t.object({ phase: t.enum(["lobby", "question", "reveal"]), scores: t.record(t.number()) }),
  secret: () => ({ correct: 2 }),                        // server-only state, never sent to clients
  client: { answer: t.object({ choice: t.integer() }) },
  init: () => ({ phase: "lobby" as const, scores: {} }),
  on: {
    answer: ({ room, sender, msg }) => {
      if (msg.choice === room.secret.correct) room.state.scores[sender.id] = (room.state.scores[sender.id] ?? 0) + 1000;
    },
  },
});

miu({ plugins: [rooms({ rooms: [quiz] })] });          // ws://host/rooms/quiz/<id>
```

State changes are sent to every player as patches. On Cloudflare each room is a Durable Object
(`createRoomDurableObject`); locally it lives in memory. The wire protocol is documented in
[PROTOCOL.md](packages/realtime/PROTOCOL.md) so Unity or Godot clients can join. The full
Kahoot-style game is in [examples/quiz](examples/quiz); a notes API using every other battery
is in [examples/api](examples/api).

## CLI

```bash
miu new my-app                  # project with app.ts, routes/, AGENTS.md
miu dev                         # bun --hot
miu add route users/get-profile # route file + failing test
miu test                        # route tests
miu inspect [--json]            # routes, schemas, plugins, MCP tools
miu check                       # leaked secrets, mutations without auth
miu deploy cloudflare           # wrangler.toml from your plugins, then wrangler deploy
```

## Performance

`bun bench/run.ts` compares in-process `fetch()` throughput with Elysia and Hono on the same
Bun. See [bench/README.md](bench/README.md) for the latest numbers and method.

## Security defaults

- **Sessions:** signed (HMAC-SHA256) `HttpOnly`, `SameSite=Lax` cookies; the id is rotated on login.
  Unsafe requests that carry the cookie must come from the same origin (or a `trustedOrigins` site).
- **Login CSRF:** `/auth/login`, `/auth/register` and `/auth/logout` are tagged `csrf-always`.
  Cross-site browser requests are rejected (403 `MIU_E_CSRF`) even without a cookie. Clients that
  send no `Origin` (curl, servers) still work.
- **Brute force:** login is limited to 10 attempts per IP+account, 50 per account and 100 per IP per
  15 minutes. Register is limited to 10 per IP per hour. Over the limit gives 429 with `Retry-After`.
  - The client IP is `ctx.ip`: Cloudflare's address on Workers, the socket address on Bun. Behind
    your own proxy, set `auth({ rateLimit: { trustProxyHeader: "x-real-ip" } })`.
  - The default limiter keeps counts in memory, which is exact on one server. On Workers each
    isolate counts separately, so use `cloudflareRateLimiter("BINDING")` and/or Turnstile.
- **Account enumeration:** login gives the same error and timing for unknown emails and wrong
  passwords. Register still returns 409 for a taken email. Fully hiding that needs email
  verification, which MiuJS doesn't have yet. Until then the register limit keeps probing slow.
- **API tokens:** shown once and stored as SHA-256 hashes. Passwords use argon2id on Bun, otherwise
  PBKDF2 (600k iterations). Legacy bcrypt and Django hashes are upgraded on the next login.

## Roadmap

MiuJS grows in four phases. Each phase ends with a starter template (`miu new --template ...`)
that runs end to end. The full plan is in the
[spec](https://claude.ai/code/artifact/cea50b68-c0e3-4821-a540-fb6b0f4903fc).

| Phase | Status | What it adds |
| --- | --- | --- |
| **1. Foundations** | In progress | `@miujs/files` (uploads, signed URLs, resumable uploads, R2), `@miujs/web` (static files, HTML/JSX without a build, htmx, Vite, security headers), `@miujs/access` (roles, per-record policies, organizations, invites), `@miujs/audit` (tamper-evident audit log), `@miujs/mail` (+ email verification and password reset), `@miujs/workflows` (durable automation) |
| **2. Admin + CRM kit** | Planned | Define a resource once and get tables, API, MCP tools, lifecycle events and an admin UI. Pipelines, tasks, search, CSV import/export, and a visual workflow builder |
| **3. Game kit** | Planned | Room timers on Durable Object alarms, matchmaking and lobbies, join codes, leaderboards, achievements, Unity/Godot clients |
| **4. 3D tour kit** | Planned | 360° tiling and 3D model compression jobs, hotspots and floor plans, live guided tours, viewing analytics. Healthcare building blocks: field encryption, consent, retention |

### Automation workflows

Workflows are durable: a run survives restarts and deploys while it sleeps or waits for an event.

```ts
export const followUp = defineWorkflow("contact-follow-up", {
  trigger: on("contact.created"),
  input: t.object({ contactId: t.string(), email: t.string() }),
  run: async ({ input, step }) => {
    const lead = await step.run("enrich", () => enrich(input.email));   // journaled, retried
    await step.sleep("wait-a-day", "1d");
    const reply = await step.waitForEvent("reply", { event: "email.replied", match: { "data.contactId": input.contactId }, timeout: "3d" });
    if (!reply) await step.run("follow-up", () => sendFollowUp(lead));
  },
});
```

- **Triggers:** events, cron schedules, signed webhooks, or a manual start.
- **Control:** approvals, retries, cancel and retry-from-failed-step, and run history.
- **AI agents:** MCP tools so agents can start and inspect runs.
- **No-code:** the same engine runs JSON-defined workflows, which phase 2's visual builder will
  produce.

## Known limitations (0.1)

- **Cloudflare:** never deployed to a real account. Durable Objects, D1, KV and Queues are tested
  against in-test fakes, and every package bundles for a Workers target. Pending `after`/`tick`
  room timers are lost when a Durable Object hibernates.
- **Deno and Node:** `bun run smoke` runs the same HTTP checks on Bun, Node 24 and Deno 2 (routing,
  validation, body limits, cookies, `ctx.ip`, MCP, `waitUntil`); all pass. The full test suite runs on
  Bun only. Published packages will need prebuilt JS for Node, because Node won't strip types inside
  `node_modules`.
- **Speed:** level with Elysia on validated bodies, 20–30% behind on trivial routes
  ([bench](bench/README.md)).
- Not built yet: JSX responses, Drizzle integration, a SQLite queue adapter, deploy targets
  other than Cloudflare, email verification, and server-side revocation for cookie-only sessions
  (use a server session store if logout must invalidate copied cookies).

## Developing MiuJS

```bash
bun install
bun test
bun run typecheck
```

Read [AGENTS.md](AGENTS.md) for the rules (test-first, erasable TypeScript, web standards only).

## License

Dual-licensed: [AGPL-3.0](LICENSE) for everyone, or a paid commercial license if you can't
release your source under the AGPL. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
