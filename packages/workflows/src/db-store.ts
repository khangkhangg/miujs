import { describeDatabase, migrateOnce, resolveDatabase, type Database, type DatabaseSource, type Migration } from "@miujs/db";
import type { Env } from "miujs";
import type { EventRecord, RunFilter, RunRecord, RunStore, StepRecord, WaiterRecord } from "./store.ts";

/** Tables for `dbRunStore`. Applied automatically; exported so you can apply them with your own. */
export const workflowMigrations: Migration[] = [
  {
    id: "workflows_001_init",
    sql: `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  trigger_info TEXT NOT NULL,
  concurrency_key TEXT,
  token TEXT,
  lease_until INTEGER,
  wake_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS workflow_runs_by_workflow ON workflow_runs (workflow, status, created_at);
CREATE INDEX IF NOT EXISTS workflow_runs_by_key ON workflow_runs (concurrency_key, status);
CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  wake_at INTEGER,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);
CREATE TABLE IF NOT EXISTS workflow_waiters (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  kind TEXT NOT NULL,
  event TEXT NOT NULL,
  match TEXT,
  approvers TEXT,
  expires_at INTEGER,
  resolution TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_waiters_by_event ON workflow_waiters (event, resolution);
CREATE INDEX IF NOT EXISTS workflow_waiters_by_run ON workflow_waiters (run_id, step);
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
)`,
  },
];

// JSON columns: SQL NULL means `undefined`; JSON `null` stays null.
const enc = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const dec = (v: unknown): any => (v === null || v === undefined ? undefined : JSON.parse(String(v)));
const decNull = (v: unknown): any => (v === null || v === undefined ? null : JSON.parse(String(v)));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const RUN_COLUMNS: Record<keyof RunRecord, [string, (v: any) => unknown]> = {
  id: ["id", (v) => v],
  workflow: ["workflow", (v) => v],
  status: ["status", (v) => v],
  input: ["input", enc],
  output: ["output", enc],
  error: ["error", (v) => (v === null ? null : enc(v))],
  trigger: ["trigger_info", enc],
  concurrencyKey: ["concurrency_key", (v) => v ?? null],
  token: ["token", (v) => v ?? null],
  leaseUntil: ["lease_until", (v) => v ?? null],
  wakeAt: ["wake_at", (v) => v ?? null],
  createdAt: ["created_at", (v) => v],
  updatedAt: ["updated_at", (v) => v],
  finishedAt: ["finished_at", (v) => v ?? null],
};

function toRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    workflow: String(row.workflow),
    status: row.status as RunRecord["status"],
    input: dec(row.input),
    output: dec(row.output),
    error: decNull(row.error),
    trigger: decNull(row.trigger_info),
    concurrencyKey: (row.concurrency_key as string | null) ?? null,
    token: (row.token as string | null) ?? null,
    leaseUntil: num(row.lease_until),
    wakeAt: num(row.wake_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: num(row.finished_at),
  };
}

function toStep(row: Record<string, unknown>): StepRecord {
  return {
    runId: String(row.run_id),
    name: String(row.name),
    seq: Number(row.seq),
    kind: row.kind as StepRecord["kind"],
    status: row.status as StepRecord["status"],
    output: dec(row.output),
    error: decNull(row.error),
    attempts: Number(row.attempts),
    wakeAt: num(row.wake_at),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
  };
}

function toWaiter(row: Record<string, unknown>): WaiterRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    step: String(row.step),
    kind: row.kind as WaiterRecord["kind"],
    event: String(row.event),
    match: decNull(row.match),
    approvers: decNull(row.approvers),
    expiresAt: num(row.expires_at),
    resolution: decNull(row.resolution),
    createdAt: Number(row.created_at),
  };
}

function toEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    data: dec(row.data) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

function patchSql(patch: Partial<RunRecord>): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = RUN_COLUMNS[k as keyof RunRecord];
    if (!col || k === "id") continue;
    sets.push(`${col[0]} = ?`);
    values.push(col[1](v));
  }
  return { sets, values };
}

