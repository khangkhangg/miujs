import { openDatabase, type SqliteDatabase } from "../sqlite.ts";
import type { Job, JobStatus, QueueDriver } from "./types.ts";

export interface SqliteQueueOptions {
  /** Database file, or ":memory:". Default "miu.sqlite". */
  path?: string;
  /** Use an already-open database instead of `path`. */
  db?: SqliteDatabase;
  /** Table name. Default "miu_jobs". */
  table?: string;
}

interface Row {
  id: string;
  name: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  run_at: number;
  last_error: string | null;
  key: string | null;
  created_at: number;
  finished_at: number | null;
}

const toJob = (r: Row): Job => {
  const j: Job = {
    id: r.id,
    name: r.name,
    payload: JSON.parse(String(r.payload)),
    status: r.status,
    attempts: Number(r.attempts),
    runAt: Number(r.run_at),
    createdAt: Number(r.created_at),
  };
  if (r.last_error !== null) j.lastError = r.last_error;
  if (r.key !== null) j.key = r.key;
  if (r.finished_at !== null) j.finishedAt = Number(r.finished_at);
  return j;
};

/**
 * SQLite-backed queue driver: durable, and safe for several worker processes
 * sharing one database file (claims are a single atomic UPDATE).
 */
export function sqliteQueueDriver(opts: SqliteQueueOptions = {}): QueueDriver {
  const table = opts.table ?? "miu_jobs";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`);
  const cols = "id, name, payload, status, attempts, run_at, last_error, key, created_at, finished_at";

  const ready = (async () => {
    const db = opts.db ?? (await openDatabase(opts.path ?? "miu.sqlite"));
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL, locked_until INTEGER,
      last_error TEXT, key TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_status_run_at ON ${table}(status, run_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_key ON ${table}(key) WHERE key IS NOT NULL`);
    return {
      db,
      // Insert only if no pending (or, with ?11 = 1, running) job has the same key; one statement, so atomic.
      push: db.prepare(
        `INSERT INTO ${table} (${cols}) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE ?8 IS NULL OR NOT EXISTS (SELECT 1 FROM ${table} WHERE key = ?8 AND (status = 'pending' OR (?11 = 1 AND status = 'running')))
         RETURNING ${cols}`,
      ),
      claim: db.prepare(
        `UPDATE ${table} SET status = 'running', locked_until = ?2, attempts = attempts + 1
         WHERE id = (SELECT id FROM ${table}
           WHERE (status = 'pending' AND run_at <= ?1) OR (status = 'running' AND locked_until <= ?1)
           ORDER BY run_at, rowid LIMIT 1)
         RETURNING ${cols}`,
      ),
      complete: db.prepare(
        `UPDATE ${table} SET status = 'completed', finished_at = ?, locked_until = NULL
         WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
      ),
      retryLater: db.prepare(
        `UPDATE ${table} SET status = 'pending', last_error = ?, run_at = ?, locked_until = NULL
         WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
      ),
      failed: db.prepare(
        `UPDATE ${table} SET status = 'failed', last_error = ?, finished_at = ?, locked_until = NULL
         WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
      ),
      get: db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?`),
      list: db.prepare(`SELECT ${cols} FROM ${table} WHERE ?1 IS NULL OR status = ?1 ORDER BY run_at, rowid LIMIT ?2`),
      byKey: db.prepare(`SELECT ${cols} FROM ${table} WHERE key = ? AND status = 'pending' LIMIT 1`),
      byKeyActive: db.prepare(`SELECT ${cols} FROM ${table} WHERE key = ? AND status IN ('pending', 'running') LIMIT 1`),
      retry: db.prepare(
        `UPDATE ${table} SET status = 'pending', attempts = 0, run_at = ?, finished_at = NULL
         WHERE id = ? AND status = 'failed' RETURNING id`,
      ),
      prune: db.prepare(`DELETE FROM ${table} WHERE status = 'completed' AND finished_at <= ? RETURNING id`),
    };
  })();

  const one = (row: unknown) => (row === undefined ? undefined : toJob(row as Row));

  const driver: QueueDriver = {
    async push(job, o) {
      const s = await ready;
      const active = o?.dedupe === "active";
      const row = s.push.get(
        job.id, job.name, JSON.stringify(job.payload ?? null), job.status, job.attempts, job.runAt,
        job.lastError ?? null, job.key ?? null, job.createdAt, job.finishedAt ?? null, active ? 1 : 0,
      );
      if (row !== undefined) return toJob(row as Row);
      // The matching job may have finished in between: then try again.
      return one((active ? s.byKeyActive : s.byKey).get(job.key)) ?? (await driver.push(job, o));
    },
    async claim(now, lockMs) {
      const s = await ready;
      return one(s.claim.get(now, now + lockMs));
    },
    async complete(id, now, attempt) {
      return (await ready).complete.get(now, id, attempt) !== undefined;
    },
    async fail(id, error, nextRunAt, now, attempt) {
      const s = await ready;
      const row = nextRunAt === null ? s.failed.get(error, now, id, attempt) : s.retryLater.get(error, nextRunAt, id, attempt);
      return row !== undefined;
    },
    async get(id) {
      return one((await ready).get.get(id));
    },
    async list(o = {}) {
      const rows = (await ready).list.all(o.status ?? null, o.limit ?? -1);
      return (rows as Row[]).map(toJob);
    },
    async findPendingByKey(key) {
      return one((await ready).byKey.get(key));
    },
    async retry(id, now) {
      return (await ready).retry.get(now, id) !== undefined;
    },
    async prune(before) {
      return (await ready).prune.all(before).length;
    },
    async close() {
      const s = await ready;
      if (!opts.db) s.db.close();
    },
  };
  return driver;
}
