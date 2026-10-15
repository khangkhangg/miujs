# {{name}}

A [MiuJS](https://github.com/khangkhangg/miujs) back-office on Bun: SQLite for data and sessions, local disk for
uploads, a login page, and an admin UI generated from your schemas.

```bash
bun install
bun run dev        # http://localhost:3000/admin
```

On the first run an admin user `admin@example.com` is created; its password is printed once in the terminal
(set `ADMIN_PASSWORD` beforehand to choose it). Data lives in `./data` (`DATA_DIR`).

## Add a resource

Everything is in `src/app.ts`. To add, say, `tags`:

```ts
export const Tag = t.object({ name: t.string({ min: 1, max: 60 }) });                 // 1. schema
const tags = sqliteRepository<any>({ db, table: "tags", searchFields: ["name"] });   // 2. repository
// 3. in admin({ resources: { ... } }):
tags: { label: "Tags", schema: Tag, repo: tags, titleField: "name" },
```

The table is created automatically. Field widgets are inferred from the schema (enum → select, boolean →
checkbox, `format: "date"` → date picker); override them with `fields`, e.g.
`{ widget: "image" }` (needs `files`), `{ widget: "markdown" }`, or
`{ widget: "relation", relation: { resource: "authors", labelField: "name" } }`.
Per-action `permissions`, `hooks` and an audit log are available too.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | `MIU_ENV=development`, restarts on changes; enables the DevTools below |
| `bun run start` | production mode (requires `SESSION_SECRET`, sets `Secure` cookies) |
| `bun test` | `test/app.test.ts`: signs in and creates records via `app.request()` |
| `bun run typecheck` | `tsc --noEmit` |

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `DATA_DIR` | `data` (SQLite file and `uploads/`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / generated and printed on first run |
| `SESSION_SECRET` | random per start in development (sign-ins end on restart); **required** in production |
| `ADMIN_API_TOKEN` | unset; when set, `Authorization: Bearer <token>` acts as the admin (scripts, agents) |

## Agents and API

- `GET /openapi.json`: OpenAPI 3.1 for every admin action
- `POST /mcp`: MCP server; each resource gets `admin_list_*`, `admin_get_*`, `admin_create_*`,
  `admin_update_*` and `admin_delete_*` tools

```bash
curl -X POST localhost:3000/mcp -H "authorization: Bearer $ADMIN_API_TOKEN" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Debugging

With `bun run dev`: the request inspector link is printed at the first request (`/__miu?token=…`),
responses carry `Server-Timing` (DevTools → Network → Timing), and errors render a readable page with the
stack. Add `--inspect` to the `dev` script to set breakpoints in your TypeScript from Chrome DevTools.
None of this is enabled in production.

## Scaling out

SQLite and local disk are the single-server defaults. For several instances swap in a shared driver
(e.g. `redisStore` for sessions; `d1Repository`, `r2BlobStore` and `d1Store` from `miujs/cloudflare`): the admin only needs a
`Repository` and a `BlobStore`.

Built with [MiuJS](https://github.com/khangkhangg/miujs).
