# Notes API example

A small notes API that uses every MiuJS battery:

| Battery | Used for |
| --- | --- |
| `@miujs/db` | SQLite locally, D1 on Cloudflare; `notes` table migration |
| `@miujs/session` + `@miujs/auth` | Register/login with a session cookie, or API tokens |
| `@miujs/cache` | Caches each user's note list for 60 s, cleared on writes |
| `@miujs/queue` | Runs a `note-created` job after each insert |

Every route is also an MCP tool at `/mcp`.

## Run

```bash
bun examples/api/app.ts
```

```bash
curl -X POST localhost:3000/auth/register -H "content-type: application/json" -H "origin: http://localhost:3000" -d "{\"email\":\"mia@example.com\",\"password\":\"correct horse\"}" -c jar
```

```bash
curl -X POST localhost:3000/notes -b jar -H "content-type: application/json" -H "origin: http://localhost:3000" -d "{\"title\":\"Buy tea\"}"
```

```bash
curl localhost:3000/notes -b jar
```

Set `SESSION_SECRET` (32+ characters) and `DB_PATH` (a SQLite file) for anything beyond a demo.

## Test

```bash
bun test examples/api
```

## Deploy to Cloudflare

```bash
miu deploy cloudflare --entry examples/api/app.ts --dry-run
```

This writes `wrangler.toml` with the D1 database (`DB`), the Queue (`JOBS`) and the cron triggers.
Set `SESSION_SECRET` with `wrangler secret put SESSION_SECRET` before deploying.
