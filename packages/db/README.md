# @miujs/db

> D1-compatible SQL for MiuJS: one `Database` interface over Cloudflare D1 and local bun:sqlite, with migrations, introspection and optional Drizzle ORM.

`@miujs/db` adds `ctx.db`, a small D1-shaped interface (`prepare`/`bind`/`first`/`all`/`run`/`raw`, `batch`, `exec`). The same code runs on a Cloudflare D1 binding and, locally, on `bun:sqlite`. It applies SQL migrations once per database, reads schemas back with `introspect()`, and, through the `@miujs/db/drizzle` entry point, decorates `ctx.orm` with Drizzle. The `@miujs/db/postgres` entry adds Postgres (Hyperdrive on Workers, a pool elsewhere) with Drizzle and postgres.js; see [Postgres](#postgres). MySQL is not supported; use Drizzle directly.

## Install

```bash
bun add @miujs/db miujs
bun add drizzle-orm   # optional, for @miujs/db/drizzle and @miujs/db/postgres
bun add postgres      # optional, only for @miujs/db/postgres
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet). `drizzle-orm` (`>=0.45.0 <1`) is an optional peer dependency used only by the `@miujs/db/drizzle` and `@miujs/db/postgres` subpaths, and `postgres` (postgres.js, `>=3.4.4 <4`) only by `@miujs/db/postgres`; `@miujs/db` itself imports neither.

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { db } from "@miujs/db";

const migrations = [{ id: "001_notes", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);" }];

export const addNote = route.post("/notes", {
  body: t.object({ body: t.string() }),
  handler: async ({ body, db }) => {
    const r = await db.prepare("INSERT INTO notes (body) VALUES (?)").bind(body.body).run();
    return { id: r.meta.last_row_id };
  },
});

export const listNotes = route.get("/notes", {
  handler: async ({ db }) => {
    const { results } = await db.prepare("SELECT id, body FROM notes ORDER BY id").all<{ id: number; body: string }>();
    return { notes: results };
  },
});

const app = miu({ name: "notes", routes: [addNote, listNotes], plugins: [db({ migrations })] });
export default app;
```

With no `database`, `db()` uses `sqlite(":memory:")` on Bun and `d1("DB")` on Workers. Migrations run once per database before its first request.

## The Database interface

<!-- test -->
```ts
import { sqlite } from "@miujs/db";

const database = sqlite("./data/app.sqlite");
await database.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT, done INTEGER)");

const insert = database.prepare("INSERT INTO notes (body, done) VALUES (?, ?)");
await database.batch([insert.bind("a", false), insert.bind("b", true)]);

const first = await database.prepare("SELECT body FROM notes WHERE id = ?").bind(1).first<string>("body");
const { results } = await database.prepare("SELECT body FROM notes ORDER BY id").all<{ body: string }>();
const rows = await database.prepare("SELECT id, body FROM notes").raw({ columnNames: true });
console.log(first, results, rows);
```

- `bind()` returns a new statement. Booleans become `1`/`0` like D1; `undefined` is rejected (`MIU_E_DB_BIND_UNDEFINED`), pass `null` instead.
- `first()` returns a row, `first(column)` one column, or `null`.
- `batch()` runs statements in one transaction.
- `exec()` runs a raw script; `splitSql()` splits it on `;`, keeping trigger bodies and quoted text intact.
- `sqlite(path)` opens the file on first use with `PRAGMA foreign_keys = ON`. Bun only.

## Migrations

`migrate(database, migrations)` applies migrations not yet recorded in `_miu_migrations`, in order, each in one transaction with its bookkeeping row, and returns the applied ids. `migrateOnce` does the same at most once per (database, list) in this isolate; the plugin uses it.

<!-- test -->
```ts
import { loadMigrations, migrate, migrationsFromGlob, sqlite } from "@miujs/db";

const database = sqlite();
const fromDisk = await loadMigrations("./migrations"); // 0001_init.sql, 0002_users.sql, ...
const applied = await migrate(database, fromDisk);
console.log(applied);

const bundled = migrationsFromGlob({ "0001_init.sql": "CREATE TABLE t (x INTEGER);" });
await migrate(database, bundled);
```

- `loadMigrations(dir)` reads `NNNN_name.sql` files ordered by number; the id is the file name without `.sql`. Bun, Node and Deno only.
- `migrationsFromGlob(files)` takes `{ path: sqlText }` (or `{ default: sqlText }` modules), for Workers.
- A failed migration is rolled back; earlier ones stay applied. Never rename an applied migration.

## Introspection

`introspect(database)` returns a `SchemaDescription` (tables, columns, primary keys, indexes, foreign keys) on D1 or `sqlite()`, skipping internal tables. `generateDrizzleSchema(desc)` turns it into Drizzle `schema.ts` source, and `tableSql` / `createTableSql` / `createIndexSql` render DDL from a description.

## Drizzle

Import `@miujs/db/drizzle` (needs `drizzle-orm`). `db({ drizzle: { schema } })` decorates `ctx.orm`; `drizzleFor(database, options)` works outside requests; `drizzle(ctx)` returns `ctx.orm` or Drizzle over `ctx.db`.

<!-- test -->
```ts
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sqlite } from "@miujs/db";
import { drizzleFor } from "@miujs/db/drizzle";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  admin: integer("admin", { mode: "boolean" }).notNull().default(false),
});

const database = sqlite();
await database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL DEFAULT 0)");

const orm = drizzleFor(database, { schema: { users } });
await orm.insert(users).values({ email: "alice@x" });
const admins = await orm.select().from(users).where(eq(users.admin, true));
console.log(admins);
```

To type `ctx.orm`, register the schema once:

```ts
declare module "@miujs/db/drizzle" {
  interface DrizzleRegister { schema: typeof schema }
}
```

The subpath also exports `tableFromSchema(name, t.object(...), { primaryKey, indexes, references, casing })`, which builds a Drizzle table and its `CREATE TABLE` SQL from a MiuJS schema; `schemaFromTable(table, { mode })` for the reverse; and `describeTable` / `diffSchema(current, tables, { ignore })` to compute migration SQL against an introspected database.

## Options

`db(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `Database \| DatabaseRef` | `d1("DB")` on Workers, `sqlite(":memory:")` elsewhere | The database, or a D1 binding name via `d1("NAME")`. |
| `migrations` | `Migration[]` | none | Applied once per database before its first request. |
| `drizzle` | `{ schema?, logger?, casing? }` | none | Also set `ctx.orm`. Needs `drizzle-orm`. |

`drizzleFor(database, options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `Record<string, unknown>` | none | Tables and relations for `orm.query.<table>`. |
| `logger` | `boolean \| Logger` | none | Drizzle query logging. |
| `casing` | `"snake_case" \| "camelCase"` | none | Drizzle column name casing. |

`sqlite(path)`: `path` defaults to `":memory:"`.

## Postgres

`@miujs/db/postgres` (needs `postgres` and `drizzle-orm`) gives each request `ctx.orm` (Drizzle over postgres.js) and `ctx.sql` (the postgres.js client). On Cloudflare Workers it creates a client per request from a Hyperdrive binding and closes it after the response; on Bun, Node and Deno it keeps one pool from `DATABASE_URL` that `app.close()` closes. `migratePostgres(sql, migrations)` applies the same `NNNN_name.sql` files, and `fromPgError(err)` maps constraint errors to 409/400 MiuErrors.

```ts
import { pg } from "@miujs/db/postgres";

const database = pg({ schema, hyperdriveId: "<id>" }); // DATABASE_URL off Workers, env.HYPERDRIVE on Workers
const app = miu({ plugins: [database], routes: [route.get("/n", { handler: async (ctx) => (await ctx.sql`SELECT 1 AS n`)[0] })] });
```

The rest of this package (`db()`, `ctx.db`, `migrate()`, `introspect()`, `diffSchema()`, `tableFromSchema()`) and `@miujs/admin` resources are SQLite/D1 only. Setup, Hyperdrive, pooling, transactions, migrations, testing with PGlite and what is and is not tested: [docs/postgres.md](../../docs/postgres.md). Example: [examples/postgres](../../examples/postgres).

## In @miujs/admin

`db()` has a management section (`manage()`), shown by `@miujs/admin`:

- **Status**: adapter (`sqlite`, or `d1 (binding DB)`), tables with row counts (first 50 tables; counts stop at 10,000 so a big table is never fully scanned), applied migrations (every plugin's, from `_miu_migrations`) and pending ones from `db({ migrations })`.
- **Migrations list** (filter applied / pending).
- **Apply pending migrations** (dangerous; only when `db({ migrations })` is set): runs `migrate()` with those migrations, each in its own transaction. Running it again does nothing.

There is no way to run arbitrary SQL from the admin, on purpose.

## Errors

- [`MIU_E_DB_BINDING_MISSING`](../../docs/errors.md#miu_e_db_binding_missing): no D1 binding with that name in `env`.
- [`MIU_E_DB_UNSUPPORTED`](../../docs/errors.md#miu_e_db_unsupported): `sqlite()` off Bun, or `loadMigrations()` on Workers.
- [`MIU_E_DB_BIND_UNDEFINED`](../../docs/errors.md#miu_e_db_bind_undefined): `undefined` passed to `bind()`.
- [`MIU_E_DB_MIGRATION_FAILED`](../../docs/errors.md#miu_e_db_migration_failed): a migration's SQL failed and was rolled back.
- [`MIU_E_DB_MIGRATION_NAME`](../../docs/errors.md#miu_e_db_migration_name) / [`MIU_E_DB_MIGRATION_DUPLICATE`](../../docs/errors.md#miu_e_db_migration_duplicate): a `.sql` file without a number, or two sharing one.
- [`MIU_E_DB_MIGRATIONS_DIR`](../../docs/errors.md#miu_e_db_migrations_dir): the migrations directory cannot be read.
- [`MIU_E_DB_MIGRATION_INVALID`](../../docs/errors.md#miu_e_db_migration_invalid): a `migrationsFromGlob` value is not text.
- [`MIU_E_DB_DRIZZLE_MISSING`](../../docs/errors.md#miu_e_db_drizzle_missing): `db({ drizzle })` could not load `drizzle-orm`.
- [`MIU_E_DB_MISSING`](../../docs/errors.md#miu_e_db_missing): `drizzle(ctx)` with no `ctx.db`.
- [`MIU_E_DB_SCHEMA`](../../docs/errors.md#miu_e_db_schema): invalid `tableFromSchema` options.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

On Workers the default database is the D1 binding `DB`; `d1("NAME")` picks another, resolved from `ctx.env` per request. The plugin reports the binding to `miu deploy cloudflare`.

```toml
[[d1_databases]]
binding = "DB"
database_name = "<name>"
database_id = "<id>"

# to bundle migrations as text for migrationsFromGlob
rules = [{ type = "Text", globs = ["**/*.sql"] }]
```

When bundling with `db({ drizzle })`, add `import "@miujs/db/drizzle";` to your entry so the bundler includes Drizzle. `sqlite()` is Bun only and `loadMigrations()` needs a filesystem (Bun, Node, Deno); on Workers use `d1()` and `migrationsFromGlob()`.

## Links

- [Getting started guide](../../docs/guide.md)
- [Postgres and Hyperdrive](../../docs/postgres.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/cache](../cache/README.md), [@miujs/queue](../queue/README.md), [@miujs/ratelimit](../ratelimit/README.md)
