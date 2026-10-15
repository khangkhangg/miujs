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

> Status: **0.2 preview**: the core, the CLI, 16 batteries and the admin/CRM, game and 3D tour kits are built and tested (3,300+ tests, soak-tested for memory and shutdown). Not yet deployed to a real Cloudflare account or published to npm. APIs may still change. See [the spec](https://claude.ai/code/artifact/cea50b68-c0e3-4821-a540-fb6b0f4903fc) for the full plan.

## Why MiuJS

| | |
| --- | --- |
| **One schema per route** | `t.object(...)` gives types, validation, OpenAPI, the MCP tool schema and test helpers. |
| **Agent-native** | `mcp: true` serves every route as an MCP tool at `/mcp`. `miu inspect --json` describes the whole app. Errors carry a stable `MIU_E_*` code and a `fix`. |
| **No build** | Erasable TypeScript, run as written. Validators are composed at startup without `eval`, so they work on Workers. |
| **Batteries** | Auth (passwords, OAuth, passkeys), sessions, SQL + Drizzle, cache, queues, files, mail, permissions, audit log, rate limits, workflows, AI and realtime rooms as official `@miujs/*` packages with swappable adapters (memory/SQLite/Redis/S3 locally, Cloudflare bindings in production). |
| **Games** | `@miujs/realtime` rooms run on Durable Objects or in-process — enough for a Kahoot-style quiz. `@miujs/game` adds matchmaking, lobbies, leaderboards and Unity/Godot clients. See [examples/quiz](examples/quiz). |
| **Bot-aware** | `@miujs/bots` tells humans from search engines, AI crawlers and scrapers (Cloudflare bot score, user agent, headers) and reads the visitor's country. Block them, give them partial data, or answer from a cache so they never touch your database. |
| **Back office** | `@miujs/admin` turns resource definitions into a CRM-style admin with tables, CSV import/export, a visual workflow builder, and a System area where every installed package shows its status, lists, settings and actions (also as MCP tools, permission-checked and audited). |
| **Fast and lean** | Starts in ~11 ms, validates JSON bodies faster than Elysia and Hono, and keeps memory flat under load (see [Performance](#performance)). |

## Packages

| Package | What it does |
| --- | --- |
| [`miujs`](packages/miujs) | Core: router, `t` schemas, errors, app, OpenAPI, MCP, WebSockets, Node adapter |
| [`@miujs/cli`](packages/cli) | `miu new / dev / test / inspect / openapi / check / add / deploy` |
| [`@miujs/auth`](packages/auth) | Email + password, API tokens, roles, legacy hash verification |
| [`@miujs/session`](packages/session) | Signed-cookie or server-side sessions, flash, CSRF protection |
| [`@miujs/db`](packages/db) | D1-compatible SQL on SQLite (Bun) and Cloudflare D1, migrations; Postgres over Hyperdrive with Drizzle |
| [`@miujs/cache`](packages/cache) | `remember()`, tags, memory LRU or Cloudflare KV |
| [`@miujs/queue`](packages/queue) | Typed jobs, retries with backoff, cron schedules, Cloudflare Queues |
| [`@miujs/realtime`](packages/realtime) | Authoritative rooms over WebSockets, Durable Objects, join codes, sharding, React/Vue/Svelte bindings |
| [`@miujs/files`](packages/files) | Uploads, signed URLs, resumable uploads; memory, disk, R2 and S3 stores |
| [`@miujs/web`](packages/web) | Static files, HTML templates and JSX without a build, htmx, Vite, security headers |
| [`@miujs/mail`](packages/mail) | Email templates and transports (Resend, HTTP), dev preview |
| [`@miujs/access`](packages/access) | Roles, permissions, per-record policies, organizations and invites |
| [`@miujs/audit`](packages/audit) | Tamper-evident audit log (HMAC hash chain, external anchors) |
| [`@miujs/workflows`](packages/workflows) | Durable automation: events, cron, webhooks, sleeps, approvals, JSON workflows |
| [`@miujs/ratelimit`](packages/ratelimit) | Rate limits by route, path or tag; memory, KV, Durable Object, Redis |
| [`@miujs/bots`](packages/bots) | Bot, AI crawler and location detection; block, trim or serve cached responses to crawlers |
| [`@miujs/ai`](packages/ai) | Claude, OpenAI-compatible and Workers AI; structured output, tool loops, RAG |
| [`@miujs/migrate`](packages/migrate) | Port Laravel, Django or FastAPI apps route by route (proxy, shared sessions, contract tests) |
| [`@miujs/admin`](packages/admin) | Admin + CRM kit: resources become tables, API, MCP tools and an admin UI; visual workflow builder; System area for every package |
| [`@miujs/game`](packages/game) | Game kit: matchmaking, lobbies, game rooms with timers, leaderboards, achievements, Unity/Godot clients |
| [`@miujs/tour`](packages/tour) | 3D and 360° tours: scenes, hotspots, floor plans, tiling jobs, live guided tours, analytics, field encryption |

Full guide: [docs/guide.md](docs/guide.md). Every error code: [docs/errors.md](docs/errors.md).

## Architecture

```
 Requests: browsers, apps, MCP agents, search and AI crawlers
     │
     ▼
 Visitor gate (@miujs/bots, optional) ── block (403) or cached copy ──▶ answered here: no handler, no DB
     │ full or partial
     ▼
 Your app: route files, rooms, jobs, workflows (plain TypeScript, no build)
     │
     ▼
 MiuJS core: router, t schemas, errors, plugins    Agent layer: MCP, OpenAPI, inspect    CLI (miu)
     │
     ▼
 Kits: admin (back office, CRM) · game · tour
     │
     ▼
 Batteries: auth session db cache queue realtime files web mail access audit workflows ratelimit ai migrate bots
     │
     ├─▶ Cloudflare bindings: D1, KV, R2, Queues, Durable Objects, Workflows, Cache API, bot score and geo
     └─▶ Local and self-hosted: SQLite, memory, disk, Redis, S3, HTTP mail
     │
     ▼
 Runtimes: Cloudflare Workers · Bun · Deno · Node
```

Your code talks only to the core and the battery APIs. The adapter under each battery is picked
by where the app runs, so the same files deploy to Workers, Bun, Deno or Node.

**Request path**, in order:

1. **Visitor gate** (`@miujs/bots`): classifies the caller (human, search, AI crawler, bot,
   unknown), reads location, then blocks, serves a cached copy, trims the response, or lets it
   through. Signed-in users, MCP and `/_miu/*` are never affected.
2. **Plugin `onRequest` hooks** in the order listed (session, auth, rate limits, access).
3. **Router and validation**: params, query and body checked against the route's schemas; bodies
   capped at `maxBodySize`.
4. **Handler**, then `onResponse` hooks (the bot cache stores eligible responses here).
5. **Background work** (`waitUntil`, jobs, room timers). `app.close()` drains it and calls each
   plugin's `stop()`, so processes exit cleanly.

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
  "docs": "https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#miu_e_validation", "details": { "issues": [...] } } }
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

In-process `fetch()` on Bun 1.4.3 against Elysia and Hono (Windows laptop, best of 3 rounds;
compare within a row, since absolute numbers move ±10% between runs):

| Scenario | MiuJS | Compared with the fastest of Elysia and Hono |
| --- | ---: | ---: |
| `POST /json`, body validation → JSON | ~400k req/s | **94–111%** (usually fastest) |
| `GET /users/:id`, params → JSON | ~1M req/s | **95–103%** |
| `GET /` text, called the way `Bun.serve` calls it | ~1.5M req/s | 83–101% |
| `GET /` text, plain `app.fetch(req)` | ~1.3M req/s | 81–91% |
| Cold start, process start → first response | **~11 ms** | Hono ~13 ms, Elysia ~53 ms |

MiuJS gets there without generating code at runtime (Workers forbid `eval` and `new Function`):
each route picks a specialized dispatcher at startup, unconstrained string params skip a no-op
validation, and repeated text responses are cloned from a cached `Response`. CI fails a pull
request that drops any of these ratios by more than 5% (`bench/compare.ts`).

Over real HTTP all three frameworks hit the same loopback ceiling (~72k req/s on this
machine). Memory kept per 10,000 requests is about zero for all three. Method and history:
[bench/README.md](bench/README.md); run it with `bun bench/run.ts` (`BENCH_HTTP=1` adds HTTP).

**On Cloudflare's runtime** (workerd, run locally with `bun run workerd`;
[report](scripts/workerd/REPORT.md)): the core bundle is **16.2 KB gzipped** (target under 60 KB),
the first request after a fresh start takes ~14 ms for the core alone and ~30 ms with auth, session
and cache, and a D1 read with a session check has p99 9.3 ms. These are local numbers, not edge
numbers.

