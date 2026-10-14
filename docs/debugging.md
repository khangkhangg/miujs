# Debugging MiuJS apps with browser DevTools

MiuJS is meant to be debuggable from Chrome DevTools: breakpoints in your TypeScript, `Server-Timing` in the
Network tab, readable errors in development, and a request inspector at `/__miu`. This page shows how to turn
each one on and what keeps them out of production.

```ts
import { Miu, devErrors, devLogger, inspector, timing } from "miujs"; // portable: Bun, Node, Workers

const app = new Miu()
  .use(inspector()) // first: records every request
  .use(timing()) // second: `total` then covers the rest of the pipeline
  .use(devLogger())
  .onError(devErrors());
```

A full runnable version is in [`examples/devtools.ts`](../examples/devtools.ts):

```sh
MIU_ENV=development bun --inspect examples/devtools.ts
```

## Development or production?

Every dev feature checks `isDev(env)`. Unless you say otherwise, it assumes production:

| `MIU_ENV` | `NODE_ENV` | `isDev()` |
| --- | --- | --- |
| `development` / `dev` / `test` | anything except `production` | **true** |
| unset | `development` / `test` | **true** |
| `production` | anything | false |
| anything | `production` | false |
| unset or unknown (`staging`, …) | unset or unknown | false (handled like production) |

- If either variable says `production`, the result is production.
- If the environment is missing or unrecognised, MiuJS treats it as production. Bun and Node do not set
  `NODE_ENV` on their own, so set `MIU_ENV=development` in your dev script (`bun test` sets `NODE_ENV=test`).
- Variables are read from the `env` argument first, then `process.env` (Bun, Node, Workers with
  `nodejs_compat`), then `Deno.env`. The middleware passes `c.env`, so on Cloudflare Workers you can set the
  value as a var in `wrangler.toml` (`[vars] MIU_ENV = "development"`) or in `.dev.vars`.
- `isProduction(env)` is true only when one of the variables explicitly says `production`.

| Feature | Default | In production |
| --- | --- | --- |
| `timing()` | on in dev | off; `{ enabled: true }` turns it on (some teams want it behind a CDN) |
| `devErrors()` | on in dev | **always off** unless `{ force: true }`; `enabled: true` alone does not override production |
| `inspector()` | on in dev | **always off** unless `{ force: true }`; `/__miu` then falls through to your 404 |
| `devLogger()` | colored lines | one JSON line per request (same output as `logger({ format: "json" })`) |

## Breakpoints in TypeScript

### Bun

```sh
MIU_ENV=development bun --inspect examples/devtools.ts      # or --inspect-brk to pause on the first line
```

Bun prints a `https://debug.bun.sh/#localhost:6499/…` link. Open it in Chrome to get a DevTools-style debugger
for your `.ts` files. Bun transpiles internally and maps positions back to your source, so stack traces and
breakpoints use your original TypeScript line numbers. `bun --inspect-wait` waits until a debugger attaches.
In VS Code, use the Bun extension's "Attach" configuration with the same port.

### Node 22+

```sh
MIU_ENV=development node --experimental-strip-types --inspect examples/node.ts
```

Open `chrome://inspect` → **Open dedicated DevTools for Node** (or click *inspect* under Remote Target).
`--experimental-strip-types` replaces type annotations with whitespace, so line and column numbers already
match your `.ts` files and no source map is needed. To debug the compiled `dist/` build instead, run with
`--enable-source-maps`. The `dist/*.js` build ships `.js.map` files, so DevTools and stack traces point back
to `src/*.ts`.

Tip: when DevTools is attached, `console.*` output (including `devLogger()` groups and `devErrors()` logs) also
appears in the DevTools **Console**, and error stacks there are clickable.

### Cloudflare Workers

```sh
npx wrangler dev          # then press  d  to open DevTools
```

Wrangler opens Chrome DevTools connected to the local workerd isolate. You get breakpoints (Wrangler bundles
with source maps), the Console and a Memory profiler. Pass dev settings as bindings: `MIU_ENV = "development"`
in `.dev.vars`. Workers have no `process.env`, so `c.env` is the only place the setting can come from. The
inspector's buffer lives in the isolate's memory: Wrangler runs a single isolate, so this works locally. On
deployed Workers the buffer would be split across isolates, which is one more reason it stays off there.

