import { detectRuntime } from "miujs";
import type { QueueMessage } from "./adapter.ts";
import { durableQueue, type Claimed, type DurableBackend, type DurableQueue, type DurableQueueOptions } from "./durable.ts";
import { queueErrors } from "./errors.ts";
import type { DeadLetter } from "./memory.ts";

/** The parts of a `bun:sqlite` Database this queue uses. */
export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
}
export interface SqliteDatabaseLike {
  query(sql: string): SqliteStatementLike;
  exec(sql: string): unknown;
  close?(): void;
}

export interface SqliteQueueOptions extends DurableQueueOptions {
  /** Table name; dead letters and schedule locks use `<table>_dead` and `<table>_once`. Default "miu_jobs". */
  table?: string;
}

const FIX = "Check that the database file is writable and not locked by another program for long, and that the disk is not full.";

/** @internal */
export function _assertSqliteRuntime(runtime: string): void {
  if (runtime !== "bun") {
    throw queueErrors.runtime(
      "sqliteQueue (bun:sqlite)",
      runtime,
      "sqliteQueue needs Bun. On Node or Deno use redisQueue(...) or memoryQueue(); on Cloudflare Workers use cloudflareQueue().",
    );
  }
}

interface Row {
  seq: number;
  id: string;
  job: string;
  input: string;
  attempt: number;
}

const claimed = (rows: unknown[]): Claimed[] =>
  (rows as Row[]).sort((a, b) => a.seq - b.seq).map((r) => ({ msg: { id: r.id, job: r.job, input: JSON.parse(r.input) }, attempt: r.attempt }));

function sqliteBackend(open: () => SqliteDatabaseLike, table: string, path: string | undefined, owned: boolean): DurableBackend {
  let db: SqliteDatabaseLike | undefined;
  const get = (): SqliteDatabaseLike => {
    if (db) return db;
    const d = open();
    if (owned) d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    d.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job TEXT NOT NULL, input TEXT NOT NULL, attempt INTEGER NOT NULL, run_at INTEGER NOT NULL, lease_until INTEGER);
       CREATE INDEX IF NOT EXISTS ${table}_due ON ${table} (lease_until, run_at);
       CREATE TABLE IF NOT EXISTS ${table}_dead (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, job TEXT NOT NULL, input TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT NOT NULL, code TEXT, failed_at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS ${table}_once (key TEXT PRIMARY KEY, expires INTEGER NOT NULL);`,
    );
    return (db = d);
  };
  const g =
    <A extends unknown[], R>(op: string, fn: (d: SqliteDatabaseLike, ...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      try {
        return await fn(get(), ...a);
      } catch (err) {
        throw queueErrors.backend("SQLITE", op, err, FIX);
      }
    };
  const COLS = "seq, id, job, input, attempt";

  return {
    enqueue: g("enqueue", (d, msg: QueueMessage, attempt: number, runAt: number) => {
      d.query(`INSERT INTO ${table} (id, job, input, attempt, run_at) VALUES (?, ?, ?, ?, ?)`).run(msg.id, msg.job, JSON.stringify(msg.input ?? null), attempt, runAt);
    }),
    // One UPDATE ... RETURNING: atomic, so two processes never lease the same row.
    claim: g("claim", (d, now: number, leaseUntil: number, max: number) =>
      claimed(
        d
          .query(`UPDATE ${table} SET lease_until = ? WHERE seq IN (SELECT seq FROM ${table} WHERE lease_until IS NULL AND run_at <= ? ORDER BY run_at, seq LIMIT ?) RETURNING ${COLS}`)
          .all(leaseUntil, now, max),
      ),
    ),
    extend: g("extend", (d, id: string, leaseUntil: number) => {
      d.query(`UPDATE ${table} SET lease_until = ? WHERE id = ? AND lease_until IS NOT NULL`).run(leaseUntil, id);
    }),
    ack: g("ack", (d, id: string) => {
      d.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
    }),
    retry: g("retry", (d, c: Claimed, runAt: number) => {
      d.query(`UPDATE ${table} SET attempt = ?, run_at = ?, lease_until = NULL WHERE id = ?`).run(c.attempt + 1, runAt, c.msg.id);
    }),
    dead: g("dead-letter", (d, c: Claimed, l: DeadLetter) => {
      d.exec("BEGIN IMMEDIATE");
      try {
        d.query(`INSERT INTO ${table}_dead (id, job, input, attempts, error, code, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(l.id, l.job, JSON.stringify(l.input ?? null), l.attempts, l.error, l.code ?? null, l.failedAt);
        d.query(`DELETE FROM ${table} WHERE id = ?`).run(c.msg.id);
        d.exec("COMMIT");
      } catch (err) {
        d.exec("ROLLBACK");
        throw err;
      }
    }),
    reap: g("reap", (d, now: number, leaseUntil: number) =>
      claimed(d.query(`UPDATE ${table} SET lease_until = ? WHERE lease_until IS NOT NULL AND lease_until <= ? RETURNING ${COLS}`).all(leaseUntil, now)),
    ),
    nextRunAt: g("next", (d) => {
      const r = d.query(`SELECT MIN(run_at) AS t FROM ${table} WHERE lease_until IS NULL`).get() as { t: number | null } | null;
      return r?.t ?? undefined;
    }),
    once: g("once", (d, key: string, ttlMs: number, now: number) => {
      d.query(`DELETE FROM ${table}_once WHERE expires <= ?`).run(now);
      return d.query(`INSERT OR IGNORE INTO ${table}_once (key, expires) VALUES (?, ?)`).run(key, now + ttlMs).changes === 1;
    }),
    stats: g("stats", (d, now: number) => {
      const r = d
        .query(
          `SELECT
             COALESCE(SUM(lease_until IS NULL AND run_at <= ?1), 0) AS pending,
             COALESCE(SUM(lease_until IS NULL AND run_at > ?1), 0) AS delayed,
             COALESCE(SUM(lease_until IS NOT NULL), 0) AS inflight,
             (SELECT COUNT(*) FROM ${table}_dead) AS deadLetters
           FROM ${table}`,
        )
        .get(now) as { pending: number; delayed: number; inflight: number; deadLetters: number };
      return { pending: r.pending, delayed: r.delayed, inflight: r.inflight, deadLetters: r.deadLetters };
    }),
    deadLetters: g("dead-letters", (d) =>
      (d.query(`SELECT id, job, input, attempts, error, code, failed_at FROM ${table}_dead ORDER BY seq`).all() as Record<string, any>[]).map(
        (r): DeadLetter => ({ id: r.id, job: r.job, input: JSON.parse(r.input), attempts: r.attempts, error: r.error, code: r.code ?? undefined, failedAt: r.failed_at }),
      ),
    ),
    close() {
      if (owned) db?.close?.();
      db = undefined;
    },
    inspect: () => ({ ...(path !== undefined ? { path } : {}), table }),
  };
}