**Memory and stability** ([soak report](scripts/soak/REPORT.md)): the example apps ran under
sustained load over real HTTP and WebSockets on Bun, Node and Deno.

- Heap stays flat on every runtime. Every package has a leak test (forced-GC rounds, bytes and
  objects per iteration) and an exit test (a process using it exits on its own).
- Shutdown takes 12–46 ms, and no request or socket is left hanging after clients disconnect.
- Fixes from the soak include:
  - **Sign-ins:** argon2id is capped at 19 MiB per hash and 4 hashes at a time. 32 concurrent
    sign-ins went from +1.3 GB to +78 MB.
  - **Game rooms:** finished rooms now close 5 s after the result. Live rooms after load went
    from 22,726 to 0, and heap from 132 MB to 3 MB.
  - **Long-polls:** they stop when the client disconnects.
  - **JSON bodies:** the read is faster, and peak heap per 10,000 requests dropped from 288 KB to 8 KB.

## Security defaults

- **Sessions:** signed (HMAC-SHA256) `HttpOnly`, `SameSite=Lax` cookies; the id is rotated on login.
  Unsafe requests that carry the cookie must come from the same origin (or a `trustedOrigins` site).
- **Login CSRF:** `/auth/login`, `/auth/register` and `/auth/logout` are tagged `csrf-always`.
  Cross-site browser requests are rejected (403 `MIU_E_CSRF`) even without a cookie. Clients that
  send no `Origin` (curl, servers) still work.
