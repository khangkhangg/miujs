# Deploying MiuJS

A Miu app is a Web-standard `fetch(request, env?, ctx?)` handler, so the same `src/app.ts` runs on Bun, Node,
Cloudflare Workers and anything else that accepts `(Request) => Response`. Keep route definitions in a module that
only builds and exports the app, and put the runtime-specific startup in a small entry file.

## Bun

```ts
// src/app.ts
export default app;
```

```bash
bun src/app.ts            # serves the default export on $PORT (or 3000)
```

Bun automatically serves an entry file's default export when it has a `fetch` method. Use either
`export default app` or `app.listen(port, hostname?)` in an entry file, not both, or the port is bound twice.
`app.listen()` returns the Bun server (`server.port`, `server.stop()`).

Bun listens on all interfaces by default, which is what containers need. SQLite batteries (`miujs/sqlite`) use
`bun:sqlite`; keep the database file on a persistent volume.

## Node 22+

```ts
// src/server.ts
import { serve } from "miujs/node";
import app from "./app.ts";

const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`listening on http://localhost:${server.port}`);
// await server.close() for graceful shutdown
```

`serve(app, { port, hostname })` uses `node:http`, streams request and response bodies and keeps multiple
`set-cookie` headers. `toRequest` and `writeResponse` are exported too, for plugging Miu into an existing
`http.Server`.

MiuJS ships TypeScript sources. Node's `--experimental-strip-types` runs your own `.ts` files but refuses TypeScript
inside `node_modules`, so run the app with [`tsx`](https://tsx.is) (the Node template does: `tsx src/server.ts`)
or bundle it first (e.g. `esbuild src/server.ts --bundle --platform=node --format=esm --outfile=dist/server.js`).
SQLite batteries use `node:sqlite` (built into Node 22.13+).

## Cloudflare Workers

A Miu app *is* a Workers module — `app.fetch(request, env, ctx)` is the Workers signature:

```ts
// src/worker.ts
import app from "./app.ts";
export default app;
```

Type your bindings with the app generic and read them from `c.env`; use `c.executionCtx.waitUntil()` for work that
should outlive the response:

```ts
type Bindings = { CACHE: KVNamespace; DB: D1Database };
const app = new Miu<{ Bindings: Bindings }>({ name: "shop" })
  .get("/products/:id", { params: t.object({ id: t.integer() }) }, async (c) => {
    const row = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(c.params.id).first();
    c.executionCtx?.waitUntil(c.env.CACHE.put(`seen:${c.params.id}`, "1"));
    return row;
  });
```

### wrangler.toml with `miu wrangler`

`miu wrangler` writes a config with today's `compatibility_date` and the bindings you ask for:

```bash
miu wrangler --name shop --kv CACHE --d1 DB --r2 UPLOADS --queue JOBS --do ChatRoom --out wrangler.toml
```

```toml
name = "shop"
main = "src/worker.ts"
compatibility_date = "2026-10-14"
# compatibility_flags = ["nodejs_compat"]

# npx wrangler kv namespace create CACHE
[[kv_namespaces]]
binding = "CACHE"
id = "<CACHE_KV_ID>"

# npx wrangler d1 create shop-db
[[d1_databases]]
binding = "DB"
database_name = "shop-db"
database_id = "<DB_D1_ID>"

# npx wrangler r2 bucket create shop-uploads
[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "shop-uploads"

# npx wrangler queues create shop-jobs
[[queues.producers]]
binding = "JOBS"
queue = "shop-jobs"

[[queues.consumers]]
queue = "shop-jobs"

# export class ChatRoom from your worker entry
[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]
```

- Resource names default to `<name>-<binding>`; override with `NAME:resource` (`--d1 DB:prod-db`).
- `--do Class` derives the binding (`CHAT_ROOM`); use `--do ROOMS:ChatRoom` to choose it. Durable Objects use the
  SQLite storage backend.
- Run the `npx wrangler … create` commands shown in the comments and paste the returned ids over the placeholders.
- `nodejs_compat` is off by default because Miu does not need it; pass `--nodejs-compat` if your own code does.
- `--out` refuses to overwrite an existing file unless `--force`.

Then `npx wrangler dev` and `npx wrangler deploy`. Do not import `miujs/sqlite` in a Worker — it loads
`bun:sqlite`/`node:sqlite`, which Workers cannot bundle.

## Docker

Bun:

```dockerfile
FROM oven/bun:1 AS app
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "src/app.ts"]
```

Node:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["npx", "tsx", "src/server.ts"]
```

Mount a volume for SQLite files (`-v miu-data:/app/data` and `sqliteStore({ path: "data/app.sqlite" })`). For more
than one container, use a shared store and queue backend instead of local SQLite.

## Checklist

- Set `SESSION_SECRET` (≥ 32 chars) and other secrets through the platform, not in the image.
- Put `cors()`, `secureHeaders()` and `rateLimit()` in front of public routes; MCP tool calls go through the same
  middleware.
- Publish `/openapi.json`, `/mcp` and `/llms.txt` so agents can discover the API; `miu llms --out` can also write a
  static copy at build time.
