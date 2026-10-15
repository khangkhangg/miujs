# Postgres example

A todo API on Postgres with `@miujs/db/postgres`: Drizzle (`database.orm(ctx)`) and raw postgres.js (`ctx.sql`), a pooled connection on Bun, a Hyperdrive client per request on Cloudflare Workers. Guide: [docs/postgres.md](../../docs/postgres.md).

| File | What |
| --- | --- |
| `schema.ts` | Drizzle `pg-core` table |
| `migrations/0001_todos.sql` | The matching SQL, applied by `migrate.ts` with `migratePostgres()` |
| `app.ts` | Routes; `createApp(options)` and the default export (the Worker) |
| `serve.ts` | Runs the app on Bun with `app.listen()` |
| `wrangler.toml` | Workers config: `[[hyperdrive]]` binding and `nodejs_compat` |
| `test/` | Tests against PGlite (real Postgres in WASM) over TCP |

## Run on Bun

You need a Postgres server, for example `docker run -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=todos -p 5432:5432 postgres:17`.

```bash
cd examples/postgres
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/todos
bun migrate.ts
bun serve.ts
```

```bash
curl -X POST localhost:3000/todos -H "content-type: application/json" -d "{\"title\":\"Buy tea\"}"
curl localhost:3000/todos
curl localhost:3000/stats
```

## Run on Workers

```bash
bunx wrangler hyperdrive create todos --connection-string="postgres://user:pass@host:5432/todos"
# put the printed id into wrangler.toml, then:
DATABASE_URL=postgres://user:pass@host:5432/todos bun migrate.ts
bunx wrangler dev      # local: connects to localConnectionString
bunx wrangler deploy
```

`miu deploy cloudflare --dry-run --out wrangler.generated.toml` writes the same Hyperdrive block from the app's plugins.

## Test

```bash
bun test examples/postgres
```

The tests run the real postgres.js driver against PGlite served over TCP: SQL, Drizzle, transactions, a unique-constraint 409 and migrations run on real Postgres semantics. The Workers path is tested with a fake `HYPERDRIVE` binding whose `connectionString` points at PGlite. Not tested: a networked Postgres server and Hyperdrive itself; this example has not been deployed to a Cloudflare account.
