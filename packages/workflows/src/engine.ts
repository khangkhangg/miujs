import { isMiuError, validate, type Env, type Logger } from "miujs";
import { backoffSeconds, type Clock } from "@miujs/queue";
import {
  normalizeApprovers,
  type ApprovalDecision,
  type Mailer,
  type Step,
  type StepRunOptions,
  type WorkflowContext,
  type WorkflowDef,
  type WorkflowEvent,
} from "./define.ts";
import { parseDuration } from "./duration.ts";
import { StepFailedError, workflowErrors } from "./errors.ts";
import { TERMINAL, type Approvers, type RunError, type RunFilter, type RunRecord, type RunStatus, type RunStore, type StepKind, type StepRecord, type TriggerInfo, type WaiterRecord } from "./store.ts";

/** Event name approval waiters use. Approvals are only resolved by the approvals route, never by emit. */
export const APPROVAL_EVENT = "workflow.approval";

const ACTIVE: RunStatus[] = ["queued", "running", "sleeping", "waiting"];

type Outcome =
  | { type: "completed"; output: unknown }
  | { type: "failed"; error: RunError }
  | { type: "continue" }
  | { type: "retry"; until: number }
  | { type: "sleep"; until: number }
  | { type: "wait"; until: number | null; waiter: Omit<WaiterRecord, "id" | "createdAt" | "resolution"> };

export interface EngineOptions {
  workflows: Map<string, WorkflowDef<any>>;
  store: RunStore;
  clock: Clock;
  /** Enqueue a resume message, `delaySeconds` already capped. */
  dispatch(msg: { runId: string; token: string }, delaySeconds: number, env: Env): Promise<void>;
  maxDelaySeconds: number;
  leaseMs: number;
  log(): Logger;
  fetch(): typeof fetch;
  mailer(): Mailer | undefined;
  /** Looks up an app service (`app.service`). */
  service(name: string): unknown;
}

export interface StartOptions {
  trigger?: TriggerInfo;
}

export interface EmitResult {
  /** Event id (the first one's, for a duplicate). */
  id: string;
  duplicate: boolean;
  started: { id: string; workflow: string }[];
  /** Runs whose waitForEvent this event resolved. */
  resumed: string[];
  /** Workflows the event matched but could not start (e.g. data did not fit their input). */
  skipped: { workflow: string; code: string; message: string }[];
}

export interface StepView extends StepRecord {
  /** For waiting steps: what the run waits for. */
  waitingFor?: { event?: string; match?: Record<string, unknown> | null; approvers?: Approvers | null; expiresAt: number | null };
}

export interface RunView extends RunRecord {
  steps: StepView[];
}

const HANG = new Promise<never>(() => {});

function roundTrip<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function newToken(): string {
  return crypto.randomUUID();
}

export function toRunError(err: unknown, step?: string): RunError {
  const e = err as { message?: unknown; code?: unknown; name?: unknown; step?: unknown } | null;
  const out: RunError = { message: typeof e?.message === "string" ? e.message : String(err) };
  if (typeof e?.code === "string") out.code = e.code;
  if (typeof e?.name === "string" && !isMiuError(err)) out.name = e.name;
  const s = step ?? (typeof e?.step === "string" ? e.step : undefined);
  if (s !== undefined) out.step = s;
  return out;
}

function retryable(err: unknown): boolean {
  if ((err as { retryable?: unknown } | null)?.retryable === false) return false;
  return true;
}

/** Own-property dotted path lookup, the same rules as expressions. */
export function getPath(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v)) v = k === "length" ? v.length : /^\d+$/.test(k) ? v[Number(k)] : undefined;
    else v = Object.prototype.hasOwnProperty.call(v, k) ? (v as Record<string, unknown>)[k] : undefined;
  }
  return v;
}

export function matches(match: Record<string, unknown> | null | undefined, event: WorkflowEvent): boolean {
  if (!match) return true;
  for (const [path, want] of Object.entries(match)) {
    if (JSON.stringify(getPath(event, path)) !== JSON.stringify(want)) return false;
  }
  return true;
}

