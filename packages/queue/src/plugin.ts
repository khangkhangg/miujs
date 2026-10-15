import { createLogger, definePlugin, targetRuntime, isMiuError, type App, type CloudflareNeeds, type Context, type Env, type Logger } from "miujs";
import type { QueueAdapter, QueueMessage, QueueRuntime, RunResult } from "./adapter.ts";
import { queueErrors } from "./errors.ts";
import { backoffSeconds, checkInput, type Dispatch, type DispatchOptions, type JobDef, type JobInput, type Schedule } from "./job.ts";
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
  const schedules = opts.schedules ?? [];
  const jobs = new Map<string, JobDef<any>>();
  for (const job of [...(opts.jobs ?? []), ...schedules.map((s) => s.job)]) {
    const prev = jobs.get(job.name);
    if (prev && prev !== job) throw queueErrors.duplicateJob(job.name);
    jobs.set(job.name, job);
  }
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

  const run = async (msg: QueueMessage, attempt: number, env: Env): Promise<RunResult> => {
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
      ctx.queue = { dispatch: dispatcherFor(ctx.env) };
    },
    /** Dispatch outside a request (scripts, tests). `env` defaults to the process env. */
    dispatch<J extends JobDef<any>>(job: J, input: JobInput<J>, o?: DispatchOptions, env: Env = processEnv()): Promise<{ id: string }> {
      return dispatch(job, input, o, env);
    },
    /** True when this queue runs the job `name` (from `jobs` or `schedules`). */
    hasJob(name: string): boolean {
      return jobs.has(name);
    },
    /** Every job this queue runs. */
    jobs(): JobDef<any>[] {
      return [...jobs.values()];
    },
    /** Stop schedule and delay timers. */
    stop() {
      adapter.stop?.();
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
