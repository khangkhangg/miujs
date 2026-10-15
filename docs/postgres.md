# Postgres (and Cloudflare Hyperdrive)

`@miujs/db/postgres` connects a MiuJS app to Postgres: through a [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) binding on Cloudflare Workers, through a connection pool on Bun, Node and Deno. Each request gets Drizzle as `ctx.orm` and the [postgres.js](https://github.com/porsager/postgres) client as `ctx.sql`. `migratePostgres()` applies the same `NNNN_name.sql` migrations as `@miujs/db`.

A runnable app is in [examples/postgres](../examples/postgres).

## What is tested, and what is not

| Path | Tested against | Notes |
| --- | --- | --- |
| SQL, parameters, types, transactions, constraint errors | Real Postgres semantics: [PGlite](https://pglite.dev) (Postgres compiled to WASM) | The real postgres.js driver connects to PGlite over TCP with `@electric-sql/pglite-socket`, so the wire protocol is real too. |
| Drizzle (`drizzle-orm/postgres-js`): select, insert, `returning`, relational `query`, `transaction` | PGlite, as above | |
| `migratePostgres()`: ordering, bookkeeping, rollback, `$$` bodies, drizzle-kit files | PGlite, as above | |
| Hyperdrive wiring: client per request from `env.HYPERDRIVE.connectionString`, closed with `ctx.waitUntil` | A fake env binding plus runtime `"workerd"`; the connection behind it is PGlite | This is everything the plugin reads on Workers. |
| Pool closed by `app.stop()`; the process exits | PGlite, plus an exit check in a fresh process | |
| `miu deploy cloudflare` writing `[[hyperdrive]]` | CLI tests | |
| A networked Postgres server (TLS, auth, many concurrent backends) | Not tested | PGlite has one backend; tests use pools of 1. |
| Cloudflare Hyperdrive itself, and postgres.js running inside `workerd` | Not tested | Nothing here has been deployed to a real Cloudflare account. |

## Install

```bash
bun add @miujs/db miujs drizzle-orm postgres
```

`postgres` (postgres.js, `>=3.4.4`) and `drizzle-orm` are optional peer dependencies of `@miujs/db`, used only by the `@miujs/db/postgres` entry.

## Quick start (Bun)

```ts
import { eq } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { miu, route, t } from "miujs";
import { pg } from "@miujs/db/postgres";

const notes = pgTable("notes", { id: serial("id").primaryKey(), body: text("body").notNull() });
const database = pg({ schema: { notes } }); // DATABASE_URL, or pg({ url })

const addNote = route.post("/notes", {
  body: t.object({ body: t.string() }),
  handler: async (ctx) => (await database.orm(ctx).insert(notes).values(ctx.body).returning())[0],
});

const getNote = route.get("/notes/:id", {
  params: t.object({ id: t.integer() }),
  handler: async (ctx) => {
    const [row] = await ctx.sql`SELECT id, body FROM notes WHERE id = ${ctx.params.id}`;
    return row ?? null;
  },
});

export default miu({ name: "notes", routes: [addNote, getNote], plugins: [database] });
```

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/notes bun serve.ts
```

where `serve.ts` calls `await app.listen(3000)` (see [examples/postgres/serve.ts](../examples/postgres/serve.ts)). `app.stop()` (or stopping the server returned by `app.listen()`) closes the pool, so the process exits.

## `pg()` options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `"HYPERDRIVE"` | Hyperdrive binding name. |
| `hyperdriveId` | none | Hyperdrive config id, written to `wrangler.toml` by `miu deploy cloudflare`. |
| `localConnectionString` | none | What `wrangler dev` connects to instead of Hyperdrive; written to `wrangler.toml`. |
| `url` | `env.DATABASE_URL` | Connection string off Workers. |
| `max` | `10` | Pool size off Workers. |
| `options` | none | Extra postgres.js options for every client (`ssl`, `idle_timeout`, `onnotice`, `transform`, ...). |
| `schema`, `logger`, `casing` | none | Drizzle options. `schema` enables `orm.query.<table>`. |
| `migrations` | none | Applied once per connection string in this process or isolate, before its first request. Prefer running them out of band (see below). |
| `driver` | `postgres` | postgres.js client factory, to wrap or instrument clients. |

`database.orm(ctx)` and `database.sql(ctx)` return the same objects as `ctx.orm` and `ctx.sql`, typed with the plugin's schema.

### Typing `ctx.orm`

`ctx.orm` is typed as the D1/SQLite Drizzle by default. In a Postgres app, register the Postgres type once:

```ts
import type { PgOrm } from "@miujs/db/postgres";

declare module "@miujs/db/drizzle" {
  interface DrizzleRegister { orm: PgOrm<typeof schema> }
}
```

The registration is global to a TypeScript program. If one program mixes SQLite and Postgres (as the MiuJS repo does), skip it and use `database.orm(ctx)`. `ctx.sql` is always typed as the postgres.js `Sql`.

## Cloudflare Workers with Hyperdrive

Workers cannot keep a database socket open between requests, and opening a fresh TCP + TLS connection to Postgres on every request is slow. Hyperdrive sits between them: it keeps a warm pool near your database, and your Worker opens a cheap connection to Hyperdrive per request.

1. Create the Hyperdrive config (once per database):

   ```bash
   bunx wrangler login
   bunx wrangler hyperdrive create notes --connection-string="postgres://user:password@db.example.com:5432/notes"
   ```

   It prints an `id`.

2. Tell the plugin, so `miu deploy cloudflare` writes the binding:

   ```ts
   const database = pg({ schema, hyperdriveId: "<id>", localConnectionString: "postgres://postgres:postgres@localhost:5432/notes" });
   ```

3. Generate and deploy:

   ```bash
   miu deploy cloudflare --dry-run   # writes wrangler.toml and prints it
   miu deploy cloudflare             # writes it and runs wrangler deploy
   ```

   The generated config contains:

   ```toml
   compatibility_flags = ["nodejs_compat"]

   [[hyperdrive]]
   binding = "HYPERDRIVE"
   id = "<id>"
   localConnectionString = "postgres://postgres:postgres@localhost:5432/notes"
   ```

   `nodejs_compat` is required: postgres.js uses Node.js APIs on Workers (its `workerd` build opens sockets with `cloudflare:sockets`). Without `hyperdriveId`, the `id` line holds a placeholder that tells you which command to run; `wrangler deploy` fails until you replace it.

### Local development

- `bun serve.ts` with `DATABASE_URL`: the pooled path, no Hyperdrive involved.
- `bunx wrangler dev`: runs the Worker locally. The `HYPERDRIVE` binding's `connectionString` points at `localConnectionString`, so the per-request path runs against your local Postgres. Recent wrangler versions also read `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` from the environment instead, which keeps credentials out of `wrangler.toml`.

When a request's `env` has a Hyperdrive-shaped binding (`{ connectionString }`), `pg()` uses the per-request path on any runtime. That is how `wrangler dev` and the tests exercise it.

### The per-request client rule

On Workers, `pg()` creates a new postgres.js client for each request from `env.HYPERDRIVE.connectionString` and ends it after the response with `ctx.waitUntil(sql.end())`. Do not:

- keep a postgres.js client in module scope on Workers, or reuse `ctx.sql` from another request. Workers forbids I/O objects crossing requests and the request will hang or throw.
- start new queries on `ctx.sql` from `ctx.waitUntil` work or a streamed response body after the handler returned: `end()` lets running queries finish but rejects new ones. Create a client for that work yourself (`postgres(env.HYPERDRIVE.connectionString)`) and end it when done.

Per-request clients use `{ max: 5, fetch_types: false }`: up to 5 parallel queries per request, and no extra round trip to load array types. Pass `pg({ options: { fetch_types: true } })` if you use custom array types.

Without a Hyperdrive binding on Workers, `pg()` throws `MIU_E_DB_HYPERDRIVE_MISSING`, unless you pass `pg({ url })`, which then opens a direct connection per request (works, but every request pays the full connection setup).

## Pooling

| Where | Clients | Pool |
| --- | --- | --- |
| Bun, Node, Deno | One long-lived postgres.js client per app | `max` connections (default 10), opened lazily. Closed by `app.stop()`. |
| Workers + Hyperdrive | One client per request, up to 5 connections | Hyperdrive pools real connections to Postgres for you. |

Off Workers, size `max` below your server's `max_connections` divided by the number of app processes. If your database sits behind PgBouncer in transaction mode, pass `options: { prepare: false }`.

## Transactions

`ctx.sql.begin(async (tx) => ...)` and `ctx.orm.transaction(async (tx) => ...)` both work; a thrown error rolls back. Inside, use `tx`, not `ctx.sql` / `ctx.orm`: those run outside the transaction.

On Hyperdrive:

- Hyperdrive pools in transaction mode: a connection is yours only for the length of a transaction (or a single statement outside one). Session state does not survive between statements: `SET` (use `SET LOCAL` inside a transaction), session-level advisory locks (`pg_advisory_lock`; use `pg_advisory_xact_lock`), `LISTEN`/`NOTIFY`, temporary tables, and `WITH HOLD` cursors are not reliable.
- Keep transactions short and inside one request. An open transaction pins one pooled connection.
- Hyperdrive caches the results of some read queries. Turn caching off for a config if you need every read to hit the database: `bunx wrangler hyperdrive update <id> --caching-disabled`.
- Serialization failures and deadlocks (`40001`, `40P01`) are yours to retry; `fromPgError()` turns them into a 503 `MIU_E_DB_POSTGRES_RETRY`.

## Schema and migrations

Define tables with `drizzle-orm/pg-core`. Migrations are plain SQL files, `NNNN_name.sql`, applied by `migratePostgres(sql, migrations)`:

```ts
// migrate.ts — run with DATABASE_URL pointing straight at the database (not through Hyperdrive)
import postgres from "postgres";
import { loadMigrations } from "@miujs/db";
import { migratePostgres } from "@miujs/db/postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
console.log(await migratePostgres(sql, await loadMigrations("./migrations")));
await sql.end();
```

- Pending migrations run in order. Each runs as one script (simple query protocol: `$$` function bodies and several statements per file are fine) in a transaction together with its row in `_miu_migrations`, under `pg_advisory_xact_lock`, so two deploys migrating at once take turns. A failure rolls that migration back and throws `MIU_E_DB_MIGRATION_FAILED`; earlier ones stay applied.
- Run migrations before deploying (CI, or `bun migrate.ts`), not on the first request. `pg({ migrations })` works too (bundle the files with `migrationsFromGlob()` on Workers), but every new isolate then pays a query on its first request.
- The SQLite runner `migrate()` from `@miujs/db` does not run on Postgres: it splits scripts with the SQLite tokenizer and takes the D1-shaped `Database`. Use `migratePostgres()`.

### Generating SQL with drizzle-kit

You can write the SQL by hand, or let [drizzle-kit](https://orm.drizzle.team/docs/kit-overview) generate it from your schema:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "postgresql", schema: "./schema.ts", out: "./migrations" });
```

```bash
bunx drizzle-kit generate --name todos   # writes migrations/0000_todos.sql
bun migrate.ts                           # applies it with migratePostgres
```

`loadMigrations()` reads drizzle-kit's `0000_name.sql` files and ignores its `meta/` folder; the `--> statement-breakpoint` lines are SQL comments. Use one runner per database: `drizzle-kit migrate` keeps its own journal (`drizzle.__drizzle_migrations`) and does not know about `_miu_migrations`.

### What `@miujs/db` does not do on Postgres

`db()` / `ctx.db` (the D1-shaped interface), `sqlite()`, `splitSql()`, `migrate()`, `introspect()`, `generateDrizzleSchema()`, `diffSchema()`, `tableFromSchema()` DDL and `miu db pull` / `miu db migrate` are SQLite/D1 only. For introspection and schema diffs on Postgres use `drizzle-kit pull` / `drizzle-kit generate`.

## Errors

Postgres errors surface as postgres.js `PostgresError`s (wrapped in `DrizzleQueryError` when they come through Drizzle). Unhandled, they are 500s. `fromPgError(err)` turns the ones a client caused into MiuErrors and returns `undefined` for the rest:

```ts
try {
  return (await database.orm(ctx).insert(users).values(ctx.body).returning())[0];
} catch (err) {
  throw fromPgError(err) ?? err;
}
```

| SQLSTATE | MiuError |
| --- | --- |
| `23505` unique violation | 409 `MIU_E_CONFLICT`, names the constraint |
| `23503` foreign key violation | 409 `MIU_E_CONFLICT` |
| `23502` not null, `23514` check | 400 `MIU_E_BAD_REQUEST` |
| `22xxx` bad input (invalid text, out of range, too long) | 400 `MIU_E_BAD_REQUEST` |
| `40001`, `40P01` serialization failure, deadlock | 503 `MIU_E_DB_POSTGRES_RETRY` |

Messages name the constraint or column and never echo the values.

Plugin errors (see [errors.md](errors.md)):

- `MIU_E_DB_HYPERDRIVE_MISSING`: on Workers, no Hyperdrive binding with that name and no `url`.
- `MIU_E_DB_POSTGRES_URL_MISSING`: off Workers, no `url` and no `DATABASE_URL`.
- `MIU_E_DB_POSTGRES_NOT_READY`: `database.orm(ctx)` / `database.sql(ctx)` on a request the plugin did not handle (it is not in `miu({ plugins })`).
- `MIU_E_DB_MIGRATION_FAILED`: a migration failed and was rolled back.

## Testing without a Postgres server

The tests in this repo run Postgres in-process with PGlite and serve it over TCP so the real driver connects to it:

```ts
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
await server.start();
const url = `postgres://postgres:postgres@${server.getServerConn()}/postgres`;
// pg({ url, max: 1, options: { onnotice: () => {} } }) ...
await server.stop();
await db.close();
```

PGlite has a single backend: the socket server serves one connection at a time and queues the others, so use `max: 1` for pools in tests, and do not query PGlite in-process while a socket client is connected. It is real Postgres (17) for SQL semantics, but not a stand-in for production concerns like TLS, auth, connection limits or Hyperdrive. To test the Hyperdrive path, pass a binding-shaped env: `app.dispatch(req, { HYPERDRIVE: { connectionString: url } }, { runtime: "workerd", executionContext })`.

## @miujs/admin and other batteries

**`@miujs/admin` resources do not work on Postgres today.** The admin stores its resources in the D1-shaped `Database` from `@miujs/db` and generates SQLite SQL. To run it on Postgres it would need:

- a `Database` adapter over postgres.js: `?` placeholders rewritten to `$1, $2, ...`, `meta.last_row_id` / `changes` from `RETURNING` and row counts, `batch()` as a transaction;
- Postgres DDL from `tableSql()` / `tableFromSchema()` (it emits SQLite `INTEGER` / `REAL` / `TEXT` affinities, `INTEGER` booleans and JSON as `TEXT`);
- filters for `tags` / `multiSelect` fields written with `jsonb` operators instead of SQLite's `json_each()`;
- search with `tsvector` instead of FTS5 tables, and `ILIKE` where it relies on SQLite's case-insensitive `LIKE`;
- `migratePostgres()` for its own tables.

You can still run the admin next to a Postgres app by giving it its own SQLite/D1 database (`db()` with `sqlite()` or `d1("DB")`), but its resources then live in that database, not in Postgres. The same applies to the other batteries that keep tables through `@miujs/db` (`@miujs/auth`'s `dbUserStore`, `@miujs/audit`, `@miujs/access`, `@miujs/workflows`' db store, `@miujs/game`, `@miujs/tour`): they are SQLite/D1 only.
