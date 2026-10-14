# MiuJS guide

MiuJS is a TypeScript web framework for Bun, Node and Cloudflare Workers. You declare a route with a schema once
and get validated, typed input, an MCP tool for agents, an OpenAPI operation and an llms.txt entry.

- [Getting started](#getting-started)
- [Routing](#routing)
- [Schemas](#schemas)
- [Context](#context)
- [Middleware](#middleware)
- [Errors](#errors)
- [Agents: MCP, OpenAPI, llms.txt](#agents-mcp-openapi-llmstxt)
- [Client](#client)
- [CLI](#cli)

For deployment (Bun, Node, Workers, Docker) see [deploy.md](deploy.md).

## Getting started

Scaffold an app:

```bash
bunx miujs create my-app                      # Bun (default)
bunx miujs create my-app --template node      # Node 22+
bunx miujs create my-app --template workers   # Cloudflare Workers
cd my-app && bun install && bun run dev
```

Or add it to an existing project with `bun add miujs` and write `src/app.ts`:

```ts
import { Miu, t, HttpError, mcp, openapi } from "miujs";

const app = new Miu({ name: "todo-api", version: "1.0.0", description: "Todos for humans and agents" })
  .use(openapi()) // GET  /openapi.json
  .use(mcp())     // POST /mcp — every route below is an agent tool
  .get("/todos/:id", { summary: "Get a todo", params: t.object({ id: t.integer() }) }, (c) => {
    if (c.params.id > 100) throw new HttpError(404, "Todo not found");
    return { id: c.params.id, title: "Buy milk" }; // c.params.id is a number
  });

export default app; // `bun src/app.ts` serves it on :3000 (or $PORT)
```

`new Miu(options)` takes `name`, `version` and `description` (used by OpenAPI, MCP and llms.txt) and `logger`
(log unexpected 500s with `console.error`, default `true`).

## Routing

```ts
app.get(path, handler)
app.get(path, meta, handler)   // also .post .put .patch .delete .options .all
app.on("GET", path, meta, handler)
```

- **Params:** `/users/:id`. Static segments win over params (`/users/me` beats `/users/:id`).
- **Wildcard:** a trailing `*` matches the rest of the path; it is available as `c.params["*"]` and exposed to
  agents as a `path` argument.
- **405:** a path that exists for another method returns `405` with an `Allow` header. `HEAD` is answered for
  every `GET` route.
- Trailing slashes are normalized (`/todos/` registers `/todos`).

Handlers return a value and Miu picks the response: object → JSON, string → `text/plain`, `undefined` → `204`,
`Response` / `ReadableStream` / `Blob` / `Uint8Array` → sent as-is.

### Route meta

| Field | Purpose |
| --- | --- |
| `params`, `query`, `body`, `headers` | Schemas; validated input lands on `c.params`, `c.query`, `c.body`, `c.headers` |
| `response` | Schema of a successful response (documented in OpenAPI, MCP `outputSchema`, llms-full.txt) |
| `summary`, `description`, `tags`, `operationId`, `deprecated` | Documentation |
| `hidden` | Leave out of OpenAPI and llms.txt |
| `tool` | `false` to hide from MCP and llms.txt, or `{ name, description }` to rename / describe the tool |
| `use` | Middleware that runs for this route only, after global middleware |

### Composition

```ts
const users = new Miu().get("/", listUsers).get("/:id", showUser);
app.route("/api/users", users); // mounts routes and middleware under the prefix
```

`app.routes` is the list of `{ method, path, meta, handler }` — everything the agent features read.

## Schemas

The built-in `t` builder produces plain data, so one schema gives validation, TypeScript types and JSON Schema.

```ts
t.string({ min, max, pattern, format: "email" | "uuid" | "url" | "date" | "date-time" })
t.number({ min, max }) · t.integer() · t.boolean() · t.literal(v) · t.enum(["a", "b"])
t.array(item, { min, max }) · t.object(shape) · t.record(value) · t.union(a, b)
t.optional(s) · t.nullable(s) · t.default(s, value) · t.any()
```

Every builder (except the wrappers) accepts `description` and `example`, which show up in JSON Schema.

- Params, query, headers and form bodies are **coerced** (`"42"` → `42`, `"1"`/`"true"` → `true`). JSON bodies
  are not.
- Unknown object keys are stripped.
- Repeated query keys (`?tag=a&tag=b`) and `tag[]=` become arrays.
- Bodies may be JSON, `application/x-www-form-urlencoded` or `multipart/form-data`.
- Any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype) works wherever a `t` schema does. Its
  JSON Schema comes from the library's `toJSONSchema()` when it has one.

Helpers: `validate(schema, value, { coerce })` returns `{ ok, value } | { ok: false, issues }`, `toJSONSchema(schema)`,
and the `Infer<typeof schema>` type.

## Context

```ts
c.req · c.url · c.method · c.params · c.query · c.body · c.env · c.executionCtx · c.app
c.set(key, value) · c.get(key)                    // request-scoped variables
c.cookie(name) · c.setCookie(name, value, opts) · c.deleteCookie(name)
c.status(201) · c.header(name, value)
c.json(data, status?) · c.text(s) · c.html(s) · c.redirect(url, 302) · c.newResponse(body, status, headers)
```

Type bindings and variables with the app's generic: `new Miu<{ Bindings: { DB: D1Database }; Variables: { user: User } }>()`.

## Middleware

```ts
app.use(async (c, next) => {
  const t0 = Date.now();
  await next();
  c.res.headers.set("x-time", String(Date.now() - t0));
});
app.use("/admin/*", (c, next) => (c.get("user") ? next() : c.json({ error: "unauthorized" }, 401)));
```

Middleware runs in onion order. Return a `Response` to short-circuit; otherwise call `next()`. After `next()`,
`c.res` holds the response, including error responses — errors are converted at the level they are thrown, so
outer middleware (CORS, request ids, logging) still runs.

Built-in batteries (`cors`, `secureHeaders`, `requestId`, `logger`, `rateLimit`, `cache`, `sessions`, `auth`,
queues, stores) are documented in the [README](../README.md#batteries).

## Errors

```ts
throw new HttpError(404, "Todo not found", { code: "todo_missing", details: { id } });
```

Every error is RFC 9457 `application/problem+json`:

```json
{ "type": "about:blank", "title": "Not Found", "status": 404, "detail": "Todo not found", "code": "todo_missing" }
```

- Validation failures are `422` with `code: "validation_failed"` and `issues: [{ path: ["body", "title"], message }]`.
- Malformed JSON is `400` (`code: "invalid_json"`); unsupported content types are `415`.
- Unexpected errors become a `500` that never leaks the message.
- Customize with `app.onError((err, c) => Response)` and `app.notFound((c) => Response)`.

## Agents: MCP, OpenAPI, llms.txt

```ts
import { Miu, mcp, openapi, llms } from "miujs";

app
  .use(mcp({ instructions: "Todo API. Create todos with post_todos." }))
  .use(openapi())
  .use(llms({ intro: "Agents: prefer the MCP endpoint." }));
```

### MCP

`mcp({ path = "/mcp", forwardHeaders = ["authorization", "cookie", "x-api-key"], instructions })` is a Model Context
Protocol server (Streamable HTTP transport, JSON responses; protocol versions 2025-06-18, 2025-03-26, 2024-11-05).

- Every `GET`/`POST`/`PUT`/`PATCH`/`DELETE` route is a tool unless `tool: false`.
- Tool names default to operation ids: `GET /todos/:id` → `get_todos_by_id`.
- The input schema merges path params, query and body properties.
- `GET` tools are `readOnlyHint`, `DELETE` tools `destructiveHint`, `GET`/`PUT`/`DELETE` `idempotentHint`.
- A tool call is replayed as a real HTTP request through `app.fetch`, with the forwarded headers, so auth, rate
  limits and validation apply exactly as for browsers. HTTP errors come back as `isError: true` results that the
  model can read and recover from.

`listTools(app)` returns the same tool list without a server.

### OpenAPI

`openapi({ path = "/openapi.json", servers })` serves an OpenAPI 3.1 document; `generateOpenAPI(app, { servers })`
returns it. Hidden routes are omitted; error responses reference a shared `Problem` schema.

### llms.txt

`llms({ path = "/llms.txt", fullPath = "/llms-full.txt", baseUrl, intro, sections, mcpPath, openapiPath })` serves
an [llms.txt](https://llmstxt.org) index and a full version as `text/plain`. Both are generated on the first request
and cached.

- **llms.txt** — `# name`, `> description`, version and `intro`, then an **API** section with one line per route
  (method, path, summary, input fields with types, tool name), an **Agent access** section linking the MCP endpoint,
  `/openapi.json` and `/llms-full.txt`, then your `sections`.
- **llms-full.txt** — every route with its description, tags and the JSON Schemas of its path params, query, headers,
  body and response.
- Links are absolute using `baseUrl`, or the request's origin when served by the middleware.
- Hidden routes, `tool: false` routes, `ALL` and non-HTTP-verb routes (e.g. WebSockets) are excluded.
- Set `mcpPath` / `openapiPath` to where you mounted those, or `false` to omit the link.

```ts
llms({
  sections: [{ title: "Docs", links: [{ title: "Guide", url: "https://example.com/guide", description: "How it works" }] }],
});
```

`generateLlmsTxt(app, opts)` and `generateLlmsFullTxt(app, opts)` return the text, e.g. for a static build.

## Client

`miujs/client` is a small fetch-based client that runs in browsers, Bun, Node, Deno and Workers.

```ts
import { createClient, ClientError } from "miujs/client";

const api = createClient("https://api.example.com", {
  headers: () => ({ authorization: `Bearer ${getToken()}` }), // object or (async) function
});

const todo = await api.get<Todo>("/todos/:id", { params: { id: 1 } });
const list = await api.get("/todos", { query: { tag: ["a", "b"], limit: 10 } }); // ?tag=a&tag=b&limit=10
await api.post("/todos", { body: { title: "Ship it" } });                     // JSON body
await api.request("PATCH", "/todos/:id", { params: { id: 1 }, body: { done: true }, headers: { "x-trace": "1" } });

try {
  await api.get("/todos/:id", { params: { id: 999 } });
} catch (e) {
  if (e instanceof ClientError) console.log(e.status, e.problem.detail); // 404 "Todo not found"
}
```

- `:params` are URL-encoded; a trailing `*` takes `params.path`.
- `query` values that are `undefined`/`null` are skipped; arrays repeat the key.
- Plain objects are sent as JSON; `FormData`, `Blob`, strings and streams are sent as-is.
- JSON and problem+json responses are parsed, other responses return text, `204` returns `undefined`.
- Non-2xx responses throw `ClientError` with `status`, `problem` (parsed body) and `response`.
- Result types are not inferred from routes yet; pass them explicitly (`api.get<Todo>(...)`).

To call an app in-process (tests, server-side rendering), pass its `fetch`:

```ts
const api = createClient("http://local", { fetch: (input, init) => app.fetch(new Request(input, init)) });
```

### MCP client

`createMcpClient(url, { headers, fetch })` speaks Streamable HTTP (JSON or SSE responses) — handy for testing what
agents see:

```ts
import { createMcpClient } from "miujs/client";

const agent = createMcpClient("http://localhost:3000/mcp", { headers: { authorization: "Bearer test" } });
await agent.initialize();                       // { protocolVersion, serverInfo, capabilities }
const tools = await agent.listTools();          // McpToolInfo[]
const r = await agent.callTool("get_todos_by_id", { id: 1 });
r.isError; r.structuredContent; r.content[0].text;
```

JSON-RPC errors (unknown tool, bad method) throw `McpClientError` with the JSON-RPC `code`. `agent.rpc(method, params)`
sends any other request.


### Typed client

Pass your app's type to `createClient` and every call is checked against your routes — params, query and
body come from the route schemas, the result from `response` (or the handler's return type):

```ts
// server.ts
export const app = new Miu()
  .get("/todos/:id", { params: t.object({ id: t.integer() }), response: Todo }, (c) => db.todo(c.params.id))
  .post("/todos", { body: t.object({ title: t.string() }) }, (c) => db.create(c.body));
export type App = typeof app;

// web.ts
import { createClient } from "miujs/client";
import type { App } from "./server.ts";

const api = createClient<App>("https://api.example.com");
const todo = await api.get("/todos/:id", { params: { id: 1 } }); // { id: number; title: string; ... }
await api.post("/todos", { body: { title: "Ship" } });
// api.get("/todos/:id")          -> type error: params required
// api.put("/todos")              -> type error: no PUT /todos route
```

Chain route registrations (`new Miu().get(...).post(...)`) so the type records them; sub-apps mounted with
`.route("/v1", v1)` appear under their prefix. Handlers that return `c.json(...)` give `unknown` — add a
`response` schema for a typed result. Without the type argument the client is untyped (`client.get<T>(path)`).

## CLI

The `miu` command runs on Bun (`bunx miu …`) and on Node 22 (`node --experimental-strip-types bin/miu.ts …`).
`[entry]` is a module whose default export — or named `app` export — is a Miu app; it defaults to `src/app.ts`.

| Command | What it does |
| --- | --- |
| `miu create <dir> [--template bun\|node\|workers] [--name pkg] [--force]` | Scaffold an app. Refuses a non-empty directory unless `--force` |
| `miu routes [entry]` | Route table: `METHOD PATH TOOL SUMMARY` |
| `miu openapi [entry] [--out file] [--server url]` | OpenAPI 3.1 JSON |
| `miu llms [entry] [--full] [--base-url url] [--out file]` | llms.txt / llms-full.txt |
| `miu tools [entry] [--out file]` | MCP tool list as JSON |
| `miu wrangler [--name] [--main] [--kv NAME] [--d1 NAME[:db]] [--r2 NAME[:bucket]] [--queue NAME[:queue]] [--do Class\|NAME:Class] [--nodejs-compat] [--out file] [--force]` | Generate `wrangler.toml` |
| `miu introspect sqlite:<path>` | Generate schemas from an existing database (requires the migration kit) |
| `miu --help`, `miu --version` | |

```bash
miu routes
# METHOD  PATH        TOOL                SUMMARY
# GET     /todos      get_todos           List todos
# GET     /todos/:id  get_todos_by_id     Get a todo
# POST    /todos      post_todos          Create a todo

miu openapi --out openapi.json
miu llms --base-url https://api.example.com --out public/llms.txt
```

Importing the entry runs its top-level code, so point the CLI at the module that builds the app (`src/app.ts`),
not at a file that starts a server. Set `MIU_DEBUG=1` to see stack traces for unexpected errors.
