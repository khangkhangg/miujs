// @miujs/db — a D1-compatible SQL interface. The same code runs on Cloudflare D1 and, locally,
// on bun:sqlite. Deliberately small: prepare/bind/first/all/run/raw, batch, exec, migrate.
//
// Entry points:
//   "@miujs/db"          Database, sqlite(), d1(), db() plugin, migrate()/migrateOnce(), splitSql(),
//                        loadMigrations()/migrationsFromGlob(), introspect(), generateDrizzleSchema().
//   "@miujs/db/drizzle"  drizzle(ctx)/drizzleFor(db), tableFromSchema()/schemaFromTable(),
//                        describeTable()/diffSchema(). Needs the optional peer `drizzle-orm`.
//
// Postgres / MySQL (not built): MiuJS targets D1/SQLite. On Cloudflare, Postgres or MySQL is
// reached through a Hyperdrive binding plus a driver (postgres.js / pg / mysql2) and Drizzle's own
// adapter (drizzle-orm/postgres-js, drizzle-orm/mysql2), created per request from
// `ctx.env.HYPERDRIVE.connectionString`. None of this package's SQL helpers (splitSql, introspect,
// diffSchema, tableFromSchema DDL) speak those dialects. A future `@miujs/db` adapter would need a
// dialect-aware Database interface first; until then use Drizzle directly for those databases.

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
  /** Rows as arrays in column order; with `columnNames`, the first array holds the names. */
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
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
  values(...p: unknown[]): unknown[][];
  readonly columnNames: string[];
  get(...p: unknown[]): any;
  run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  finalize(): void;
}
interface BunDb {
  prepare(sql: string): BunStmt;
  run(sql: string): unknown;
  transaction<F extends (...a: any[]) => any>(fn: F): F;
  close(): void;
}

