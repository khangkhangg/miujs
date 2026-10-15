// Versioned storage for workflows built in the admin UI (`admin_workflows`), and the loader
// that puts published versions into the @miujs/workflows engine with fromJson().

import { migrateOnce, type Database, type Migration } from "@miujs/db";
import { fromJson, type ActionDef, type WorkflowDef, type WorkflowSpec } from "@miujs/workflows";

export const adminWorkflowMigrations: Migration[] = [
  {
    id: "admin_ui_001_workflows",
    sql: `CREATE TABLE IF NOT EXISTS admin_workflows (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  published_at INTEGER,
  published_by TEXT,
  PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS admin_workflows_status ON admin_workflows(status);`,
  },
];

export type WorkflowStatus = "draft" | "published" | "archived";

export interface StoredWorkflow {
  name: string;
  version: number;
  spec: WorkflowSpec;
  status: WorkflowStatus;
  createdAt: number;
  createdBy: string | null;
  publishedAt: number | null;
}

export interface WorkflowSummary {
  name: string;
  description: string | null;
  latest: number;
  published: number | null;
  updatedAt: number;
}

interface Row {
  name: string;
  version: number;
  spec: string;
  status: WorkflowStatus;
  created_at: number;
  created_by: string | null;
  published_at: number | null;
}

const toStored = (r: Row): StoredWorkflow => ({
  name: r.name,
  version: Number(r.version),
  spec: JSON.parse(r.spec) as WorkflowSpec,
  status: r.status,
  createdAt: Number(r.created_at),
  createdBy: r.created_by ?? null,
  publishedAt: r.published_at == null ? null : Number(r.published_at),
});

export interface WorkflowStore {
  ready(): Promise<void>;
  list(): Promise<WorkflowSummary[]>;
  /** Newest first. */
  versions(name: string): Promise<StoredWorkflow[]>;
  /** A version, or the latest. */
  get(name: string, version?: number): Promise<StoredWorkflow | null>;
  /** Saves a new draft version (latest + 1). */
  save(spec: WorkflowSpec, userId: string | null): Promise<StoredWorkflow>;
  /** Makes `version` the published one (the previous one becomes archived). False if missing. */
  publish(name: string, version: number, userId: string | null): Promise<boolean>;
  unpublish(name: string): Promise<void>;
  published(): Promise<StoredWorkflow[]>;
}

/** Workflow versions in `database` (SQLite or D1). */
export function workflowStore(database: Database, now: () => number = Date.now): WorkflowStore {
  const ready = async () => void (await migrateOnce(database, adminWorkflowMigrations));
  const q = (sql: string, ...args: unknown[]) => database.prepare(sql).bind(...args);
  return {
    ready,
    async list() {
      await ready();
      const { results } = await q(
        `SELECT name, MAX(version) AS latest, MAX(CASE WHEN status = 'published' THEN version END) AS published, MAX(created_at) AS updated_at
         FROM admin_workflows GROUP BY name ORDER BY name`,
      ).all<{ name: string; latest: number; published: number | null; updated_at: number }>();
      const out: WorkflowSummary[] = [];
      for (const r of results) {
        const latest = await this.get(r.name, Number(r.latest));
        out.push({ name: r.name, description: latest?.spec.description ?? null, latest: Number(r.latest), published: r.published == null ? null : Number(r.published), updatedAt: Number(r.updated_at) });
      }
      return out;
    },
    async versions(name) {
      await ready();
      const { results } = await q("SELECT * FROM admin_workflows WHERE name = ? ORDER BY version DESC", name).all<Row>();
      return results.map(toStored);
    },
    async get(name, version) {
      await ready();
      const row =
        version === undefined
          ? await q("SELECT * FROM admin_workflows WHERE name = ? ORDER BY version DESC LIMIT 1", name).first<Row>()
          : await q("SELECT * FROM admin_workflows WHERE name = ? AND version = ?", name, version).first<Row>();
      return row ? toStored(row) : null;
    },
    async save(spec, userId) {
      await ready();
      const name = spec.name;
      // INSERT ... SELECT computes the next version atomically.
      await q(
        `INSERT INTO admin_workflows (name, version, spec, status, created_at, created_by)
         SELECT ?, COALESCE(MAX(version), 0) + 1, ?, 'draft', ?, ? FROM admin_workflows WHERE name = ?`,
        name,
        JSON.stringify(spec),
        now(),
        userId,
        name,
      ).run();
      return (await this.get(name))!;
    },
    async publish(name, version, userId) {
      await ready();
      const exists = await q("SELECT 1 AS ok FROM admin_workflows WHERE name = ? AND version = ?", name, version).first();
      if (!exists) return false;
      await database.batch([
        q("UPDATE admin_workflows SET status = 'archived' WHERE name = ? AND status = 'published' AND version <> ?", name, version),
        q("UPDATE admin_workflows SET status = 'published', published_at = ?, published_by = ? WHERE name = ? AND version = ?", now(), userId, name, version),
      ]);
      return true;
    },
    async unpublish(name) {
      await ready();
      await q("UPDATE admin_workflows SET status = 'archived' WHERE name = ? AND status = 'published'", name).run();
    },
    async published() {
      await ready();
      const { results } = await q("SELECT * FROM admin_workflows WHERE status = 'published' ORDER BY name").all<Row>();
      return results.map(toStored);
    },
  };
}