## Network tab: `Server-Timing`

`timing()` adds a `Server-Timing` header. In DevTools → **Network** → select a request → **Timing**, the
metrics appear under "Server Timing":

```ts
app.use(timing());

app.get("/tours/:id", async (c) => {
  const t = c.get("timing"); // or getTiming(c): returns a no-op timer if timing() isn't installed
  t.start("db", "SELECT tour");
  const tour = await db.get(c.params.id);
  t.end("db");
  const scenes = await t.measure("scenes", () => loadScenes(tour), "Load scenes"); // async or sync
  t.add("cache", undefined, "miss"); // marker without duration
  return { ...tour, scenes };
});
// Server-Timing: db;desc="SELECT tour";dur=4.1, scenes;desc="Load scenes";dur=2.3, cache;desc="miss", total;dur=7.9
```

- Metric names are cleaned to header tokens: characters that are not allowed become `_`. In descriptions,
  quotes and backslashes are escaped, and non-ASCII or control characters become `?`.
- Timers that are never ended are closed when the response is sent. `measure()` records its time even when
  the function throws.
- Error responses get the header too.
- `allowOrigin: "https://app.example"` sends `Timing-Allow-Origin`, so a frontend on another origin can read the
  timings through `performance.getEntriesByType("resource")`. DevTools shows them either way.
- The header is off in production by default because it shows how long internal work takes, which helps
  timing attacks and leaks your architecture. If you want it there, opt in with `timing({ enabled: true })`.

## Readable errors: `devErrors()`

```ts
app.onError(devErrors({ editor: "vscode" })); // editor is optional: makes stack frames clickable links
```

In development:

- **Browsers** (`Accept: text/html`) get an HTML page. It shows the error name and message, the first
  application `file:line:col`, the stack (your frames in bold, `node_modules`/runtime frames dimmed), the
  `cause` chain, and the request: method, URL, route params, query, body and headers. Everything is
  HTML-escaped, the page sends a strict CSP with no script, and it is `no-store`.
- **API clients** get `application/problem+json` with extra fields: `name`, `stack` (array of frames),
  `location`, `cause` (`[{ name, message, stack, location }]`) and `request`. These are readable in the
  Network tab's **Preview**.
- The **console** gets `[miu] 500 GET /path → /abs/path/file.ts:12:5` followed by the error object. Most
  terminals (VS Code, iTerm, WezTerm) make the path clickable.
- **Secrets are redacted** everywhere: `authorization`, `cookie`, `set-cookie`, `x-api-key`, and any header,
  query parameter or JSON/form body field whose name matches
  `/token|secret|passw(or)?d|api[-_]?key|credential|session|cookie/i`. Add your own pattern with
  `devErrors({ redact: /ssn|iban/i })`.

In production, or with `enabled: false`, it behaves exactly like the built-in handler: an `HttpError` renders
its own problem+json, and anything else becomes a bare `500` with no message or stack (it is logged with
`console.error` unless `new Miu({ logger: false })`).

Stack positions come from the runtime. Bun and Node with strip-types already report `.ts` positions. For
bundled code, enable source maps (`node --enable-source-maps`, Wrangler does it automatically).

## Request inspector: `/__miu`

```ts
app.use(inspector()); // register first
```

When you start the app, the first request prints:

```
[miu] Request inspector: http://localhost:3000/__miu?token=4f1c…
```

Open that URL. The token is exchanged for an `HttpOnly; SameSite=Strict` cookie scoped to `/__miu`, and you are
redirected to `/__miu` so the token does not stay in the address bar. The UI is a single page with no build
step and no external assets, so it works offline. It follows your light/dark preference and has a toggle.

- **Requests**: the last `limit` (default 200) requests, newest first, with live updates over SSE. You can
  filter by text, method, status class, errors only, or MCP calls only. The detail pane shows the matched
  route, a timing waterfall from `Server-Timing` marks, redacted request and response headers, sizes, and the
  error (name, message, `file:line`, stack, causes) when `devErrors()` is installed. For calls to the MCP
  endpoint it shows the JSON-RPC method and the **tool name**. The in-process HTTP call the tool makes appears
  as its own row.