function backoffMs(opts: StepRunOptions | undefined, attempt: number): number {
  const b = opts?.backoff ?? "exponential";
  const seconds = typeof b === "function" ? b(attempt) : backoffSeconds({ backoff: b }, attempt);
  return Math.max(0, seconds) * 1000;
}

/** The durable execution engine: start, resume (replay), events, control. */
export class Engine {
  readonly opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  store(env: Env): RunStore {
    const s = this.opts.store;
    return s.forEnv ? s.forEnv(env) : s;
  }

  private now(): number {
    return this.opts.clock.now();
  }

  private def(name: string): WorkflowDef<any> {
    const d = this.opts.workflows.get(name);
    if (!d) throw workflowErrors.unknownWorkflow(name, [...this.opts.workflows.keys()]);
    return d;
  }

  private async schedule(runId: string, token: string, delayMs: number, env: Env): Promise<void> {
    const seconds = Math.min(this.opts.maxDelaySeconds, Math.max(0, Math.ceil(delayMs / 1000)));
    await this.opts.dispatch({ runId, token }, seconds, env);
  }

  // -------------------------------------------------------------------------------------------
  // start / events

  async start(nameOrDef: string | WorkflowDef<any>, input: unknown, env: Env, o: StartOptions = {}): Promise<{ id: string; status: RunStatus }> {
    const def = this.def(typeof nameOrDef === "string" ? nameOrDef : nameOrDef.name);
    const checked = validate(def.input, input ?? {});
    if (!checked.ok) throw workflowErrors.input(def.name, checked.issues);
    const value = roundTrip(checked.value);
    const store = this.store(env);
    const key = def.concurrency ? String(def.concurrency.key(value)) : null;
    let admitted = true;
    if (key !== null) admitted = (await this.activeCount(store, def.name, key)) < def.concurrency!.limit;
    const now = this.now();
    const token = admitted ? newToken() : null;
    const run: RunRecord = {
      id: crypto.randomUUID(),
      workflow: def.name,
      status: "queued",
      input: value,
      output: undefined,
      error: null,
      trigger: o.trigger ?? { type: "manual" },
      concurrencyKey: key,
      token,
      leaseUntil: null,
      wakeAt: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await store.createRun(run);
    if (token) await this.schedule(run.id, token, 0, env);
    return { id: run.id, status: run.status };
  }

  private async activeCount(store: RunStore, workflow: string, key: string): Promise<number> {
    const runs = await store.listRuns({ workflow, concurrencyKey: key, status: ACTIVE });
    // Queued runs without a token are the ones held back by this limit.
    return runs.filter((r) => r.status !== "queued" || r.token !== null).length;
  }

  private async release(store: RunStore, run: RunRecord, env: Env): Promise<void> {
    const def = this.opts.workflows.get(run.workflow);
    if (!def?.concurrency || run.concurrencyKey === null) return;
    let free = def.concurrency.limit - (await this.activeCount(store, run.workflow, run.concurrencyKey));
    if (free <= 0) return;
    const held = (await store.listRuns({ workflow: run.workflow, concurrencyKey: run.concurrencyKey, status: "queued", order: "asc" })).filter((r) => r.token === null);
    for (const r of held) {
      if (free <= 0) break;
      const token = newToken();
      if (await store.casRun(r.id, { token: null }, { token, updatedAt: this.now() })) {
        free--;
        await this.schedule(r.id, token, 0, env);
      }
    }
  }

  async emit(name: string, data: unknown, env: Env, o: { idempotencyKey?: string } = {}): Promise<EmitResult> {
    if (typeof name !== "string" || name === "") {
      throw workflowErrors.config(`emit() needs an event name, got ${JSON.stringify(name)}`, 'Call emit("contact.created", { ... }).');
    }
    if (name === APPROVAL_EVENT) throw workflowErrors.reservedEvent(name);
    const store = this.store(env);
    const now = this.now();
    const rec = { id: crypto.randomUUID(), name, data: roundTrip(data) ?? null, idempotencyKey: o.idempotencyKey ?? null, createdAt: now };
    const { duplicate, event } = await store.recordEvent(rec);
    const result: EmitResult = { id: event.id, duplicate, started: [], resumed: [], skipped: [] };
    if (duplicate) return result;
    const evt: WorkflowEvent = { id: rec.id, name, data: rec.data, ts: now };

    for (const def of this.opts.workflows.values()) {
      for (const tr of def.triggers) {
        if (tr.type !== "event" || tr.event !== name || !matches(tr.match, evt)) continue;
        try {
          const input = tr.input ? tr.input(evt) : evt.data;
          const r = await this.start(def, input, env, { trigger: { type: "event", event: name, eventId: evt.id } });
          result.started.push({ id: r.id, workflow: def.name });
        } catch (err) {
          const e = toRunError(err);
          result.skipped.push({ workflow: def.name, code: e.code ?? "MIU_E_INTERNAL", message: e.message });
          this.opts.log().warn("event did not start workflow", { event: name, workflow: def.name, err });
        }
      }
    }

    for (const w of await store.openWaiters(name)) {
      if (!matches(w.match, evt)) continue;
      if (await store.resolveWaiter(w.id, { value: evt })) {
        result.resumed.push(w.runId);
        await this.wake(store, w.runId, env);
      }
    }
    return result;
  }

  /** Resume a parked run now (its waiter was resolved). Safe to call when it is running. */
  private async wake(store: RunStore, runId: string, env: Env): Promise<void> {
    const run = await store.getRun(runId);
    if (!run || TERMINAL.has(run.status)) return;
    const token = newToken();
    const now = this.now();
    if (await store.casRun(runId, { token: run.token, leaseFreeAt: now }, { status: "running", token, wakeAt: null, updatedAt: now })) {
      await this.schedule(runId, token, 0, env);
    }
    // Otherwise an invocation holds the lease; it re-checks resolved waiters when it parks.
  }

  // -------------------------------------------------------------------------------------------
  // approvals

  async decide(runId: string, stepName: string, user: { id: string; roles?: string[]; name?: string; email?: string }, decision: "approve" | "reject", comment: string | undefined, env: Env): Promise<{ runId: string; step: string; decision: string }> {
    const store = this.store(env);
    const w = await store.getWaiter(runId, stepName);
    if (!w || w.kind !== "approval" || w.resolution) throw workflowErrors.noApproval(runId, stepName);
    const a = w.approvers ?? {};
    const ok = (a.role ?? []).some((r) => user.roles?.includes(r)) || (a.users ?? []).includes(user.id);
    if (!ok) throw workflowErrors.approver(stepName);
    const by: ApprovalDecision["by"] = { id: user.id };
    if (user.name) by.name = user.name;
    if (user.email) by.email = user.email;
    const value: ApprovalDecision = { decision, by, at: this.now() };
    if (comment !== undefined) value.comment = comment;
    if (!(await store.resolveWaiter(w.id, { value }))) throw workflowErrors.noApproval(runId, stepName);
    await this.wake(store, runId, env);
    return { runId, step: stepName, decision };
  }

  // -------------------------------------------------------------------------------------------
  // control

  async getRun(id: string, env: Env): Promise<RunView> {
    const store = this.store(env);
    const run = await store.getRun(id);
    if (!run) throw workflowErrors.runNotFound(id);
    const steps: StepView[] = await store.getSteps(id);
    for (const s of steps) {
      if (s.status !== "waiting") continue;
      const w = await store.getWaiter(id, s.name);
      if (w) s.waitingFor = w.kind === "approval" ? { approvers: w.approvers, expiresAt: w.expiresAt } : { event: w.event, match: w.match, expiresAt: w.expiresAt };
    }
    return { ...run, steps };
  }

  listRuns(filter: RunFilter, env: Env): Promise<RunRecord[]> {
    return this.store(env).listRuns({ limit: 50, ...filter });
  }

  async cancel(id: string, env: Env): Promise<RunRecord> {
    const store = this.store(env);
    const run = await store.getRun(id);
    if (!run) throw workflowErrors.runNotFound(id);
    if (TERMINAL.has(run.status)) throw workflowErrors.runState(id, run.status, "cancel", "queued, running, sleeping or waiting");
    const now = this.now();
    const patch: Partial<RunRecord> = { status: "cancelled", token: null, leaseUntil: null, wakeAt: null, updatedAt: now, finishedAt: now };
    await store.updateRun(id, patch);
    await store.deleteWaiters(id);
    await this.release(store, run, env);
    return { ...run, ...patch };
  }

  async retry(id: string, env: Env): Promise<RunRecord> {
    const store = this.store(env);
    const run = await store.getRun(id);
    if (!run) throw workflowErrors.runNotFound(id);
    if (run.status !== "failed") throw workflowErrors.runState(id, run.status, "retry", "failed");
    const now = this.now();
    for (const s of await store.getSteps(id)) {
      if (s.status === "failed") await store.saveStep({ ...s, status: "retrying", attempts: 0, error: null, wakeAt: null, updatedAt: now });
    }
    const token = newToken();
    const patch: Partial<RunRecord> = { status: "queued", token, error: null, leaseUntil: null, wakeAt: null, finishedAt: null, updatedAt: now };
    if (!(await store.casRun(id, { token: run.token }, patch))) throw workflowErrors.runState(id, "changing", "retry", "failed");
    await this.schedule(id, token, 0, env);
    return { ...run, ...patch };
  }

  // -------------------------------------------------------------------------------------------
  // resume: claim, replay, persist the outcome

  async resume(runId: string, token: string, env: Env): Promise<void> {
    const store = this.store(env);
    const run = await store.getRun(runId);
    if (!run || run.token !== token || TERMINAL.has(run.status)) return; // stale or duplicate message
    const now = this.now();
    if (run.wakeAt !== null && run.wakeAt > now) {
      // Woken early: the adapter capped the delay. Chain another message.
      const next = newToken();
      if (await store.casRun(runId, { token, leaseFreeAt: now }, { token: next })) await this.schedule(runId, next, run.wakeAt - now, env);
      return;
    }
    if (!(await store.casRun(runId, { token, leaseFreeAt: now }, { status: "running", leaseUntil: now + this.opts.leaseMs, wakeAt: null, updatedAt: now }))) return;

    try {
      const def = this.opts.workflows.get(run.workflow);
      const outcome: Outcome = def
        ? await this.invoke(def, run, store, env)
        : { type: "failed", error: toRunError(workflowErrors.unknownWorkflow(run.workflow, [...this.opts.workflows.keys()])) };
      await this.persist(store, run, token, outcome, env);
    } catch (err) {
      // Infrastructure failure (store, queue): free the lease so the queue's retry can claim it.
      await store.casRun(runId, { token }, { leaseUntil: null }).catch(() => {});
      throw err;
    }
  }

  private async persist(store: RunStore, run: RunRecord, token: string, o: Outcome, env: Env): Promise<void> {
    const now = this.now();
    const base = { leaseUntil: null, updatedAt: now };
    const id = run.id;
    switch (o.type) {
      case "completed":
      case "failed": {
        const patch: Partial<RunRecord> =
          o.type === "completed"
            ? { ...base, status: "completed", output: o.output, token: null, wakeAt: null, finishedAt: now }
            : { ...base, status: "failed", error: o.error, token: null, wakeAt: null, finishedAt: now };
        if (await store.casRun(id, { token }, patch)) {
          await store.deleteWaiters(id);
          await this.release(store, run, env);
          if (o.type === "failed") this.opts.log().warn("workflow run failed", { workflow: run.workflow, runId: id, error: o.error });
        }
        return;
      }
      case "continue":
      case "retry":
      case "sleep": {
        const next = newToken();
        const until = o.type === "continue" ? null : o.until;
        const status: RunStatus = o.type === "sleep" ? "sleeping" : "running";
        if (await store.casRun(id, { token }, { ...base, status, token: next, wakeAt: until })) await this.schedule(id, next, until === null ? 0 : until - now, env);
        return;
      }
      case "wait": {
        const next = newToken();
        // Token first, waiter last: an event resolving the waiter then always sees the new token.
        if (!(await store.casRun(id, { token }, { ...base, status: "waiting", token: next, wakeAt: o.until }))) return;
        if (o.until !== null) await this.schedule(id, next, o.until - now, env);
        const existing = await store.getWaiter(id, o.waiter.step);
        if (!existing) await store.addWaiter({ ...o.waiter, id: crypto.randomUUID(), resolution: null, createdAt: now });
        else if (existing.resolution) await this.wake(store, id, env);
        return;
      }
    }
  }

  private async invoke(def: WorkflowDef<any>, run: RunRecord, store: RunStore, env: Env): Promise<Outcome> {
    const journal = new Map<string, StepRecord>();
    for (const s of await store.getSteps(run.id)) journal.set(s.name, s);
    let seq = 0;
    for (const s of journal.values()) seq = Math.max(seq, s.seq + 1);

    let done = false;
    let executing = false;
    let resolveOutcome!: (o: Outcome) => void;
    const outcome = new Promise<Outcome>((r) => (resolveOutcome = r));
    const finish = (o: Outcome): Promise<never> => {
      if (!done) {
        done = true;
        resolveOutcome(o);
      }
      return HANG;
    };
    const blocked = () => done || executing;
    const now = () => this.now();
    const seen = new Set<string>();
    let autoNow = 0;
    let autoUuid = 0;

    const claim = (name: string): boolean => {
      if (typeof name !== "string" || name === "") {
        finish({ type: "failed", error: toRunError(workflowErrors.config(`Workflow "${def.name}": step names must be non-empty strings`, 'Pass a name: step.run("enrich", ...).')) });
        return false;
      }
      if (seen.has(name)) {
        finish({ type: "failed", error: toRunError(workflowErrors.duplicateStep(def.name, name), name) });
        return false;
      }
      seen.add(name);
      return true;
    };
    const record = (name: string, kind: StepKind, patch: Partial<StepRecord>): StepRecord => {
      const prev = journal.get(name);
      return {
        runId: run.id,
        name,
        seq: prev?.seq ?? seq++,
        kind,
        status: "completed",
        output: undefined,
        error: null,
        attempts: prev?.attempts ?? 0,
        wakeAt: null,
        startedAt: prev?.startedAt ?? now(),
        updatedAt: now(),
        ...patch,
      };
    };
    const save = async (rec: StepRecord) => {
      journal.set(rec.name, rec);
      await store.saveStep(rec);
    };

    const journaledValue = async <T>(name: string, kind: StepKind, make: () => T): Promise<T> => {
      if (!claim(name)) return HANG;
      const rec = journal.get(name);
      if (rec?.status === "completed") return rec.output as T;
      if (blocked()) return HANG;
      const value = make();
      await save(record(name, kind, { output: value }));
      return value;
    };

    const wait = async (name: string, kind: "wait" | "approval", event: string, match: Record<string, unknown> | null, approvers: Approvers | null, timeout: unknown): Promise<unknown> => {
      if (!claim(name)) return HANG;
      const rec = journal.get(name);
      if (rec?.status === "completed") return rec.output;
      if (blocked()) return HANG;
      const waiter = { runId: run.id, step: name, kind: kind === "approval" ? ("approval" as const) : ("event" as const), event, match, approvers, expiresAt: null as number | null };
      if (!rec) {
        const until = timeout === undefined ? null : now() + parseDuration(timeout as string);
        await save(record(name, kind, { status: "waiting", wakeAt: until }));
        return finish({ type: "wait", until, waiter: { ...waiter, expiresAt: until } });
      }
      let w = await store.getWaiter(run.id, name);
      const timedOut = rec.wakeAt !== null && rec.wakeAt <= now();
      if (!w?.resolution && timedOut && w && !(await store.resolveWaiter(w.id, { value: null }))) w = await store.getWaiter(run.id, name);
      if (w?.resolution || timedOut) {
        const value = w?.resolution ? w.resolution.value : null;
        await save(record(name, kind, { status: "completed", output: roundTrip(value), wakeAt: null }));
        await store.deleteWaiters(run.id, name);
        return value;
      }
      return finish({ type: "wait", until: rec.wakeAt, waiter: { ...waiter, expiresAt: rec.wakeAt } });
    };

    const sleepUntil = async (name: string, until: number): Promise<void> => {
      if (!claim(name)) return HANG;
      const rec = journal.get(name);
      if (rec?.status === "completed") return;
      if (blocked()) return HANG;
      if (!rec) {
        await save(record(name, "sleep", { status: "sleeping", wakeAt: until }));
        return finish({ type: "sleep", until });
      }
      if (rec.wakeAt !== null && rec.wakeAt > now()) return finish({ type: "sleep", until: rec.wakeAt });
      await save(record(name, "sleep", { status: "completed", wakeAt: null }));
    };

    const step: Step = {
      run: async (name, fn, opts) => {
        if (!claim(name)) return HANG;
        const rec = journal.get(name);
        if (rec?.status === "completed") return rec.output as any;
        if (rec?.status === "failed") throw new StepFailedError(name, rec.error?.message ?? "step failed", rec.error?.code);
        if (blocked()) return HANG;
        if (rec?.status === "retrying" && rec.wakeAt !== null && rec.wakeAt > now()) return finish({ type: "retry", until: rec.wakeAt });
        executing = true;
        const attempts = (rec?.attempts ?? 0) + 1;
        let output: unknown;
        try {
          output = await fn();
          try {
            output = roundTrip(output);
          } catch (err) {
            throw Object.assign(new Error(`Step "${name}" returned a value that is not JSON-serializable: ${(err as Error).message}`), { retryable: false });
          }
        } catch (err) {
          const e = toRunError(err, name);
          const retries = opts?.retries ?? 3;
          if (retryable(err) && attempts <= retries) {
            const until = now() + backoffMs(opts, attempts);
            await save(record(name, "run", { status: "retrying", attempts, error: e, wakeAt: until }));
            return finish({ type: "retry", until });
          }
          await save(record(name, "run", { status: "failed", attempts, error: e, wakeAt: null }));
          executing = false;
          throw new StepFailedError(name, e.message, e.code);
        }
        await save(record(name, "run", { status: "completed", attempts, output, error: null, wakeAt: null }));
        return finish({ type: "continue" });
      },
      // On replay the journaled wake-up time wins; the duration only matters the first time.
      sleep: async (name, duration) => sleepUntil(name, journal.has(name) ? 0 : now() + parseDuration(duration)),
      sleepUntil: (name, until) => sleepUntil(name, typeof until === "number" ? until : until.getTime()),
      waitForEvent: (name, o) => {
        if (o?.event === APPROVAL_EVENT) {
          throw workflowErrors.config(`"${APPROVAL_EVENT}" is reserved`, "Use step.waitForApproval() for approvals.");
        }
        return wait(name, "wait", o?.event, o?.match ?? null, null, o?.timeout) as Promise<any>;
      },
      waitForApproval: (name, o) => wait(name, "approval", APPROVAL_EVENT, null, normalizeApprovers(o?.approvers), o?.timeout) as Promise<any>,
      now: (name) => journaledValue(name ?? `now#${++autoNow}`, "now", () => now()),
      uuid: (name) => journaledValue(name ?? `uuid#${++autoUuid}`, "uuid", () => crypto.randomUUID()),
    };

    const log = this.opts.log().child({ workflow: def.name, runId: run.id });
    const ctx: WorkflowContext<any> = {
      input: run.input,
      step,
      log,
      env,
      run: { id: run.id, workflow: def.name, trigger: run.trigger },
      fetch: this.opts.fetch(),
      mailer: this.opts.mailer(),
      service: <T,>(name: string) => this.opts.service(name) as T,
    };
    Promise.resolve()
      .then(() => def.run(ctx))
      .then(
        (output) => {
          try {
            finish({ type: "completed", output: roundTrip(output) });
          } catch (err) {
            finish({ type: "failed", error: toRunError(err) });
          }
        },
        (err) => finish({ type: "failed", error: toRunError(err) }),
      );
    return outcome;
  }
}
