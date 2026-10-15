// @miujs/db — a D1-compatible SQL interface. The same code runs on Cloudflare D1 and, locally,
// on bun:sqlite. Deliberately small: prepare/bind/first/all/run, batch, exec, migrate.

import { definePlugin, detectRuntime, errors, targetRuntime, type CloudflareNeeds, type Env, type Runtime } from "miujs";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;

export interface RunMeta {
  changes: number;
  last_row_id: number;
  duration: number;
  [key: string]: unknown;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: RunMeta;
}

export interface Statement {
  /** Returns a new statement with positional (`?` / `?1`) values bound. */
  bind(...values: unknown[]): Statement;
  /** First row, or one column of it, or `null`. */
  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

/** The subset of Cloudflare's `D1Database` MiuJS relies on. A D1 binding satisfies it as-is. */
export interface Database {
  prepare(sql: string): Statement;
  /** Runs statements in one transaction; results in order. */
  batch<T = Record<string, unknown>>(statements: Statement[]): Promise<D1Result<T>[]>;
  /** Runs raw SQL (one or more statements, no bindings). */
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

/** A database, or a way to find one in the request env (Workers bindings). */
export type DatabaseSource = Database | DatabaseRef;

const REF = Symbol.for("miujs.db.ref");

export interface DatabaseRef {
  readonly [REF]: true;
  readonly binding: string;
  resolve(env: Env): Database;
}

function isRef(v: unknown): v is DatabaseRef {
  return typeof v === "object" && v !== null && (v as any)[REF] === true;
}

/** Turns a `DatabaseSource` into a `Database` for this request's env. */
export function resolveDatabase(source: DatabaseSource, env: Env): Database {
  return isRef(source) ? source.resolve(env) : source;
}

/** Describes a source for `inspect()` without leaking anything sensitive. */
export function describeDatabase(source: DatabaseSource): Record<string, unknown> {
  if (isRef(source)) return { adapter: "d1", binding: source.binding };
  const info = (source as any)[INFO] as Record<string, unknown> | undefined;
  return info ?? { adapter: "d1" };
}

// ---------------------------------------------------------------------------------------------
// d1

/**
 * Cloudflare D1. Pass the binding itself, or its name to look it up in `ctx.env` per request:
 * `db({ database: d1("DB") })`.
 */
export function d1(binding: string): DatabaseRef;
export function d1(binding: Database): Database;
export function d1(binding: string | Database): DatabaseSource {
  if (typeof binding !== "string") return binding;
  const name = binding;
  return {
    [REF]: true,
    binding: name,
    resolve(env: Env): Database {
      const found = env?.[name] as Database | undefined;
      if (!found || typeof found.prepare !== "function") {
        throw errors.config(
          "MIU_E_DB_BINDING_MISSING",
          `No D1 binding named "${name}" in env`,
          `Add a [[d1_databases]] entry with binding = "${name}" to wrangler.toml (or run \`miu deploy cloudflare\`), or pass a database to db({ database }).`,
        );
      }
      return found;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// sqlite (bun:sqlite)

const INFO = Symbol.for("miujs.db.info");

interface BunStmt {
  all(...p: unknown[]): any[];
  get(...p: unknown[]): any;
  run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface BunDb {
  prepare(sql: string): BunStmt;
  run(sql: string): unknown;
  transaction<F extends (...a: any[]) => any>(fn: F): F;
}

function normalize(values: unknown[]): unknown[] {
  return values.map((v, i) => {
    if (v === undefined) {
      throw errors.custom({
        code: "MIU_E_DB_BIND_UNDEFINED",
        status: 500,
        message: `bind() value #${i + 1} is undefined`,
        fix: "Pass null for SQL NULL; undefined is not a valid SQL value (D1 rejects it too).",
      });
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v;
  });
}

/** Splits SQL on `;` outside quotes and comments. Good enough for migrations; not a parser. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface SqliteOptions {
  /** @internal Override runtime detection (tests). */
  runtime?: Runtime;
}

/**
 * Local SQLite via `bun:sqlite`, with the D1 interface. Bun only; on Workers use `d1()`.
 * The file is opened on first use.
 */
export function sqlite(path: string = ":memory:", opts: SqliteOptions = {}): Database {
  const runtime = opts.runtime ?? detectRuntime();
  let opened: Promise<BunDb> | null = null;
  const open = (): Promise<BunDb> =>
    (opened ??= (async () => {
      if (runtime !== "bun") {
        throw errors.config(
          "MIU_E_DB_UNSUPPORTED",
          `sqlite() needs Bun (bun:sqlite); this is ${runtime}`,
          'On Cloudflare Workers use db({ database: d1("DB") }). Elsewhere, run with Bun or pass any D1-compatible database to db({ database }).',
        );
      }
      const mod = "bun:sqlite";
      const { Database: BunDatabase } = (await import(/* @vite-ignore */ mod)) as { Database: new (p: string, o?: unknown) => BunDb };
      const handle = new BunDatabase(path, { create: true });
      handle.run("PRAGMA foreign_keys = ON");
      return handle;
    })());

  const runOne = (handle: BunDb, sql: string, values: unknown[], mode: "all" | "run"): D1Result<any> => {
    const start = performance.now();
    const stmt = handle.prepare(sql);
    if (mode === "all") {
      const results = stmt.all(...values);
      return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: performance.now() - start } };
    }
    const r = stmt.run(...values);
    return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), duration: performance.now() - start } };
  };

