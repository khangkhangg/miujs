// @miujs/db/postgres — Postgres for MiuJS apps: Cloudflare Hyperdrive on Workers, a pooled
// connection on Bun / Node / Deno. Drizzle (`drizzle-orm/postgres-js`) as `ctx.orm`, the raw
// postgres.js client as `ctx.sql`.
//
// Two connection modes, chosen per request:
//   - Hyperdrive: when `env[binding]` has a `connectionString` (Workers, `wrangler dev`), or on
//     Workers at all. A new small client per request, ended through `ctx.waitUntil` after the
//     response. Workers must not share sockets between requests; Hyperdrive does the pooling.
//   - Pooled: elsewhere. One long-lived client from `url` / `env.DATABASE_URL`, closed by
//     `app.stop()` so the process can exit.
//
// Needs the optional peers `postgres` (postgres.js) and `drizzle-orm`. On Workers, postgres.js
// needs `compatibility_flags = ["nodejs_compat"]` (`miu deploy cloudflare` adds it with a Hyperdrive
// binding). `migratePostgres()` applies the same `Migration[]` as `@miujs/db`'s `migrate()`.
//
// Not supported here: `@miujs/db`'s D1-shaped `Database` (`ctx.db`), `introspect()`, `diffSchema()`,
// `tableFromSchema()` DDL and `splitSql()` are SQLite-only, and `@miujs/admin` resources need them.

import postgres from "postgres";
import type { Options as PostgresOptions, Sql } from "postgres";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "drizzle-orm";
import { definePlugin, errors, type CloudflareNeeds, type Context, type Env, type MiuError } from "miujs";
import type { Migration } from "./index.ts";
// Brings `ctx.orm` (typed through `DrizzleRegister`) into programs that only use this entry.
import type {} from "./drizzle.ts";

/** The raw postgres.js client (`ctx.sql`). */
export type PgSql = Sql<{}>;

/** Drizzle over postgres.js. */
export type PgOrm<TSchema extends Record<string, unknown> = Record<string, never>> = PostgresJsDatabase<TSchema> & { $client: PgSql };

/** Creates a postgres.js client. Defaults to `postgres` itself; swap it to wrap or instrument clients. */
export type PgDriver = (url: string, options: PostgresOptions<{}>) => PgSql;

export interface PgOptions<TSchema extends Record<string, unknown> = Record<string, never>> {
  /** Hyperdrive binding name. Default `"HYPERDRIVE"`. */
  binding?: string;
  /** Hyperdrive config id (`wrangler hyperdrive create`), written to wrangler.toml by `miu deploy cloudflare`. */
  hyperdriveId?: string;
  /** Connection string `wrangler dev` uses instead of Hyperdrive (`localConnectionString`). */
  localConnectionString?: string;
  /** Connection string off Workers. Default: `env.DATABASE_URL`. */
  url?: string;
  /** Pool size off Workers. Default 10. Hyperdrive clients use 5. */
  max?: number;
  /** Extra postgres.js options for every client (ssl, idle_timeout, onnotice, transform, ...). */
  options?: PostgresOptions<{}>;
  /** Drizzle tables (and relations) for `orm.query.<table>`. */
  schema?: TSchema;
  logger?: boolean | Logger;
  casing?: "snake_case" | "camelCase";
  /** Applied once per database (connection string) in this process/isolate, before its first request. */
  migrations?: Migration[];
  /** postgres.js client factory. Default: `postgres`. */
  driver?: PgDriver;
}

declare module "miujs" {
  interface Context {
    /** postgres.js client from `@miujs/db/postgres` (`pg()`): sql`SELECT ...`, sql.begin(...). */
    sql: PgSql;
  }
}

interface Connection<TSchema extends Record<string, unknown>> {
  sql: PgSql;
  orm: PgOrm<TSchema>;
  url: string;
  perRequest: boolean;
}

const HYPERDRIVE_DEFAULTS: PostgresOptions<{}> = { max: 5, fetch_types: false };

function hyperdriveString(env: Env, binding: string): string | undefined {
  const b = env?.[binding] as { connectionString?: unknown } | undefined;
  return b && typeof b.connectionString === "string" ? b.connectionString : undefined;
}

function tableNames(schema: Record<string, unknown> | undefined): string[] {
  const NAME = Symbol.for("drizzle:Name");
  const IS_TABLE = Symbol.for("drizzle:IsDrizzleTable");
  return Object.values(schema ?? {})
    .filter((v) => typeof v === "object" && v !== null && (v as any)[IS_TABLE] === true)
    .map((v) => (v as any)[NAME] as string);
}