/**
 * Durable jobs in a local SQLite file (bun:sqlite): they survive restarts, delays and retries
 * wait in the table, and a job whose process dies is rerun after `visibilityTimeout`. Several
 * processes on one machine can share the file. Same retry, backoff and dead-letter rules as
 * memoryQueue. Bun only. Jobs receive the process env, not the dispatching request's env.
 *
 * ```ts
 * queue({ jobs, adapter: sqliteQueue("./data/jobs.sqlite") })
 * ```
 */
export function sqliteQueue(database: string | SqliteDatabaseLike, opts: SqliteQueueOptions = {}): DurableQueue {
  const table = opts.table ?? "miu_jobs";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw queueErrors.config(`Invalid sqliteQueue table name ${JSON.stringify(table)}`, "Use letters, digits and underscores, e.g. `table: \"jobs\"`.");
  if (typeof database === "string") {
    _assertSqliteRuntime(detectRuntime());
    const path = database;
    const open = (): SqliteDatabaseLike => {
      // Required lazily (and synchronously) so this module still loads on runtimes without bun:sqlite.
      const { Database } = requireBunSqlite("bun:sqlite");
      return new Database(path, { create: true });
    };
    return durableQueue("sqlite", sqliteBackend(open, table, path, true), opts);
  }
  const d = database as Partial<SqliteDatabaseLike> | null;
  if (typeof d !== "object" || d === null || typeof d.query !== "function" || typeof d.exec !== "function") {
    throw queueErrors.config("sqliteQueue needs a file path or an open bun:sqlite Database", 'Pass sqliteQueue("./data/jobs.sqlite") or sqliteQueue(new Database("./data/jobs.sqlite")).');
  }
  return durableQueue("sqlite", sqliteBackend(() => database, table, undefined, false), opts);
}

function requireBunSqlite(mod: string): { Database: new (p: string, o?: unknown) => SqliteDatabaseLike } {
  // Bun supports `require` in ES modules via import.meta.require.
  const req = (import.meta as { require?: (m: string) => unknown }).require;
  if (!req) throw queueErrors.runtime("sqliteQueue (bun:sqlite)", detectRuntime(), "sqliteQueue needs Bun. Use redisQueue(...) or memoryQueue() elsewhere.");
  return req(mod) as { Database: new (p: string, o?: unknown) => SqliteDatabaseLike };
}