/** Where published workflows go: the workflows() plugin (its public register/unregister API). */
export interface WorkflowTarget {
  has(name: string): boolean;
  register(def: WorkflowDef<any>): void;
  unregister(name: string): boolean;
}

export interface LoaderOptions {
  target: () => WorkflowTarget | null;
  actions: () => readonly ActionDef[];
  /** How long a sync stays fresh (other isolates/processes may publish). Default 30s. */
  ttlMs?: number;
  /** Least time between on-demand refreshes (unknown webhook paths, crons, runs). Default 5s. */
  minRefreshMs?: number;
  now?: () => number;
  log?: (message: string, data?: unknown) => void;
}

/**
 * Keeps the workflows engine in step with the published versions in `admin_workflows`.
 *
 * Freshness across isolates/processes: each instance re-reads storage when its last read is
 * older than `ttlMs` (checked on requests), and also on demand — when a webhook, a cron event
 * or a run names a workflow this instance does not know (workflows' `onUnknown`), throttled to
 * one read per `minRefreshMs`.
 */
export class WorkflowLoader {
  private readonly o: LoaderOptions;
  private readonly ours = new Map<string, number>();
  private last = -Infinity;
  private lastForced = -Infinity;
  private pending: Promise<{ errors: { name: string; message: string }[] }> | null = null;

  constructor(o: LoaderOptions) {
    this.o = o;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  loaded(): Record<string, number> {
    return Object.fromEntries(this.ours);
  }

  /** Names this loader manages (UI-built workflows). */
  owns(name: string): boolean {
    return this.ours.has(name);
  }

  sync(store: WorkflowStore): Promise<{ errors: { name: string; message: string }[] }> {
    // Concurrent callers share one read, so registrations never interleave.
    if (!this.pending) this.pending = this.doSync(store).finally(() => (this.pending = null));
    return this.pending;
  }

  private async doSync(store: WorkflowStore): Promise<{ errors: { name: string; message: string }[] }> {
    const target = this.o.target();
    const errors: { name: string; message: string }[] = [];
    if (!target) return { errors };
    const published = await store.published();
    const want = new Set(published.map((p) => p.name));
    for (const name of [...this.ours.keys()]) {
      if (!want.has(name)) {
        target.unregister(name);
        this.ours.delete(name);
      }
    }
    for (const p of published) {
      if (this.ours.get(p.name) === p.version) continue;
      if (!this.ours.has(p.name) && target.has(p.name)) {
        errors.push({ name: p.name, message: `A workflow named "${p.name}" is defined in code; the UI version is not loaded.` });
        continue;
      }
      let def: WorkflowDef<any>;
      try {
        def = fromJson(p.spec, { actions: [...this.o.actions()] });
      } catch (err) {
        errors.push({ name: p.name, message: (err as Error).message });
        continue;
      }
      if (this.ours.has(p.name)) {
        target.unregister(p.name);
        this.ours.delete(p.name);
      }
      try {
        target.register(def);
        this.ours.set(p.name, p.version);
      } catch (err) {
        errors.push({ name: p.name, message: (err as Error).message });
      }
    }
    for (const e of errors) this.o.log?.("admin ui: workflow not loaded", e);
    this.last = this.now();
    return { errors };
  }

  /** Syncs when the last sync is older than the TTL. */
  async ensure(store: WorkflowStore): Promise<void> {
    if (this.now() - this.last <= (this.o.ttlMs ?? 30_000)) return;
    await this.sync(store);
  }

  /** Re-reads now (something named a workflow we do not know), at most once per minRefreshMs. */
  async refresh(store: WorkflowStore): Promise<void> {
    const now = this.now();
    if (now - this.lastForced < (this.o.minRefreshMs ?? 5_000)) return;
    this.lastForced = now;
    await this.sync(store);
  }

  /** Forces the next ensure() to re-read storage. */
  invalidate(): void {
    this.last = -Infinity;
  }
}