/**
 * Postgres plugin: sets `ctx.sql` (postgres.js) and `ctx.orm` (Drizzle) on every request. Through
 * Hyperdrive on Workers (a client per request), a pool elsewhere. `database.orm(ctx)` and
 * `database.sql(ctx)` return the same objects, typed with this plugin's schema.
 */
export function pg<TSchema extends Record<string, unknown> = Record<string, never>>(opts: PgOptions<TSchema> = {}) {
  const binding = opts.binding ?? "HYPERDRIVE";
  const driver: PgDriver = opts.driver ?? (postgres as unknown as PgDriver);
  const ormConfig = { schema: opts.schema, logger: opts.logger, casing: opts.casing };
  const byRequest = new WeakMap<object, Connection<TSchema>>();
  const migrated = new Map<string, Promise<string[]>>();
  let pool: Connection<TSchema> | undefined;

  const connect = (url: string, perRequest: boolean): Connection<TSchema> => {
    const options = perRequest ? { ...HYPERDRIVE_DEFAULTS, ...opts.options } : { max: opts.max ?? 10, ...opts.options };
    const sql = driver(url, options);
    const orm = drizzlePostgres(sql, ormConfig) as PgOrm<TSchema>;
    return { sql, orm, url, perRequest };
  };

  const connectionFor = (ctx: Context): Connection<TSchema> => {
    const env = ctx.env ?? {};
    const viaHyperdrive = hyperdriveString(env, binding);
    if (viaHyperdrive !== undefined) return connect(viaHyperdrive, true);
    if (ctx.runtime === "workerd") {
      if (opts.url) return connect(opts.url, true);
      throw errors.config(
        "MIU_E_DB_HYPERDRIVE_MISSING",
        `No Hyperdrive binding named "${binding}" in env`,
        `Create one (bunx wrangler hyperdrive create <name> --connection-string="postgres://...") and add a [[hyperdrive]] entry with binding = "${binding}" to wrangler.toml (\`miu deploy cloudflare\` writes it), or pass pg({ binding }) with your binding's name.`,
      );
    }
    if (pool) return pool;
    const url = opts.url ?? (typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : undefined);
    if (!url) {
      throw errors.config(
        "MIU_E_DB_POSTGRES_URL_MISSING",
        "pg() has no connection string",
        "Set DATABASE_URL (e.g. postgres://user:pass@localhost:5432/app), or pass pg({ url }). On Workers, add a Hyperdrive binding instead.",
      );
    }
    return (pool = connect(url, false));
  };

  const migrateFor = (conn: Connection<TSchema>): Promise<string[]> | undefined => {
    if (!opts.migrations?.length) return;
    let p = migrated.get(conn.url);
    if (!p) {
      p = migratePostgres(conn.sql, opts.migrations);
      p.catch(() => migrated.delete(conn.url));
      migrated.set(conn.url, p);
    }
    return p;
  };

  const get = (ctx: Context): Connection<TSchema> => {
    const conn = byRequest.get(ctx);
    if (!conn) {
      throw errors.config(
        "MIU_E_DB_POSTGRES_NOT_READY",
        "No Postgres connection on this request",
        "Add the pg() plugin to miu({ plugins }) and call database.orm(ctx) / database.sql(ctx) inside a request.",
      );
    }
    return conn;
  };

  return definePlugin({
    name: "postgres",
    /** Drizzle for this request (the same object as `ctx.orm`), typed with this plugin's schema. */
    orm(ctx: Context): PgOrm<TSchema> {
      return get(ctx).orm;
    },
    /** postgres.js client for this request (the same object as `ctx.sql`). */
    sql(ctx: Context): PgSql {
      return get(ctx).sql;
    },
    async onRequest(ctx) {
      const conn = connectionFor(ctx);
      // Recorded before anything can fail, so onResponse always ends a per-request client.
      byRequest.set(ctx, conn);
      (ctx as { sql: PgSql }).sql = conn.sql;
      (ctx as unknown as { orm: unknown }).orm = conn.orm;
      const pending = migrateFor(conn);
      if (pending) await pending;
    },
    onResponse(ctx) {
      const conn = byRequest.get(ctx);
      if (conn?.perRequest) ctx.waitUntil(conn.sql.end({ timeout: 5 }));
    },
    async stop() {
      const p = pool;
      pool = undefined;
      if (p) await p.sql.end({ timeout: 5 });
    },
    inspect() {
      const info: Record<string, unknown> = { adapter: "postgres", binding, driver: "postgres.js" };
      if (opts.hyperdriveId) info.hyperdriveId = opts.hyperdriveId;
      if (opts.migrations?.length) info.migrations = opts.migrations.map((m) => m.id);
      if (opts.schema) info.drizzle = { tables: tableNames(opts.schema) };
      return info;
    },
    cloudflare(): CloudflareNeeds {
      const h: NonNullable<CloudflareNeeds["hyperdrive"]>[number] = { binding };
      if (opts.hyperdriveId) h.id = opts.hyperdriveId;
      if (opts.localConnectionString) h.localConnectionString = opts.localConnectionString;
      return { hyperdrive: [h] };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// migrations

// pg_advisory_xact_lock key, so two processes migrating at once take turns ("miu" in hex).
const LOCK = 0x6d6975;

/**
 * Applies migrations not yet recorded in `_miu_migrations`, in order. Each migration's SQL runs as
 * one script (simple query protocol, so `$$` bodies and drizzle-kit `--> statement-breakpoint`
 * files work) in a transaction with its bookkeeping row, under an advisory lock. Returns applied ids.
 */
export async function migratePostgres(sql: PgSql, migrations: Migration[]): Promise<string[]> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
    await tx.unsafe("CREATE TABLE IF NOT EXISTS _miu_migrations (id text PRIMARY KEY, applied_at bigint NOT NULL)");
  });
  const done = new Set((await sql<{ id: string }[]>`SELECT id FROM _miu_migrations`).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    let ran = false;
    try {
      ran = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
        if ((await tx`SELECT 1 FROM _miu_migrations WHERE id = ${m.id}`).length) return false; // another process got there first
        await tx.unsafe(m.sql).simple();
        await tx`INSERT INTO _miu_migrations (id, applied_at) VALUES (${m.id}, ${Date.now()})`;
        return true;
      });
    } catch (err) {
      throw errors.custom({
        code: "MIU_E_DB_MIGRATION_FAILED",
        status: 500,
        message: `Migration "${m.id}" failed: ${(err as Error)?.message ?? err}`,
        fix: "Fix the migration SQL. It was rolled back; earlier migrations stay applied.",
        cause: err,
      });
    }
    if (ran) applied.push(m.id);
    done.add(m.id);
  }
  return applied;
}

