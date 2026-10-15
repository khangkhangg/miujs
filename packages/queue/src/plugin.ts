import { createLogger, definePlugin, targetRuntime, isMiuError, type App, type CloudflareNeeds, type Context, type Env, type Logger } from "miujs";
import type { QueueAdapter, QueueMessage, QueueRuntime, RunResult } from "./adapter.ts";
import { queueErrors } from "./errors.ts";
import { backoffSeconds, checkInput, isJob, type Dispatch, type DispatchOptions, type JobDef, type JobInput, type Schedule } from "./job.ts";
import { queueManage, type LastRun } from "./manage.ts";
import { memoryQueue } from "./memory.ts";

declare module "miujs" {
  interface Context {
    /** Background jobs from `@miujs/queue`. */
    queue: QueueClient;
  }
}

export interface QueueClient {
  /** Validate `input` and enqueue `job`. Resolves once the message is accepted, not when it has run. */
  dispatch: Dispatch;
  /**
   * Remove a message that has not started yet (e.g. a delayed one) by the id `dispatch` returned.
   * False when it already ran, is running, or never existed. Not supported on Cloudflare Queues.
   */
  cancel(id: string): Promise<boolean>;
}

export interface QueueOptions {
  jobs?: JobDef<any>[];
  /** Cron schedules, e.g. `schedule("*\/5 * * * *", cleanup)`. Their jobs are registered automatically. */
  schedules?: Schedule<any>[];
  /** Default: `memoryQueue()` on Bun/Deno/Node, `cloudflareQueue({ binding: "JOBS" })` on Workers. */
  adapter?: QueueAdapter;
}

declare const Deno: { env: { toObject(): Record<string, string> } } | undefined;
declare const process: { env?: Record<string, string | undefined> } | undefined;

function processEnv(): Env {
  try {
    if (typeof Deno !== "undefined") return Deno.env.toObject();
  } catch {
    return {};
  }
  return (typeof process !== "undefined" && process.env) || {};
}

function newId(): string {
  return crypto.randomUUID();
}

let workersAdapterFactory: (() => QueueAdapter) | undefined;
/** @internal lets cloudflare.ts provide the Workers default without an import cycle. */
export function _setWorkersDefault(fn: () => QueueAdapter): void {
  workersAdapterFactory = fn;
}

/**
 * Background jobs and cron schedules. Adds `ctx.queue.dispatch(job, input, { delay })`.
 *
 * ```ts
 * miu({ plugins: [queue({ jobs: [sendEmail], schedules: [schedule("0 * * * *", hourly)] })] })
 * ```
 */
