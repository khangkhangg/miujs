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
  /**
   * Unresolved waiters for `event`, oldest first. A store may use `accept` to skip waiters
   * early (before copying them); callers still check each result.
   */
  openWaiters(event: string, accept?: (w: WaiterRecord) => boolean): Promise<WaiterRecord[]>;
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

export interface MemoryRunStoreOptions {
  /**
   * Finished (completed, failed, cancelled) runs to keep. The oldest-finished are dropped with
   * their step journal, so a long-lived process does not grow without bound. Active runs are
   * always kept. Default 1000.
   */
  maxFinishedRuns?: number;
  /** Idempotency keys remembered for event dedup; the oldest are forgotten first. Default 10 000. */
  maxIdempotencyKeys?: number;
  /** How long an idempotency key dedupes, by event time (ms). Default 24 hours. */
  idempotencyTtlMs?: number;
}

/**
 * In-process store: the default. Runs are lost when the process exits; use `dbRunStore` for
 * anything that must survive restarts. Values are copied in and out, like a database.
 *
 * Memory is bounded: only the newest `maxFinishedRuns` finished runs are kept, and idempotency
 * keys expire after `idempotencyTtlMs` or beyond `maxIdempotencyKeys`. Event payloads are not kept.
 */
export function memoryRunStore(opts: MemoryRunStoreOptions = {}): RunStore {
  const maxFinished = Math.max(0, opts.maxFinishedRuns ?? 1000);
  const maxKeys = Math.max(0, opts.maxIdempotencyKeys ?? 10_000);
  const keyTtl = opts.idempotencyTtlMs ?? 24 * 60 * 60_000;
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, Map<string, StepRecord>>();
  const waiters = new Map<string, WaiterRecord>();
  const waitersByRun = new Map<string, Map<string, WaiterRecord>>();
  const waitersByEvent = new Map<string, Set<WaiterRecord>>(); // open event waiters only
  const byKey = new Map<string, EventRecord>(); // insertion order = event order
  const finished = new Set<string>(); // in finishing order; the oldest are evicted
  let order = 0;
  const seqOf = new Map<string, number>();

  const unindexEvent = (w: WaiterRecord) => {
    const set = waitersByEvent.get(w.event);
    if (!set?.delete(w)) return;
    if (set.size === 0) waitersByEvent.delete(w.event);
  };
  const dropWaiter = (w: WaiterRecord) => {
    waiters.delete(w.id);
    unindexEvent(w);
    const m = waitersByRun.get(w.runId);
    if (m?.get(w.step) === w) m.delete(w.step);
    if (m && m.size === 0) waitersByRun.delete(w.runId);
  };
  const dropRun = (id: string) => {
    runs.delete(id);
    steps.delete(id);
    seqOf.delete(id);
    finished.delete(id);
    const m = waitersByRun.get(id);
    if (m) for (const w of [...m.values()]) dropWaiter(w);
  };
  const track = (r: RunRecord) => {
    if (!TERMINAL.has(r.status)) {
      finished.delete(r.id); // retried
      return;
    }
    if (finished.has(r.id)) return;
    finished.add(r.id);
    while (finished.size > maxFinished) dropRun(finished.values().next().value!);
  };
  const pruneKeys = (now: number) => {
    for (const [k, e] of byKey) {
      if (byKey.size <= maxKeys && e.createdAt > now - keyTtl) break;
      byKey.delete(k);
    }
  };

  return {
    kind: "memory",
    async createRun(run) {
      const r = clone(run);
      runs.set(run.id, r);
      seqOf.set(run.id, order++);
      track(r);
    },
    async getRun(id) {
      const r = runs.get(id);
      return r ? clone(r) : null;
    },
    async updateRun(id, patch) {
      const r = runs.get(id);
      if (!r) return;
      Object.assign(r, clone(patch));
      track(r);
    },
    async casRun(id, expect, patch) {
      const r = runs.get(id);
      if (!r || r.token !== expect.token) return false;
      if (expect.leaseFreeAt !== undefined && r.leaseUntil !== null && r.leaseUntil > expect.leaseFreeAt) return false;
      Object.assign(r, clone(patch));
      track(r);
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
      const c = clone(w);
      waiters.set(c.id, c);
      let m = waitersByRun.get(c.runId);
      if (!m) waitersByRun.set(c.runId, (m = new Map()));
      m.set(c.step, c);
      if (c.kind === "event" && !c.resolution) {
        let set = waitersByEvent.get(c.event);
        if (!set) waitersByEvent.set(c.event, (set = new Set()));
        set.add(c);
      }
    },
    async openWaiters(event, accept) {
      const open = [...(waitersByEvent.get(event) ?? [])];
      return clone((accept ? open.filter(accept) : open).sort((a, b) => a.createdAt - b.createdAt));
    },
    async getWaiter(runId, step) {
      const w = waitersByRun.get(runId)?.get(step);
      return w ? clone(w) : null;
    },
    async resolveWaiter(id, resolution) {
      const w = waiters.get(id);
      if (!w || w.resolution) return false;
      w.resolution = clone(resolution);
      unindexEvent(w);
      return true;
    },
    async deleteWaiters(runId, step) {
      const m = waitersByRun.get(runId);
      if (!m) return;
      for (const w of [...m.values()]) if (step === undefined || w.step === step) dropWaiter(w);
    },
    async recordEvent(e) {
      if (e.idempotencyKey !== null) {
        pruneKeys(e.createdAt);
        const prev = byKey.get(e.idempotencyKey);
        if (prev) return { duplicate: true, event: clone(prev) };
        byKey.set(e.idempotencyKey, clone(e));
        pruneKeys(e.createdAt);
      }
      return { duplicate: false, event: clone(e) };
    },
    describe: () => ({ adapter: "memory", runs: runs.size, waiters: waiters.size, idempotencyKeys: byKey.size, maxFinishedRuns: maxFinished }),
  };
}