// ---------------------------------------------------------------------------------------------
// errors

interface PgErrorFields {
  code?: unknown;
  severity?: unknown;
  constraint_name?: string;
  column_name?: string;
  table_name?: string;
  cause?: unknown;
}

function findPgError(err: unknown): PgErrorFields | undefined {
  // Drizzle wraps driver errors (DrizzleQueryError.cause); look a few levels down.
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const e = cur as PgErrorFields;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === "string") return e;
    cur = e.cause;
  }
  return undefined;
}

/**
 * Turns a Postgres constraint or input error into a client-facing `MiuError`, or `undefined` for
 * anything else (rethrow those). Messages name the constraint or column, never the values.
 *
 * 23505 unique / 23503 foreign key → 409 `MIU_E_CONFLICT`; 23502 not null, 23514 check, 22xxx bad
 * input → 400 `MIU_E_BAD_REQUEST`; 40001 / 40P01 (serialization failure, deadlock) → 503
 * `MIU_E_DB_POSTGRES_RETRY`.
 */
export function fromPgError(err: unknown): MiuError | undefined {
  const e = findPgError(err);
  if (!e) return undefined;
  const code = e.code as string;
  const where = e.table_name ? ` on ${e.table_name}` : "";
  if (code === "23505") return errors.conflict(`Duplicate value violates unique constraint "${e.constraint_name ?? "?"}"${where}`, "Use a value that is not taken yet.");
  if (code === "23503") return errors.conflict(`Foreign key constraint "${e.constraint_name ?? "?"}"${where} failed`, "Reference a row that exists, or remove the rows that still reference this one first.");
  if (code === "23502") return errors.badRequest(`Missing required value${e.column_name ? ` for "${e.column_name}"` : ""}${where}`, "Send a value for every required field.");
  if (code === "23514") return errors.badRequest(`Check constraint "${e.constraint_name ?? "?"}"${where} failed`, "Send a value the constraint allows.");
  if (code.startsWith("22")) return errors.badRequest(`Invalid value for the database (SQLSTATE ${code})`, "Check the types and lengths of the values you send.");
  if (code === "40001" || code === "40P01") {
    return errors.custom({
      code: "MIU_E_DB_POSTGRES_RETRY",
      status: 503,
      message: `The transaction conflicted with another one (SQLSTATE ${code})`,
      fix: "Retry the request; keep transactions short.",
    });
  }
  return undefined;
}
