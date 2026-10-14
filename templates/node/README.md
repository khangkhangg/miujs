# {{name}}

A [MiuJS](https://github.com/khangkhangg/miujs) app on Node 22+.

```bash
npm install
npm run dev     # http://localhost:3000
```

Routes live in `src/app.ts`; `src/server.ts` serves them with `miujs/node`. Scripts use `tsx` because Node's
built-in type stripping does not run TypeScript inside `node_modules`.

## Agent access

- `GET /openapi.json` — OpenAPI 3.1 document
- `POST /mcp` — MCP server; every route is a tool (`get_root`, `get_todos`, `get_todos_by_id`, `post_todos`)

```bash
curl -X POST localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Inspect routes and tools without starting a server:

```bash
npx miu routes src/app.ts
npx miu tools src/app.ts
npx miu llms src/app.ts --out llms.txt
```

Built with [MiuJS](https://github.com/khangkhangg/miujs).