export function queue(opts: QueueOptions = {}) {
  // Decided per plugin (not at import) so `miu deploy cloudflare` (MIU_TARGET) picks Workers defaults.
  const adapter = opts.adapter ?? (targetRuntime() === "workerd" && workersAdapterFactory ? workersAdapterFactory() : memoryQueue());
  // Kept as given (not copied), so the adapters always see the live list.
  const schedules = opts.schedules ?? [];
  const jobs = new Map<string, JobDef<any>>();
  const addJob = (job: JobDef<any>) => {
    const prev = jobs.get(job.name);
    if (prev && prev !== job) throw queueErrors.duplicateJob(job.name);
    jobs.set(job.name, job);
  };
  for (const job of [...(opts.jobs ?? []), ...schedules.map((s) => s.job)]) addJob(job);
  let log: Logger = createLogger("info", { plugin: "queue" });

  const dispatch = async (job: JobDef<any>, input: unknown, o: DispatchOptions | undefined, env: Env): Promise<{ id: string }> => {
    if (jobs.get(job?.name) !== job) throw queueErrors.unknownJob(String(job?.name), [...jobs.keys()]);
    const value = checkInput(job, input);
    const delay = o?.delay;
    if (delay !== undefined && !(typeof delay === "number" && Number.isFinite(delay) && delay >= 0)) throw queueErrors.delay(delay, Infinity);
    const msg: QueueMessage = { id: newId(), job: job.name, input: value };
    await adapter.send(msg, { delay }, env);
    return { id: msg.id };
  };

  const dispatcherFor = (env: Env): Dispatch => (job, input, o) => dispatch(job, input, o, env);

  const cancel = (id: string, env: Env): Promise<boolean> => {
    if (!adapter.cancel) {
      return Promise.reject(queueErrors.config(`The ${adapter.name} queue adapter cannot cancel messages`, "Use memoryQueue(), sqliteQueue() or redisQueue(), or have the job check whether it is still wanted when it runs."));
    }
    if (typeof id !== "string" || id === "") return Promise.resolve(false);
    return adapter.cancel(id, env);
  };

  // For the admin status: the latest attempt per job and the latest firing per schedule, in this process.
  const lastRuns = new Map<string, LastRun>();
  const lastFired = new WeakMap<Schedule<any>, number>();
  const now = () => adapter.now?.() ?? Date.now();
  const errText = (e: unknown) => {
    const m = (e as { message?: unknown } | null)?.message;
    const text = typeof m === "string" ? m : String(e);
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  };

  const run = async (msg: QueueMessage, attempt: number, env: Env): Promise<RunResult> => {
    const res = await attemptJob(msg, attempt, env);
    if (jobs.has(msg.job)) lastRuns.set(msg.job, { at: now(), result: res.ok ? "ok" : `${res.retry ? "retrying" : "failed"}: ${errText(res.error)}` });
    return res;
  };

  const attemptJob = async (msg: QueueMessage, attempt: number, env: Env): Promise<RunResult> => {
    const job = jobs.get(msg.job);
    const jlog = log.child({ job: msg.job, jobId: msg.id, attempt });
    if (!job) {
      const error = queueErrors.unknownJob(msg.job, [...jobs.keys()]);
      jlog.error(error.message, { code: error.code, fix: error.fix });
      return { ok: false, error, retry: false, delaySeconds: 0 };
    }
    let input: unknown;
    try {
      input = checkInput(job, msg.input);
    } catch (error) {
      jlog.error("job input is invalid; not retrying", { err: error });
      return { ok: false, error, retry: false, delaySeconds: 0 };
    }
    try {
      await job.run({ input, attempt, maxAttempts: job.maxAttempts, id: msg.id, job: job.name, log: jlog, env, dispatch: dispatcherFor(env) });
      return { ok: true };
    } catch (error) {
      if (attempt < job.maxAttempts) {
        const delaySeconds = backoffSeconds(job, attempt);
        jlog.warn("job failed; will retry", { err: error, retryInSeconds: delaySeconds });
        return { ok: false, error, retry: true, delaySeconds };
      }
      jlog.error("job failed; no retries left", { err: error, code: isMiuError(error) ? error.code : undefined });
      return { ok: false, error, retry: false, delaySeconds: 0 };
    }
  };

  const rt: QueueRuntime = {
    jobs,
    schedules,
    get log() {
      return log;
    },
    defaultEnv: processEnv,
    run,
    dispatch,
    fired: (s, minute) => void lastFired.set(s, minute),
  };
  adapter.attach(rt);

  return definePlugin({
    name: "queue",
    adapter,
    async setup(app: App) {
      log = app.log.child({ plugin: "queue" });
      await adapter.setup?.(app);
    },
    onRequest(ctx: Context) {
      const env = ctx.env;
      ctx.queue = { dispatch: dispatcherFor(env), cancel: (id) => cancel(id, env) };
    },
    /** Dispatch outside a request (scripts, tests). `env` defaults to the process env. */
    dispatch<J extends JobDef<any>>(job: J, input: JobInput<J>, o?: DispatchOptions, env: Env = processEnv()): Promise<{ id: string }> {
      return dispatch(job, input, o, env);
    },
    /** Cancel a message that has not started (see `QueueClient.cancel`). */
    cancel(id: string, env: Env = processEnv()): Promise<boolean> {
      return cancel(id, env);
    },
    /**
     * Add a cron schedule at runtime (its job is registered too). On Bun/Deno/Node the minute
     * scheduler starts with the first schedule and stops when the last is removed. On Workers,
     * crons fire only if they are also listed as Cron Triggers in wrangler.toml.
     */
    addSchedule<S extends Schedule<any>>(s: S): S {
      if (!s || typeof s !== "object" || !isJob(s.job) || typeof s.cron?.matches !== "function") {
        throw queueErrors.config("addSchedule needs a schedule from schedule()", 'Pass addSchedule(schedule("*/5 * * * *", job, input)).');
      }
      addJob(s.job);
      schedules.push(s);
      adapter.schedulesChanged?.();
      return s;
    },
    /** Remove a schedule added with `addSchedule` (or given in `schedules`). False when it was not there. */
    removeSchedule(s: Schedule<any>): boolean {
      const i = schedules.indexOf(s);
      if (i === -1) return false;
      schedules.splice(i, 1);
      adapter.schedulesChanged?.();
      return true;
    },
    /** True when this queue runs the job `name` (from `jobs` or `schedules`). */
    hasJob(name: string): boolean {
      return jobs.has(name);
    },
    /** Every job this queue runs. */
    jobs(): JobDef<any>[] {
      return [...jobs.values()];
    },
    /** Stop schedule and delay timers and starting jobs; resolves when running jobs finished. */
    async stop() {
      await adapter.stop?.();
    },
    /** Status, job lists, actions and settings for @miujs/admin. */
    manage() {
      return queueManage({ adapter, jobs, schedules, lastRuns, lastFired, dispatch });
    },
    inspect() {
      return {
        adapter: adapter.name,
        jobs: [...jobs.values()].map((j) => ({ name: j.name, retries: j.retries, backoff: j.backoff, input: j.input.json })),
        schedules: schedules.map((s) => ({ cron: s.cron.source, job: s.job.name, input: s.input })),
        ...adapter.inspect?.(),
      };
    },
    cloudflare(): CloudflareNeeds {
      return adapter.cloudflare?.() ?? {};
    },
  });
}