  class SqliteStatement implements Statement {
    readonly sql: string;
    readonly values: unknown[];
    constructor(sql: string, values: unknown[]) {
      this.sql = sql;
      this.values = values;
    }
    bind(...values: unknown[]): Statement {
      return new SqliteStatement(this.sql, values);
    }
    async first<T>(column?: string): Promise<T | null> {
      const handle = await open();
      const row = handle.prepare(this.sql).get(...normalize(this.values));
      if (row === null || row === undefined) return null;
      return (column === undefined ? row : row[column]) as T;
    }
    async all<T>(): Promise<D1Result<T>> {
      return runOne(await open(), this.sql, normalize(this.values), "all");
    }
    async run<T>(): Promise<D1Result<T>> {
      return runOne(await open(), this.sql, normalize(this.values), "run");
    }
  }

  const database: Database = {
    prepare: (sql) => new SqliteStatement(sql, []),
    async batch(statements) {
      const handle = await open();
      const prepared = statements.map((s) => {
        if (!(s instanceof SqliteStatement)) throw errors.badRequest("batch() got a statement from another database");
        return { sql: s.sql, values: normalize(s.values) };
      });
      const tx = handle.transaction(() =>
        prepared.map((p) => {
          // Statements that return rows report them; others report changes, like D1.
          const isQuery = /^\s*(select|with|pragma|values)\b/i.test(p.sql) || /\breturning\b/i.test(p.sql);
          return runOne(handle, p.sql, p.values, isQuery ? "all" : "run");
        }),
      );
      return tx();
    },
    async exec(sql) {
      const handle = await open();
      const start = performance.now();
      const parts = splitSql(sql);
      for (const p of parts) handle.run(p);
      return { count: parts.length, duration: performance.now() - start };
    },
  };
  Object.defineProperty(database, INFO, { value: { adapter: "sqlite", path } });
  return database;
}

// ---------------------------------------------------------------------------------------------
// migrations

export interface Migration {
  /** Unique, sortable id, e.g. `"001_users"`. Never rename an applied migration. */
  id: string;
  sql: string;
}

/**
 * Applies migrations not yet recorded in `_miu_migrations`, in the given order. Each migration
 * runs in one batch (a transaction) together with its bookkeeping row. Returns applied ids.
 */
export async function migrate(database: Database, migrations: Migration[]): Promise<string[]> {
  await database.exec("CREATE TABLE IF NOT EXISTS _miu_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const { results } = await database.prepare("SELECT id FROM _miu_migrations").all<{ id: string }>();
  const done = new Set(results.map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    const stmts = splitSql(m.sql).map((s) => database.prepare(s));
    stmts.push(database.prepare("INSERT INTO _miu_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, Date.now()));
    try {
      await database.batch(stmts);
    } catch (err) {
      throw errors.custom({
        code: "MIU_E_DB_MIGRATION_FAILED",
        status: 500,
        message: `Migration "${m.id}" failed: ${(err as Error)?.message ?? err}`,
        fix: "Fix the migration SQL. It was rolled back; earlier migrations stay applied.",
        cause: err,
      });
    }
    applied.push(m.id);
    done.add(m.id);
  }
  return applied;
}

const migrated = new WeakMap<object, Map<Migration[], Promise<string[]>>>();

/** Runs `migrate` at most once per (database, migrations) pair in this isolate. */
export function migrateOnce(database: Database, migrations: Migration[]): Promise<string[]> {
  let byList = migrated.get(database);
  if (!byList) migrated.set(database, (byList = new Map()));
  let p = byList.get(migrations);
  if (!p) {
    p = migrate(database, migrations);
    p.catch(() => byList!.delete(migrations));
    byList.set(migrations, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// plugin

export interface DbOptions {
  /** Default: `d1("DB")` on Workers, `sqlite(":memory:")` elsewhere. */
  database?: DatabaseSource;
  /** Applied once per database before it is first handed to a request. */
  migrations?: Migration[];
}

declare module "miujs" {
  interface Context {
    /** D1-compatible database from `@miujs/db`. */
    db: Database;
  }
}

/** Decorates `ctx.db`. */
export function db(opts: DbOptions = {}) {
  let source: DatabaseSource | undefined = opts.database;
  const getSource = () => (source ??= targetRuntime() === "workerd" ? d1("DB") : sqlite());
  return definePlugin({
    name: "db",
    async onRequest(ctx) {
      const database = resolveDatabase(getSource(), ctx.env);
      if (opts.migrations?.length) await migrateOnce(database, opts.migrations);
      (ctx as { db: Database }).db = database;
    },
    inspect() {
      const info = describeDatabase(getSource());
      return opts.migrations?.length ? { ...info, migrations: opts.migrations.map((m) => m.id) } : info;
    },
    cloudflare(): CloudflareNeeds {
      const s = getSource();
      return isRef(s) ? { d1: [s.binding] } : {};
    },
  });
}