- **Routes**: every route with its MCP tool name (or `—` when `tool: false`), plus links to `/openapi.json`,
  `/llms.txt` and the MCP endpoint when the app serves them.
- **JSON API** (same auth; also accepts `Authorization: Bearer <token>`, handy for `curl`):
  `GET /__miu/api/requests`, `GET /__miu/api/requests/:id`, `DELETE /__miu/api/requests`,
  `GET /__miu/api/routes`, and `GET /__miu/events` (SSE events `request`, `update`, `clear`).

**Bodies are never read by default.** With `inspector({ captureBodies: true })`, textual request and response
bodies up to `maxBodySize` (64 KiB) are captured. The inspector reads a *clone* (a tee), so your handler still
gets the original stream. Capture happens in the background, so responses are never delayed, and
`text/event-stream` responses are skipped. JSON and form bodies are stored parsed, with secret fields redacted.

### Security model

1. **Off unless the environment is dev**, and never in production (`NODE_ENV`/`MIU_ENV=production`) without
   `force: true`. When it is off, `/__miu` falls through to your normal 404 and nothing is recorded.
2. **Loopback only.** Web-standard handlers cannot see the socket address, so the check is a heuristic:
   - the `Host` must be `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`, which also defeats DNS rebinding;
   - every forwarding header (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `Forwarded`, …) must name a
     loopback address;
   - a browser `Origin` must be the same host, and `Sec-Fetch-Site: cross-site` is refused.

   A refused request gets a plain 404. Replace the check with `allow: (c) => …`, for example to reach a dev
   box over a VPN. The token is still required.
3. **A token** (random per process, or `token:` with at least 16 characters) is compared in constant time. The
   page itself never contains it.
4. **Response headers**: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`,
   `Referrer-Policy: no-referrer`, `nosniff`, and a CSP of `default-src 'none'` with nonce-only scripts and
   styles and `connect-src 'self'`.
5. **Redaction**: the same rules as `devErrors()` apply to headers, query strings and bodies.

The buffer is per process (per isolate on Workers). That is fine for a dev tool, but with several instances
each one has its own buffer.

## Console: `devLogger()`

`devLogger()` builds on `logger()`. In development each request prints a colored line, then its timing marks
and, when it failed, the error with its `file:line:col`. With the default console sink these details sit in a
`console.groupCollapsed` group, which you can expand in the DevTools Console. In production the output is
exactly `logger({ format: "json" })`. Options: `write` (custom sink, details indented), `colors` (default on
unless `NO_COLOR`) and `pretty` (force one format).

```
GET /tours/1 200 7.1ms
  db 5.4ms SELECT tour
GET /tours/1/boom 500 1.2ms
  Error: Could not load scene graph
  → /home/me/app/src/routes/tours.ts:52:17
  caused by SyntaxError: JSON Parse error: Expected '}'
```

## Debugging MCP tools

Every route is also an MCP tool, and a tool call is a normal HTTP request inside the server, so the methods
above apply to it too:

- **See which tool ran**: the inspector labels `POST /mcp` rows with `tool: <name>` and also shows the inner
  request the tool made (e.g. `GET /tours/1`) with its own status, timings and error.
- **Call tools from a script or test** with the bundled client, and set breakpoints in the handlers:

  ```ts
  import { createMcpClient } from "miujs/client";

  const client = createMcpClient("http://localhost:3000/mcp", { headers: { authorization: "Bearer …" } });
  await client.initialize();
  console.table((await client.listTools()).map((t) => ({ name: t.name, description: t.description })));
  const result = await client.callTool("get_tours_by_id", { id: 1 });
  console.log(result.isError ? "tool failed" : "ok", result.structuredContent ?? result.content);
  ```

  You can do the same without a network: pass `fetch: (url, init) => app.request(url, init)` to
  `createMcpClient`.
- **Tool errors**: a tool that hits a 4xx/5xx returns `isError: true`, and the `content` text contains the
  problem+json body. In development that body includes `stack`/`location` from `devErrors()`, so the agent's
  transcript tells you exactly where it failed.
- **Tool names** are derived from the method and path (`GET /tours/:id` → `get_tours_by_id`) unless you set
  `tool: { name }`. The inspector's Routes tab lists them all.