- **Brute force:** login is limited to 10 attempts per IP+account, 50 per account and 100 per IP per
  15 minutes. Register is limited to 10 per IP per hour. Over the limit gives 429 with `Retry-After`.
  - The client IP is `ctx.ip`: Cloudflare's address on Workers, the socket address on Bun. Behind
    your own proxy, set `miu({ trustProxy: { header: "x-forwarded-for" } })` (it reads the entry your
    proxy appended, never the client-supplied one).
  - The default limiter keeps counts in memory, which is exact on one server. On Workers each
    isolate counts separately, so use `cloudflareRateLimiter("BINDING")` and/or Turnstile.
- **Account enumeration:** login gives the same error and timing for unknown emails and wrong
  passwords. With `auth({ emailVerification: "required" })`, register and password reset answer
  the same way whether or not the email exists. With verification off, register still returns 409
  for a taken email, and the register limit keeps probing slow.
- **OAuth and passkeys:** provider sign-in links only to accounts whose email is verified, never
  taking over an existing account; signed-in users link and unlink providers explicitly. Passkeys
  use single-use server-side challenges and sign-counter clone detection.
- **Password reset** signs out other sessions, revokes API tokens, and removes passkeys and OAuth
  links, so whoever took over the account keeps no way back in.
- **API tokens:** created only from a signed-in browser session (a token cannot mint more tokens),
  shown once and stored as SHA-256 hashes. Passwords use argon2id on Bun, otherwise PBKDF2 (600k
  iterations). Legacy bcrypt and Django hashes are upgraded on the next login.
- **WebSockets:** a cross-origin handshake that carries cookies is refused (403
  `MIU_E_WS_ORIGIN`); list other sites with `ctx.upgrade({ origins: [...] })`. Client messages
  are capped at 1 MiB and a client that stops reading is closed once 1 MiB waits for it:
  `miu({ websocket: { maxPayloadLength, backpressureLimit } })`. Bun enforces both; Deno and
  Workers check message size per message; the Node adapter has no WebSockets.
- **MCP:** browser calls to `/mcp` from a non-loopback origin need `mcp: { allowedOrigins }`
  (DNS rebinding). Route tools keep their route's `auth` and `permission`; plugin tools declare
  `auth` / `permission` the same way, and `tools/list` shows each caller only what they may call.
- **Realtime rooms:** with `requireHostKey` only the key from `createRoom()` makes a host;
  `createOnJoin: false` means a random room URL is a 404, not a new room; `maxPlayers`,
  `maxMembers` (default 5000) and `maxConnectionsPerIp` (default 1000) cap rooms and clients.

## Roadmap

