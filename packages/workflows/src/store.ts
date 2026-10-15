import type { Env } from "miujs";

export type RunStatus = "queued" | "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";
export const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "sleeping", "waiting", "completed", "failed", "cancelled"];
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

export interface RunError {
  message: string;
  code?: string;
  /** The step that failed, when a step failed. */
  step?: string;
  name?: string;
}

export interface TriggerInfo {
  type: "event" | "cron" | "webhook" | "manual";
  event?: string;
  eventId?: string;
  cron?: string;
  path?: string;
  /** User id that started a manual run. */
  by?: string;
}

export interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: RunError | null;
  trigger: TriggerInfo;
  concurrencyKey: string | null;
  /**
   * Resume token. A queue message resumes the run only while it carries the current token, so
   * stale or duplicate messages (timeouts after an event, redeliveries) are no-ops.
   */
  token: string | null;
  /** While an invocation runs, other claimers wait until this time (ms). */
  leaseUntil: number | null;
  /** When a sleeping/waiting/retrying run should wake (ms). */
  wakeAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type StepKind = "run" | "sleep" | "wait" | "approval" | "now" | "uuid";
export type StepStatus = "completed" | "failed" | "retrying" | "sleeping" | "waiting";

export interface StepRecord {
  runId: string;
  name: string;
  /** Order of first appearance in the run. */
  seq: number;
  kind: StepKind;
  status: StepStatus;
  output: unknown;
  error: RunError | null;
  attempts: number;
  wakeAt: number | null;
  startedAt: number;
  updatedAt: number;
}

export interface Approvers {
  role?: string[];
  users?: string[];
}

export interface WaiterRecord {
  id: string;
  runId: string;
  step: string;
  kind: "event" | "approval";
  event: string;
  /** `{ "data.contactId": "c1" }`: dotted paths into the event that must equal the values. */
  match: Record<string, unknown> | null;
  approvers: Approvers | null;
  expiresAt: number | null;
  /** Set once (atomically) by the event, approval or timeout that resolves the wait. */
  resolution: { value: unknown } | null;
  createdAt: number;
}

export interface EventRecord {
  id: string;
  name: string;
  data: unknown;
  idempotencyKey: string | null;
  createdAt: number;
}

export interface RunFilter {
  workflow?: string;
  status?: RunStatus | RunStatus[];
  concurrencyKey?: string;
  /** Only runs created before this time (ms): a cursor for paging. */
  before?: number;
  limit?: number;
  /** Default "desc" (newest first). */
  order?: "asc" | "desc";
}

/** Where runs, step journals, waiters and events live. All values must be JSON-serializable. */
export interface RunStore {
  readonly kind: string;
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  /**
   * Atomically apply `patch` when the run's token equals `expect.token` and, with
   * `expect.leaseFreeAt`, its lease is unset or expired by then. True when applied.
   */
  casRun(id: string, expect: { token: string | null; leaseFreeAt?: number }, patch: Partial<RunRecord>): Promise<boolean>;
  listRuns(filter: RunFilter): Promise<RunRecord[]>;
  getSteps(runId: string): Promise<StepRecord[]>;
  /** Insert or replace by (runId, name). */
  saveStep(step: StepRecord): Promise<void>;
  addWaiter(waiter: WaiterRecord): Promise<void>;
  /** Unresolved waiters for `event`, oldest first. */
  openWaiters(event: string): Promise<WaiterRecord[]>;
  getWaiter(runId: string, step: string): Promise<WaiterRecord | null>;
  /** Set the resolution if none is set yet. True for the caller that won. */
  resolveWaiter(id: string, resolution: { value: unknown }): Promise<boolean>;
  deleteWaiters(runId: string, step?: string): Promise<void>;
  /** Store the event unless one with the same idempotency key exists (then return that one). */
  recordEvent(event: EventRecord): Promise<{ duplicate: boolean; event: EventRecord }>;
  /** Stores that live in Workers bindings return a store bound to this request's env. */
  forEnv?(env: Env): RunStore;
  describe(): Record<string, unknown>;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function matchesFilter(r: RunRecord, f: RunFilter): boolean {
  if (f.workflow !== undefined && r.workflow !== f.workflow) return false;
  if (f.concurrencyKey !== undefined && r.concurrencyKey !== f.concurrencyKey) return false;
  if (f.before !== undefined && !(r.createdAt < f.before)) return false;
  if (f.status !== undefined) {
    const s = Array.isArray(f.status) ? f.status : [f.status];
    if (!s.includes(r.status)) return false;
  }
  return true;
}

/**
 * In-process store: the default. Runs are lost when the process exits; use `dbRunStore` for
 * anything that must survive restarts. Values are copied in and out, like a database.
 */
export function memoryRunStore(): RunStore {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, Map<string, StepRecord>>();
  const waiters = new Map<string, WaiterRecord>();
  const events = new Map<string, EventRecord>();
  const byKey = new Map<string, EventRecord>();
  let order = 0;
  const seqOf = new Map<string, number>();

  return {
    kind: "memory",
    async createRun(run) {
      runs.set(run.id, clone(run));
      seqOf.set(run.id, order++);
    },
    async getRun(id) {
      const r = runs.get(id);
      return r ? clone(r) : null;
    },
    async updateRun(id, patch) {
      const r = runs.get(id);
      if (r) Object.assign(r, clone(patch));
    },
    async casRun(id, expect, patch) {
      const r = runs.get(id);
      if (!r || r.token !== expect.token) return false;
      if (expect.leaseFreeAt !== undefined && r.leaseUntil !== null && r.leaseUntil > expect.leaseFreeAt) return false;
      Object.assign(r, clone(patch));
      return true;
    },
    async listRuns(f) {
      const desc = (f.order ?? "desc") === "desc";
      const list = [...runs.values()]
        .filter((r) => matchesFilter(r, f))
        .sort((a, b) => (a.createdAt - b.createdAt || seqOf.get(a.id)! - seqOf.get(b.id)!) * (desc ? -1 : 1));
      return clone(f.limit === undefined ? list : list.slice(0, f.limit));
    },
    async getSteps(runId) {
      return clone([...(steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq));
    },
    async saveStep(step) {
      let m = steps.get(step.runId);
      if (!m) steps.set(step.runId, (m = new Map()));
      m.set(step.name, clone(step));
    },
    async addWaiter(w) {
      waiters.set(w.id, clone(w));
    },
    async openWaiters(event) {
      return clone([...waiters.values()].filter((w) => w.event === event && w.kind === "event" && !w.resolution).sort((a, b) => a.createdAt - b.createdAt));
    },
    async getWaiter(runId, step) {
      for (const w of waiters.values()) if (w.runId === runId && w.step === step) return clone(w);
      return null;
    },
    async resolveWaiter(id, resolution) {
      const w = waiters.get(id);
      if (!w || w.resolution) return false;
      w.resolution = clone(resolution);
      return true;
    },
    async deleteWaiters(runId, step) {
      for (const [id, w] of waiters) if (w.runId === runId && (step === undefined || w.step === step)) waiters.delete(id);
    },
    async recordEvent(e) {
      if (e.idempotencyKey !== null) {
        const prev = byKey.get(e.idempotencyKey);
        if (prev) return { duplicate: true, event: clone(prev) };
        byKey.set(e.idempotencyKey, clone(e));
      }
      events.set(e.id, clone(e));
      return { duplicate: false, event: clone(e) };
    },
    describe: () => ({ adapter: "memory", runs: runs.size, waiters: waiters.size }),
  };
}
