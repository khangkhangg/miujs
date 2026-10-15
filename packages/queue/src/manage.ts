// queue().manage(): what an operator sees and does in @miujs/admin. Counts and lists come from the
// adapter when it supports them; Cloudflare Queues cannot be counted or listed from a Worker, so
// the status says so instead of showing zeros.
import { errors, t, type Context, type Env, type ManageAction, type ManageList, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import { JOB_STATES, type JobState, type QueueAdapter } from "./adapter.ts";
import { queueErrors } from "./errors.ts";
import type { DispatchOptions, JobDef, Schedule } from "./job.ts";

/** Deepest offset a list pages to; past it, narrow the list instead. */
export const MAX_LIST_OFFSET = 10_000;
const PAGE_MAX = 100;

/** The latest attempt of a job in this process. */
export interface LastRun {
  at: number;
  /** "ok", "retrying: <error>" or "failed: <error>". */
  result: string;
}

export interface QueueManageDeps {
  adapter: QueueAdapter;
  jobs: ReadonlyMap<string, JobDef<any>>;
  schedules: readonly Schedule<any>[];
  lastRuns: ReadonlyMap<string, LastRun>;
  lastFired: WeakMap<Schedule<any>, number>;
  dispatch(job: JobDef<any>, input: unknown, o: DispatchOptions | undefined, env: Env): Promise<{ id: string }>;
}

// Input keys whose values are never shown (reset tokens, API keys, passwords, ...).
const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|auth|cookie|session|signature|credential|private|otp|ssn|card|cvv/i;

/** Compact JSON for a cell: secret-looking keys redacted, cut to `max` characters. */
export function previewJson(value: unknown, max = 300): string {
  let json: string;
  try {
    json = JSON.stringify(value, (k, v) => (k !== "" && SECRET_KEY.test(k) ? "[redacted]" : v)) ?? "null";
  } catch {
    json = "(not JSON)";
  }
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const n = /^\d{1,6}$/.test(cursor) ? Number(cursor) : NaN;
  if (!(n <= MAX_LIST_OFFSET)) throw errors.badRequest(`Invalid cursor ${JSON.stringify(cursor)}`, "Pass the `next` value of the previous page, or no cursor for the first page.");
  return n;
}

/** Fetches one extra row to know whether there is a next page. */
async function page<T>(q: { cursor?: string; limit: number }, fetch: (offset: number, n: number) => Promise<T[]>): Promise<{ items: T[]; next?: string }> {
  const offset = offsetOf(q.cursor);
  const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(q.limit) || PAGE_MAX));
  const got = await fetch(offset, limit + 1);
  const items = got.slice(0, limit);
  const more = got.length > limit && offset + limit <= MAX_LIST_OFFSET;
  return more ? { items, next: String(offset + limit) } : { items };
}

const idInput = t.object({ id: t.string({ minLength: 1, maxLength: 200 }) });

function backoffText(job: JobDef<any>): string {
  return typeof job.backoff === "number" ? `${job.backoff}s` : job.backoff;
}

function countStats(adapter: QueueAdapter, counts: { pending: number; delayed: number; inflight: number; deadLetters: number } | undefined): ManageStat[] {
  if (!counts) {
    const hint =
      adapter.name === "cloudflare"
        ? "Cloudflare Queues cannot be counted or listed from a Worker. See the queue's metrics in the Cloudflare dashboard (Workers & Pages → Queues)."
        : `The ${adapter.name} queue adapter cannot count messages.`;
    return ["Pending", "Delayed", "Running", "Dead letters"].map((label) => ({ label, value: null, hint }));
  }
  const durable = adapter.name !== "memory";
  return [
    { label: "Pending", value: counts.pending, hint: "Due now, waiting for a free worker." },
    { label: "Delayed", value: counts.delayed, hint: "Waiting for a delay or a retry backoff." },
    { label: "Running", value: counts.inflight, hint: durable ? "Leased by a worker in any instance." : "Running in this process." },
    {
      label: "Dead letters",
      value: counts.deadLetters,
      hint: "Jobs that failed every attempt. Retry or delete them under Dead letters.",
      ...(counts.deadLetters > 0 ? { tone: "critical" as const } : {}),
    },
  ];
}

