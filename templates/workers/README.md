# {{name}}

A [MiuJS](https://github.com/khangkhangg/miujs) app on Cloudflare Workers.

```bash
npm install
npm run dev       # wrangler dev, http://localhost:8787
npm run deploy    # wrangler deploy
```

Routes live in `src/app.ts`; `src/worker.ts` is the Workers entry. Add KV, D1, R2, Queue or Durable Object
bindings by regenerating `wrangler.toml`:

```bash
npx miu wrangler --name {{name}} --kv CACHE --d1 DB --out wrangler.toml --force
```

## Agent access

- `GET /openapi.json` — OpenAPI 3.1 document
- `POST /mcp` — MCP server; every route is a tool (`get_root`, `get_todos`, `get_todos_by_id`, `post_todos`)

```bash
curl -X POST localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Inspect routes and tools without starting a server:

```bash
npx miu routes src/app.ts
npx miu tools src/app.ts
npx miu llms src/app.ts --out llms.txt
```

Built with [MiuJS](https://github.com/khangkhangg/miujs).