function bound(database: Database): Omit<RunStore, "forEnv" | "describe" | "kind"> {
  const ready = () => migrateOnce(database, workflowMigrations);
  const q = async (sql: string, ...values: unknown[]) => {
    await ready();
    return database.prepare(sql).bind(...values);
  };
  return {
    async createRun(r) {
      const cols = Object.values(RUN_COLUMNS).map((c) => c[0]);
      const values = (Object.keys(RUN_COLUMNS) as (keyof RunRecord)[]).map((k) => RUN_COLUMNS[k][1](r[k]));
      await (await q(`INSERT INTO workflow_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values)).run();
    },
    async getRun(id) {
      const row = await (await q("SELECT * FROM workflow_runs WHERE id = ?", id)).first<Record<string, unknown>>();
      return row ? toRun(row) : null;
    },
    async updateRun(id, patch) {
      const { sets, values } = patchSql(patch);
      if (!sets.length) return;
      await (await q(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`, ...values, id)).run();
    },
    async casRun(id, expect, patch) {
      const { sets, values } = patchSql(patch);
      if (!sets.length) sets.push("id = id");
      const where = ["id = ?", expect.token === null ? "token IS NULL" : "token = ?"];
      const wv: unknown[] = [id];
      if (expect.token !== null) wv.push(expect.token);
      if (expect.leaseFreeAt !== undefined) {
        where.push("(lease_until IS NULL OR lease_until <= ?)");
        wv.push(expect.leaseFreeAt);
      }
      const res = await (await q(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`, ...values, ...wv)).run();
      return res.meta.changes > 0;
    },
    async listRuns(f) {
      const where: string[] = [];
      const values: unknown[] = [];
      if (f.workflow !== undefined) {
        where.push("workflow = ?");
        values.push(f.workflow);
      }
      if (f.concurrencyKey !== undefined) {
        where.push("concurrency_key = ?");
        values.push(f.concurrencyKey);
      }
      if (f.before !== undefined) {
        where.push("created_at < ?");
        values.push(f.before);
      }
      if (f.status !== undefined) {
        const s = Array.isArray(f.status) ? f.status : [f.status];
        where.push(`status IN (${s.map(() => "?").join(", ")})`);
        values.push(...s);
      }
      const dir = (f.order ?? "desc") === "desc" ? "DESC" : "ASC";
      let sql = `SELECT * FROM workflow_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${dir}, rowid ${dir}`;
      if (f.limit !== undefined) {
        sql += " LIMIT ?";
        values.push(f.limit);
      }
      const { results } = await (await q(sql, ...values)).all<Record<string, unknown>>();
      return results.map(toRun);
    },
    async getSteps(runId) {
      const { results } = await (await q("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY seq", runId)).all<Record<string, unknown>>();
      return results.map(toStep);
    },
    async saveStep(s) {
      await (
        await q(
          "INSERT OR REPLACE INTO workflow_steps (run_id, name, seq, kind, status, output, error, attempts, wake_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          s.runId,
          s.name,
          s.seq,
          s.kind,
          s.status,
          enc(s.output),
          s.error === null ? null : enc(s.error),
          s.attempts,
          s.wakeAt,
          s.startedAt,
          s.updatedAt,
        )
      ).run();
    },
    async addWaiter(w) {
      await (
        await q(
          "INSERT INTO workflow_waiters (id, run_id, step, kind, event, match, approvers, expires_at, resolution, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          w.id,
          w.runId,
          w.step,
          w.kind,
          w.event,
          w.match === null ? null : enc(w.match),
          w.approvers === null ? null : enc(w.approvers),
          w.expiresAt,
          w.resolution === null ? null : enc(w.resolution),
          w.createdAt,
        )
      ).run();
    },
    async openWaiters(event) {
      const { results } = await (await q("SELECT * FROM workflow_waiters WHERE event = ? AND kind = 'event' AND resolution IS NULL ORDER BY created_at", event)).all<Record<string, unknown>>();
      return results.map(toWaiter);
    },
    async getWaiter(runId, step) {
      const row = await (await q("SELECT * FROM workflow_waiters WHERE run_id = ? AND step = ? LIMIT 1", runId, step)).first<Record<string, unknown>>();
      return row ? toWaiter(row) : null;
    },
    async resolveWaiter(id, resolution) {
      const res = await (await q("UPDATE workflow_waiters SET resolution = ? WHERE id = ? AND resolution IS NULL", enc(resolution), id)).run();
      return res.meta.changes > 0;
    },
    async deleteWaiters(runId, step) {
      if (step === undefined) await (await q("DELETE FROM workflow_waiters WHERE run_id = ?", runId)).run();
      else await (await q("DELETE FROM workflow_waiters WHERE run_id = ? AND step = ?", runId, step)).run();
    },
    async recordEvent(e) {
      const res = await (
        await q("INSERT OR IGNORE INTO workflow_events (id, name, data, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)", e.id, e.name, enc(e.data), e.idempotencyKey, e.createdAt)
      ).run();
      if (res.meta.changes > 0) return { duplicate: false, event: e };
      const row = await (await q("SELECT * FROM workflow_events WHERE idempotency_key = ?", e.idempotencyKey)).first<Record<string, unknown>>();
      return { duplicate: true, event: row ? toEvent(row) : e };
    },
  };
}

/**
 * Durable store on a D1-compatible database (`sqlite()` locally, D1 on Workers). Tables are
 * created on first use through `workflowMigrations`. Pass `d1("DB")` to resolve the binding
 * from each request's env.
 */
export function dbRunStore(database: DatabaseSource): RunStore {
  const cache = new WeakMap<object, RunStore>();
  const make = (db: Database): RunStore => {
    let s = cache.get(db);
    if (!s) {
      s = { kind: "db", ...bound(db), forEnv: (env: Env) => make(resolveDatabase(database, env)), describe: () => ({ adapter: "db", database: describeDatabase(database) }) };
      cache.set(db, s);
    }
    return s;
  };
  if (typeof (database as Database).prepare === "function") return make(database as Database);
  // A binding reference used without an env: resolving throws MIU_E_DB_BINDING_MISSING with a fix.
  const unbound = () => make(resolveDatabase(database, {}));
  const methods = bound(null as unknown as Database);
  const delegating = {} as Record<string, unknown>;
  for (const k of Object.keys(methods)) delegating[k] = (...args: unknown[]) => (unbound() as any)[k](...args);
  return {
    ...(delegating as Omit<RunStore, "kind" | "forEnv" | "describe">),
    kind: "db",
    forEnv: (env: Env) => make(resolveDatabase(database, env)),
    describe: () => ({ adapter: "db", database: describeDatabase(database) }),
  };
}
