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
  {
    // The organization a workflow was built in (NULL: app-wide, built without an active org).
    id: "admin_ui_002_workflows_org",
    sql: "ALTER TABLE admin_workflows ADD COLUMN org_id TEXT;",
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
  /** The organization that owns it; null: app-wide. */
  org: string | null;
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
  org_id?: string | null;
}

const toStored = (r: Row): StoredWorkflow => ({
  name: r.name,
  version: Number(r.version),
  spec: JSON.parse(r.spec) as WorkflowSpec,
  status: r.status,
  createdAt: Number(r.created_at),
  createdBy: r.created_by ?? null,
  publishedAt: r.published_at == null ? null : Number(r.published_at),
  org: r.org_id ?? null,
});

/**
 * Every method except `published()` and `owner()` is scoped to one owner: an organization id,
 * or null for app-wide workflows. A workflow of another owner does not exist for the caller.
 */
export interface WorkflowStore {
  ready(): Promise<void>;
  list(org?: string | null): Promise<WorkflowSummary[]>;
  /** Newest first. */
  versions(name: string, org?: string | null): Promise<StoredWorkflow[]>;
  /** A version, or the latest. */
  get(name: string, version?: number, org?: string | null): Promise<StoredWorkflow | null>;
  /**
   * Saves a new draft version (latest + 1). Null when the name belongs to another owner (names
   * are unique app-wide, like the engine's).
   */
  save(spec: WorkflowSpec, userId: string | null, org?: string | null): Promise<StoredWorkflow | null>;
  /** Makes `version` the published one (the previous one becomes archived). False if missing. */
  publish(name: string, version: number, userId: string | null, org?: string | null): Promise<boolean>;
  /** False when this owner has no workflow of that name. */
  unpublish(name: string, org?: string | null): Promise<boolean>;
  /** Every owner's published versions (for the loader). */
  published(): Promise<StoredWorkflow[]>;
  /** Who owns a name: undefined when nobody saved it. */
  owner(name: string): Promise<string | null | undefined>;
}

/** Workflow versions in `database` (SQLite or D1). */
export function workflowStore(database: Database, now: () => number = Date.now): WorkflowStore {
  const ready = async () => void (await migrateOnce(database, adminWorkflowMigrations));
  const q = (sql: string, ...args: unknown[]) => database.prepare(sql).bind(...args);
  // "org_id IS ?" matches NULL with NULL (app-wide) and an id with the same id.
  return {
    ready,
    async list(org = null) {
      await ready();
      const { results } = await q(
        `SELECT name, MAX(version) AS latest, MAX(CASE WHEN status = 'published' THEN version END) AS published, MAX(created_at) AS updated_at
         FROM admin_workflows WHERE org_id IS ? GROUP BY name ORDER BY name`,
        org,
      ).all<{ name: string; latest: number; published: number | null; updated_at: number }>();
      const out: WorkflowSummary[] = [];
      for (const r of results) {
        const latest = await this.get(r.name, Number(r.latest), org);
        out.push({ name: r.name, description: latest?.spec.description ?? null, latest: Number(r.latest), published: r.published == null ? null : Number(r.published), updatedAt: Number(r.updated_at) });
      }
      return out;
    },
    async versions(name, org = null) {
      await ready();
      const { results } = await q("SELECT * FROM admin_workflows WHERE name = ? AND org_id IS ? ORDER BY version DESC", name, org).all<Row>();
      return results.map(toStored);
    },
    async get(name, version, org = null) {
      await ready();
      const row =
        version === undefined
          ? await q("SELECT * FROM admin_workflows WHERE name = ? AND org_id IS ? ORDER BY version DESC LIMIT 1", name, org).first<Row>()
          : await q("SELECT * FROM admin_workflows WHERE name = ? AND version = ? AND org_id IS ?", name, version, org).first<Row>();
      return row ? toStored(row) : null;
    },
    async owner(name) {
      await ready();
      const row = await q("SELECT org_id FROM admin_workflows WHERE name = ? LIMIT 1", name).first<{ org_id: string | null }>();
      return row ? (row.org_id ?? null) : undefined;
    },
    async save(spec, userId, org = null) {
      await ready();
      const name = spec.name;
      // INSERT ... SELECT computes the next version atomically, and inserts nothing when the
      // name already belongs to another owner.
      await q(
        `INSERT INTO admin_workflows (name, version, spec, status, created_at, created_by, org_id)
         SELECT ?, COALESCE(MAX(version), 0) + 1, ?, 'draft', ?, ?, ? FROM admin_workflows WHERE name = ?
         HAVING NOT EXISTS (SELECT 1 FROM admin_workflows WHERE name = ? AND org_id IS NOT ?)`,
        name,
        JSON.stringify(spec),
        now(),
        userId,
        org,
        name,
        name,
        org,
      ).run();
      return this.get(name, undefined, org);
    },
    async publish(name, version, userId, org = null) {
      await ready();
      const exists = await q("SELECT 1 AS ok FROM admin_workflows WHERE name = ? AND version = ? AND org_id IS ?", name, version, org).first();
      if (!exists) return false;
      await database.batch([
        q("UPDATE admin_workflows SET status = 'archived' WHERE name = ? AND status = 'published' AND version <> ?", name, version),
        q("UPDATE admin_workflows SET status = 'published', published_at = ?, published_by = ? WHERE name = ? AND version = ?", now(), userId, name, version),
      ]);
      return true;
    },
    async unpublish(name, org = null) {
      await ready();
      if (!(await this.get(name, undefined, org))) return false;
      await q("UPDATE admin_workflows SET status = 'archived' WHERE name = ? AND status = 'published' AND org_id IS ?", name, org).run();
      return true;
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
        def = p.org === null ? fromJson(p.spec, { actions: [...this.o.actions()] }) : fromJson(scopeSpec(p.spec, p.org), { actions: scopeActions(this.o.actions(), p.org) });
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A workflow built in an organization only sees that organization: its event trigger and every
 * wait_for_event step also match `data.orgId` (admin events carry it), so other orgs' records
 * never start or resume its runs.
 */
export function scopeSpec(spec: WorkflowSpec, org: string): WorkflowSpec {
  const out = structuredClone(spec) as WorkflowSpec;
  const scope = (match: unknown) => ({ ...(isObject(match) ? match : {}), "data.orgId": org });
  if (out.trigger?.type === "event") out.trigger.match = scope(out.trigger.match);
  const walk = (steps: unknown) => {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      if (!isObject(s)) continue;
      if (s.type === "wait_for_event") s.match = scope(s.match);
      walk(s.then);
      walk(s.else);
    }
  };
  walk(out.steps);
  return out;
}

/**
 * Actions whose params name an organization (`orgId`, like crm.create_task) refuse any other
 * organization than the workflow's own: params are written by the workflow's author, who must not
 * reach into another tenant.
 */
export function scopeActions(actions: readonly ActionDef[], org: string): ActionDef[] {
  return actions.map((a) => {
    const props = (a.params.json as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!props || !Object.prototype.hasOwnProperty.call(props, "orgId")) return a;
    return {
      ...a,
      run: (params: any, actx: any) => {
        if (params?.orgId !== org) {
          throw Object.assign(new Error(`Action "${a.name}" may only act in this workflow's organization (${org}), not ${JSON.stringify(params?.orgId)}.`), { retryable: false });
        }
        return a.run(params, actx);
      },
    };
  });
}