/** A `sqlite()` database: the D1 interface plus `close()`. */
export interface SqliteDatabase extends Database {
  /**
   * Closes the file (statements are finalized after each use, so nothing keeps it open). Idempotent;
   * using the database afterwards throws `MIU_E_DB_CLOSED`. Only needed for short-lived handles
   * (CLIs, tests, deleting the file on Windows).
   */
  close(): Promise<void>;
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

const WORD = /[A-Za-z0-9_$]/;
const CLOSE: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/**
 * Splits a SQLite script into statements on `;`. Understands quoted strings and identifiers
 * (`'…'`, `"…"`, `` `…` ``, `[…]`), strips `--` and `/* *\/` comments, and keeps
 * `CREATE TRIGGER … BEGIN …; …; END` bodies (including nested `CASE … END`) in one statement.
 * SQLite has no `$$` quoting, so `$` is an ordinary character. A tokenizer, not a parser.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  // Per-statement state: leading keywords (to spot CREATE [TEMP] TRIGGER), trigger body, CASE depth.
  let head: string[] = [];
  let inBody = false;
  let caseDepth = 0;
  const flush = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
    head = [];
    inBody = false;
    caseDepth = 0;
  };
  const isTrigger = () =>
    head[0] === "CREATE" && (head[1] === "TRIGGER" || ((head[1] === "TEMP" || head[1] === "TEMPORARY") && head[2] === "TRIGGER"));
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const close = CLOSE[c];
    if (close) {
      const end = sql.indexOf(close, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      cur += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1; // keep the newline itself
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) break;
      cur += " ";
      i = end + 1;
      continue;
    }
    if (WORD.test(c) && !(i > 0 && WORD.test(sql[i - 1]))) {
      let j = i;
      while (j < sql.length && WORD.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      if (head.length < 3) head.push(upper);
      if (isTrigger()) {
        if (upper === "CASE") caseDepth++;
        else if (upper === "BEGIN" && !inBody) inBody = true;
        else if (upper === "END") {
          if (caseDepth > 0) caseDepth--;
          else inBody = false;
        }
      }
      cur += word;
      i = j - 1;
      continue;
    }
    if (c === ";" && !inBody) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
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
export function sqlite(path: string = ":memory:", opts: SqliteOptions = {}): SqliteDatabase {
  const runtime = opts.runtime ?? detectRuntime();
  let opened: Promise<BunDb> | null = null;
  let closed = false;
  const open = (): Promise<BunDb> => {
    if (closed) {
      return Promise.reject(
        errors.config("MIU_E_DB_CLOSED", `sqlite("${path}") was closed`, "Call close() only when you are done with the database, or open a new one with sqlite(path)."),
      );
    }
    return (opened ??= (async () => {
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
  };

  // Each statement is finalized right after use: an unfinalized one keeps the file open after close().
  const use = <T>(handle: BunDb, sql: string, fn: (stmt: BunStmt) => T): T => {
    const stmt = handle.prepare(sql);
    try {
      return fn(stmt);
    } finally {
      stmt.finalize();
    }
  };

  const runOne = (handle: BunDb, sql: string, values: unknown[], mode: "all" | "run"): D1Result<any> => {
    const start = performance.now();
    if (mode === "all") {
      const results = use(handle, sql, (stmt) => stmt.all(...values));
      return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: performance.now() - start } };
    }
    const r = use(handle, sql, (stmt) => stmt.run(...values));
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
      const values = normalize(this.values);
      const row = use(handle, this.sql, (stmt) => stmt.get(...values));
      if (row === null || row === undefined) return null;
      return (column === undefined ? row : row[column]) as T;
    }
    async all<T>(): Promise<D1Result<T>> {
      return runOne(await open(), this.sql, normalize(this.values), "all");
    }
    async run<T>(): Promise<D1Result<T>> {
      return runOne(await open(), this.sql, normalize(this.values), "run");
    }
    async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
      const values = normalize(this.values);
      return use(await open(), this.sql, (stmt) => {
        const rows = stmt.values(...values);
        return (options?.columnNames ? [stmt.columnNames, ...rows] : rows) as T[];
      });
    }
  }

  const database: SqliteDatabase = {
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
    async close() {
      if (closed) return;
      closed = true;
      const pending = opened;
      opened = null;
      if (!pending) return;
      try {
        (await pending).close();
      } catch {
        // Opening failed (e.g. not Bun): nothing to close.
      }
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

/** Options for `db({ drizzle })`. Needs the optional peer dependency `drizzle-orm`. */
export interface DrizzleOptions {
  /** Tables (and relations) for the relational query API, `ctx.orm.query.<table>`. */
  schema?: Record<string, unknown>;
  logger?: boolean;
  casing?: "snake_case" | "camelCase";
}

export interface DbOptions {
  /** Default: `d1("DB")` on Workers, `sqlite(":memory:")` elsewhere. */
  database?: DatabaseSource;
  /** Applied once per database before it is first handed to a request. */
  migrations?: Migration[];
  /** Also decorate `ctx.orm` with Drizzle over `ctx.db` (see `@miujs/db/drizzle`). */
  drizzle?: DrizzleOptions;
}

declare module "miujs" {
  interface Context {
    /** D1-compatible database from `@miujs/db`. */
    db: Database;
  }
}

/** @internal Where `@miujs/db/drizzle` registers its factory when it is loaded. */
export const DRIZZLE_FACTORY = Symbol.for("miujs.db.drizzle");
type OrmFactory = (database: Database, options: DrizzleOptions) => unknown;

async function loadDrizzle(): Promise<OrmFactory> {
  const registered = () => (globalThis as Record<symbol, unknown>)[DRIZZLE_FACTORY] as OrmFactory | undefined;
  if (!registered()) {
    try {
      // Not a literal specifier on purpose: bundlers must not pull in drizzle-orm for apps that
      // don't use it. Bundled apps (Workers) import "@miujs/db/drizzle" themselves.
      const entry = new URL("./drizzle.ts", import.meta.url).href;
      await import(/* @vite-ignore */ entry);
    } catch (err) {
      if (!registered()) {
        throw errors.config(
          "MIU_E_DB_DRIZZLE_MISSING",
          `db({ drizzle }) could not load Drizzle: ${(err as Error)?.message ?? err}`,
          'Install drizzle-orm (bun add drizzle-orm) and add `import "@miujs/db/drizzle";` to your app entry (required when bundling, e.g. on Cloudflare Workers).',
        );
      }
    }
  }
  return registered()!;
}

function tableNames(schema: Record<string, unknown> | undefined): string[] {
  const NAME = Symbol.for("drizzle:Name");
  const IS_TABLE = Symbol.for("drizzle:IsDrizzleTable");
  return Object.values(schema ?? {})
    .filter((v) => typeof v === "object" && v !== null && (v as any)[IS_TABLE] === true)
    .map((v) => (v as any)[NAME] as string);
}

/** Decorates `ctx.db`, and `ctx.orm` when `drizzle` is set. */
export function db(opts: DbOptions = {}) {
  let source: DatabaseSource | undefined = opts.database;
  const getSource = () => (source ??= targetRuntime() === "workerd" ? d1("DB") : sqlite());
  let factory: Promise<OrmFactory> | undefined;
  return definePlugin({
    name: "db",
    async onRequest(ctx) {
      const database = resolveDatabase(getSource(), ctx.env);
      if (opts.migrations?.length) await migrateOnce(database, opts.migrations);
      (ctx as { db: Database }).db = database;
      if (opts.drizzle) {
        const make = await (factory ??= loadDrizzle());
        (ctx as unknown as { orm: unknown }).orm = make(database, opts.drizzle);
      }
    },
    inspect() {
      const info: Record<string, unknown> = describeDatabase(getSource());
      if (opts.migrations?.length) info.migrations = opts.migrations.map((m) => m.id);
      if (opts.drizzle) info.drizzle = { tables: tableNames(opts.drizzle.schema) };
      return info;
    },
    cloudflare(): CloudflareNeeds {
      const s = getSource();
      return isRef(s) ? { d1: [s.binding] } : {};
    },
  });
}

// ---------------------------------------------------------------------------------------------
// introspection, DDL and schema generation (no drizzle-orm needed)

export {
  createIndexSql,
  createTableSql,
  generateDrizzleSchema,
  introspect,
  quoteIdent,
  tableSql,
  type ColumnDescription,
  type ForeignKeyDescription,
  type IndexDescription,
  type SchemaDescription,
  type TableDescription,
} from "./introspect.ts";

// migrations from files

export { loadMigrations, migrationsFromGlob, type LoadMigrationsOptions } from "./files.ts";