MiuJS grows in four phases. Each phase ends with a starter template (`miu new --template ...`)
that runs end to end. The full plan is in the
[spec](https://claude.ai/code/artifact/cea50b68-c0e3-4821-a540-fb6b0f4903fc).

| Phase | Status | What it adds |
| --- | --- | --- |
| **1. Foundations** | Done | `@miujs/files` (uploads, signed URLs, resumable uploads, R2), `@miujs/web` (static files, HTML/JSX without a build, htmx, Vite, security headers), `@miujs/access` (roles, per-record policies, organizations, invites), `@miujs/audit` (tamper-evident audit log), `@miujs/mail` (+ email verification and password reset), `@miujs/workflows` (durable automation) |
| **2. Admin + CRM kit** | Done (preview) | Define a resource once and get tables, API, MCP tools, lifecycle events and an admin UI. Pipelines, tasks, search, CSV import/export, and a visual workflow builder |
| **3. Game kit** | Done (preview) | Room timers on Durable Object alarms, matchmaking and lobbies, join codes, leaderboards, achievements, Unity/Godot clients |
| **4. 3D tour kit** | Done (preview) | 360° tiling and 3D model compression jobs, hotspots and floor plans, live guided tours, viewing analytics. Healthcare building blocks: field encryption, consent, retention |
| **5. Hardening** | Done | Leak and exit tests for every package, soak tests over HTTP and WebSockets, memory caps for password hashing, faster body reads, `app.close()` |
| **6. Traffic and operations** | Done (preview) | `@miujs/bots` (done): bot, AI crawler and location detection with block / partial / cached / full. Admin System area (done): every package shows its status, lists, settings and actions in the admin and as MCP tools |
| **7. Release readiness** | Done (preview) | Example apps run on Cloudflare's runtime locally (`bun run workerd`, 70 scenarios), npm packages verified on Node, Deno, Bun and a Workers bundle, Postgres over Hyperdrive (`@miujs/db/postgres`, [guide](docs/postgres.md)), per-route fast paths, CI benchmark gate |
| **Next** | Needs accounts | First deploy to a real Cloudflare account (edge bot score and geo, CPU limits, Queues at scale), first npm publish (needs the `@miujs` scope and the `miujs` name) |

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
- **No-code:** the same engine runs JSON-defined workflows, which the admin's visual builder
  produces.

## Known limitations (0.2)

- **Cloudflare:** never deployed to a real account. `bun run workerd` runs the example apps on
  Cloudflare's runtime locally (workerd through `wrangler dev --local`, with Miniflare's D1, KV, R2,
  Queues, Durable Objects, Workflows, rate limits and Cache API) over real HTTP and WebSockets; see
  [scripts/workerd/REPORT.md](scripts/workerd/REPORT.md). Still unverified without an account: edge
  bot scores and geo, CPU-time limits, Queues delivery timing and retries at scale, latency between
  locations. Pending `after`/`tick` room timers are lost when a Durable Object hibernates.
- **Deno and Node:** `bun run smoke` runs the same HTTP checks on Bun, Node 24 and Deno 2 (routing,
  validation, body limits, cookies, `ctx.ip`, MCP, `waitUntil`); all pass. The full test suite runs on
  Bun only. Node won't strip types inside `node_modules`, so the npm build ships prebuilt JS and
  `.d.ts` for Node and Deno (Bun still loads the TypeScript source).
- **Speed:** level with Elysia on params and validated bodies. A trivial text route is still
  9–19% behind when called as plain `app.fetch(req)`: MiuJS keeps `content-type` on the Response
  object (tests and plugins rely on it) and pays ~30–50 ns of generic dispatch that only runtime code
  generation would remove, which Workers forbid ([bench](bench/README.md)).
- **Bot detection:** without Cloudflare's bot score, detection relies on user agents and headers,
  so a crawler that copies a browser's headers passes as human.
- **Verified only against fakes:** Redis and S3 adapters (fake servers, AWS signature test vectors),
  Laravel/Django session crypto (independent reference ports, no real PHP/Python app yet), OAuth
  providers and the Anthropic/Workers AI APIs (recorded shapes, no live calls).
- **Not on npm yet:** the packages are release-ready (prebuilt JS and `.d.ts` for Node, Deno and
  bundlers; TypeScript source for Bun), and `bun scripts/release/verify.ts` installs the packed
  tarballs on Node 24, Deno 2, Bun, a Workers bundle and strict `tsc`. Publishing waits on the
  `@miujs` npm scope and the unscoped `miujs` name, which another project owns
  ([RELEASING.md](RELEASING.md)).

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