export function queueManage(d: QueueManageDeps): ManageSection[] {
  const { adapter } = d;

  const status = async (ctx: Context) => {
    const stats: ManageStat[] = [{ label: "Adapter", value: adapter.name }, ...countStats(adapter, adapter.stats ? await adapter.stats(ctx.env) : undefined)];
    if (adapter.isPaused) {
      const paused = adapter.isPaused();
      stats.push({ label: "Paused", value: paused, hint: "This instance only: while paused it starts no jobs, but still accepts them.", ...(paused ? { tone: "warning" as const } : {}) });
    }
    if (adapter.getConcurrency) stats.push({ label: "Concurrency", value: adapter.getConcurrency(), hint: "Jobs this instance runs at once." });
    return {
      stats,
      tables: [
        {
          title: "Jobs",
          columns: [
            { key: "name", label: "Job", type: "code" as const },
            { key: "retries", label: "Retries", type: "number" as const },
            { key: "backoff", label: "Backoff" },
            { key: "lastRun", label: "Last run (this instance)", type: "date" as const },
            { key: "lastResult", label: "Last result" },
          ],
          rows: [...d.jobs.values()].map((j) => {
            const last = d.lastRuns.get(j.name);
            return { name: j.name, retries: j.retries, backoff: backoffText(j), lastRun: iso(last?.at), lastResult: last?.result ?? null };
          }),
        },
        {
          title: "Schedules",
          columns: [
            { key: "cron", label: "Cron (UTC)", type: "code" as const },
            { key: "job", label: "Job", type: "code" as const },
            { key: "lastRun", label: "Last fired (this instance)", type: "date" as const },
          ],
          rows: d.schedules.map((s) => ({ cron: s.cron.source, job: s.job.name, lastRun: iso(d.lastFired.get(s)) })),
        },
      ],
    };
  };

  const lists: ManageList[] = [];
  if (adapter.listJobs) {
    const listJobs = adapter.listJobs.bind(adapter);
    const rowActions: ManageAction[] = [];
    if (adapter.cancel) {
      const cancel = adapter.cancel.bind(adapter);
      rowActions.push({
        name: "delete",
        title: "Delete",
        description: "Remove a job that has not started yet. A running job cannot be stopped.",
        danger: true,
        input: idInput,
        async run(input: { id: string }, ctx) {
          return (await cancel(input.id, ctx.env)) ? `Deleted job ${input.id}.` : `Job ${input.id} is not waiting (it ran, is running, or does not exist); nothing deleted.`;
        },
      });
    }
    lists.push({
      name: "jobs",
      title: "Jobs",
      columns: [
        { key: "id", label: "Id", type: "code" },
        { key: "job", label: "Job", type: "code" },
        { key: "state", label: "State" },
        { key: "attempt", label: "Attempt", type: "number" },
        { key: "runAt", label: "Due", type: "date" },
        { key: "input", label: "Input (secrets hidden)", type: "code" },
      ],
      idKey: "id",
      filters: [{ key: "state", label: "State", options: [...JOB_STATES] }],
      async list(q, ctx) {
        const state = (q.filters?.state || "pending") as JobState;
        if (!JOB_STATES.includes(state)) throw errors.badRequest(`Unknown job state ${JSON.stringify(state)}`, `Filter by one of: ${JOB_STATES.join(", ")}.`);
        const { items, next } = await page(q, (offset, n) => listJobs(state, offset, n, ctx.env));
        const rows: Record<string, ManageValue>[] = items.map((r) => ({ id: r.id, job: r.job, state: r.state, attempt: r.attempt, runAt: iso(r.runAt), input: previewJson(r.input) }));
        return next ? { rows, next } : { rows };
      },
      rowActions,
    });
  }
  if (adapter.listDead) {
    const listDead = adapter.listDead.bind(adapter);
    const rowActions: ManageAction[] = [];
    if (adapter.retryDead) {
      const retryDead = adapter.retryDead.bind(adapter);
      rowActions.push({
        name: "retry",
        title: "Retry",
        description: "Queue the job again as a first attempt and remove the dead letter.",
        input: idInput,
        async run(input: { id: string }, ctx) {
          return (await retryDead(input.id, ctx.env)) ? `Dead letter ${input.id} queued again as attempt 1.` : `No dead letter ${input.id} (already retried or deleted).`;
        },
      });
    }
    if (adapter.deleteDead) {
      const deleteDead = adapter.deleteDead.bind(adapter);
      rowActions.push({
        name: "delete",
        title: "Delete",
        description: "Forget this dead letter. The job is not run again.",
        danger: true,
        input: idInput,
        async run(input: { id: string }, ctx) {
          return (await deleteDead(input.id, ctx.env)) ? `Deleted dead letter ${input.id}.` : `No dead letter ${input.id} (already retried or deleted).`;
        },
      });
    }
    lists.push({
      name: "dead",
      title: "Dead letters",
      columns: [
        { key: "id", label: "Id", type: "code" },
        { key: "job", label: "Job", type: "code" },
        { key: "attempts", label: "Attempts", type: "number" },
        { key: "error", label: "Last error" },
        { key: "code", label: "Code", type: "code" },
        { key: "failedAt", label: "Failed", type: "date" },
        { key: "input", label: "Input (secrets hidden)", type: "code" },
      ],
      idKey: "id",
      async list(q, ctx) {
        const { items, next } = await page(q, (offset, n) => listDead(offset, n, ctx.env));
        const rows: Record<string, ManageValue>[] = items.map((l) => ({ id: l.id, job: l.job, attempts: l.attempts, error: clip(l.error), code: l.code ?? null, failedAt: iso(l.failedAt), input: previewJson(l.input) }));
        return next ? { rows, next } : { rows };
      },
      rowActions,
    });
  }

  const findJob = (name: string): JobDef<any> => {
    if (name.startsWith("miu.")) throw errors.badRequest(`"${name}" is an internal job`, "Internal jobs (miu.*) are dispatched by their plugin; start the workflow or feature that owns them instead.");
    const job = d.jobs.get(name);
    if (!job) throw queueErrors.unknownJob(name, [...d.jobs.keys()].filter((n) => !n.startsWith("miu.")));
    return job;
  };

  const actions: ManageAction[] = [
    {
      name: "dispatch",
      title: "Enqueue a job",
      description: "Queue a job with JSON input, e.g. to test it. The input is validated by the job's schema.",
      input: t.object({
        job: t.string({ minLength: 1, maxLength: 200, description: "Job name" }),
        input: t.optional(t.unknown({ description: "JSON input (an object, or JSON text)" })),
        delay: t.optional(t.integer({ min: 0, max: 7 * 86_400, description: "Seconds to wait before running" })),
      }),
      async run(input: { job: string; input?: unknown; delay?: number }, ctx) {
        const job = findJob(input.job);
        let value = input.input ?? {};
        if (typeof value === "string") {
          try {
            value = JSON.parse(value);
          } catch {
            throw errors.badRequest("input is not valid JSON", 'Pass an object, or JSON text such as {"to":"ann@example.com"}.');
          }
        }
        const { id } = await d.dispatch(job, value, input.delay ? { delay: input.delay } : undefined, ctx.env);
        return { id, message: `Queued ${job.name} as ${id}${input.delay ? ` (runs in ${input.delay}s)` : ""}.` };
      },
    },
    {
      name: "runSchedule",
      title: "Run a schedule now",
      description: "Dispatch a cron schedule's job with its input now, without waiting for the next tick.",
      input: t.object({
        job: t.string({ minLength: 1, maxLength: 200, description: "Job of the schedule" }),
        cron: t.optional(t.string({ maxLength: 100, description: "Cron expression, when the job has several schedules" })),
      }),
      async run(input: { job: string; cron?: string }, ctx) {
        const cron = input.cron?.trim().split(/\s+/).join(" ");
        const forJob = d.schedules.filter((s) => s.job.name === input.job);
        const hits = cron ? forJob.filter((s) => s.cron.source === cron) : forJob;
        if (hits.length === 0) {
          const known = d.schedules.map((s) => `${s.job.name} (${s.cron.source})`);
          throw errors.badRequest(`No schedule runs job "${input.job}"${cron ? ` at "${cron}"` : ""}`, known.length ? `Schedules: ${known.join(", ")}.` : "This queue has no schedules.");
        }
        if (hits.length > 1) throw errors.badRequest(`Job "${input.job}" has ${hits.length} schedules: ${hits.map((s) => s.cron.source).join(", ")}`, "Pass `cron` to pick one.");
        const s = hits[0];
        d.lastFired.set(s, adapter.now?.() ?? Date.now());
        const { id } = await d.dispatch(s.job, s.input, undefined, ctx.env);
        return { id, message: `Queued ${s.job.name} (schedule ${s.cron.source}) as ${id}.` };
      },
    },
  ];
  if (adapter.pause && adapter.resume && adapter.isPaused) {
    const a = adapter as Required<Pick<QueueAdapter, "pause" | "resume" | "isPaused">>;
    actions.push(
      {
        name: "pause",
        title: "Pause this instance",
        description: "Stop starting jobs in this instance (running ones finish). Jobs are still accepted. Other instances are not paused, and a restart resumes.",
        run() {
          if (a.isPaused()) return "Already paused.";
          a.pause();
          return "Paused: this instance starts no jobs until resumed. Jobs are still accepted.";
        },
      },
      {
        name: "resume",
        title: "Resume this instance",
        description: "Start running jobs again in this instance.",
        run() {
          if (!a.isPaused()) return "Not paused; nothing to do.";
          a.resume();
          return "Resumed: this instance runs jobs again.";
        },
      },
    );
  }

  const settings =
    adapter.getConcurrency && adapter.setConcurrency
      ? {
          schema: t.object({ concurrency: t.integer({ min: 1, max: 1000, description: "Jobs this instance runs at once" }) }),
          get: () => ({ concurrency: adapter.getConcurrency!() }),
          set: (v: { concurrency: number }) => adapter.setConcurrency!(v.concurrency),
        }
      : undefined;

  return [
    {
      id: "queue",
      title: "Queue",
      description: "Background jobs and cron schedules: counts, waiting and dead jobs, and running jobs by hand.",
      status,
      lists,
      ...(settings ? { settings } : {}),
      actions,
    },
  ];
}
