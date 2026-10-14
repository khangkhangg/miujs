import { ValidationError } from "../../core/errors.ts";
import { validate, type AnySchema, type Infer } from "../../core/schema.ts";
import type { DedupeMode, Job, JobStatus, QueueDriver } from "./types.ts";

/** The job record passed to a handler, plus a signal that aborts when the job times out. */
export type JobContext<P = unknown> = Job<P> & { signal: AbortSignal };

export interface JobDefinition<P> {
  handler: (payload: P, job: JobContext<P>) => unknown;
  /** Attempts after the first. Default 3. */
  retries?: number;
  /** Delay in ms before retry number `attempt` (1-based). Default exponential from 1s, capped at 1h. */
  backoff?: (attempt: number) => number;
  /** Ms a single run may take; exceeding it counts as a failure. */
  timeout?: number;
}

export interface DispatchOptions {
  /** Seconds to wait before the job becomes due. */
  delay?: number;
  /** Dedupe key: while a job with this key is pending, dispatching returns its id instead of adding another. */
  key?: string;
  /**
   * What the dedupe `key` matches. `"pending"` (default): only jobs waiting to run, so dispatching while a
   * job runs queues one follow-up run. `"active"`: pending or running jobs (at most one at a time).
   */
  dedupe?: DedupeMode;
}

export interface JobType<P> {
  readonly name: string;
  /** Enqueue a job; resolves to its id. Throws ValidationError if the payload fails the schema. */
  dispatch(payload: P, opts?: DispatchOptions): Promise<string>;
}

export type QueueEventType = "completed" | "retry" | "failed";

export interface QueueEvent {
  /** `retry`: an attempt failed and the job was rescheduled. `failed`: it will not run again. */
  type: QueueEventType;
  job: Job;
  error?: string;
}

export interface QueueOptions {
  driver: QueueDriver;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
  /** How long a claimed job stays locked before another worker may reclaim it. Default 5 minutes (at least timeout + 1 min). */
  lockTimeout?: number;
  onEvent?: (event: QueueEvent) => void;
}

export interface WorkOptions {
  /** Jobs run in parallel. Default 1. */
  concurrency?: number;
  /** Ms to wait when no job is due. Default 1000. */
  pollInterval?: number;
  /** Stop after in-flight jobs finish once this aborts. */
  signal?: AbortSignal;
}

export interface Queue {
  define<S extends AnySchema>(name: string, def: JobDefinition<Infer<S>> & { schema: S }): JobType<Infer<S>>;
  define<P = unknown>(name: string, def: JobDefinition<P> & { schema?: undefined }): JobType<P>;
  /** Enqueue by name. Validates against the schema when the job is defined in this process. */
  dispatch(name: string, payload: unknown, opts?: DispatchOptions): Promise<string>;
  /** Claim and run due jobs one at a time, at most `max` claims (default 1000). */
  runOnce(opts?: { max?: number }): Promise<{ processed: number; failed: number }>;
  /** The definition registered for `name` (with defaults applied), for external consumers such as Cloudflare Queues. */
  definition(name: string): ResolvedDefinition | undefined;
  /** Poll and run jobs until `signal` aborts; resolves once stopped. */
  work(opts?: WorkOptions): Promise<void>;
  get(id: string): Promise<Job | undefined>;
  list(opts?: { status?: JobStatus; limit?: number }): Promise<Job[]>;
  failed(): Promise<Job[]>;
  /** Move a failed job back to pending with a fresh set of retries. */
  retry(id: string): Promise<boolean>;
  /** Delete completed jobs that finished more than `olderThanMs` ago. */
  prune(olderThanMs: number): Promise<number>;
  /** Subscribe to job events; returns an unsubscribe function. */
  on(type: QueueEventType, fn: (event: QueueEvent) => void): () => void;
  close(): Promise<void>;
}

type AnyDefinition = JobDefinition<unknown> & { schema?: AnySchema };

export interface ResolvedDefinition {
  name: string;
  schema?: AnySchema;
  handler: (payload: any, job: JobContext<any>) => unknown | Promise<unknown>;
  retries: number;
  backoff: (attempt: number) => number;
  timeout?: number;
}

const defaultBackoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 3_600_000);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Create a job queue on top of a driver. */
export function createQueue(opts: QueueOptions): Queue {
  const { driver } = opts;
  const now = opts.now ?? Date.now;
  const lockTimeout = opts.lockTimeout ?? 300_000;
  const defs = new Map<string, AnyDefinition>();
  const listeners = new Set<(e: QueueEvent) => void>();
  if (opts.onEvent) listeners.add(opts.onEvent);

  const emit = (event: QueueEvent) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        // a broken listener must not break the worker
      }
    }
  };

  const lockMs = () => {
    let ms = lockTimeout;
    for (const d of defs.values()) if (d.timeout) ms = Math.max(ms, d.timeout + 60_000);
    return ms;
  };

  const dispatch = async (name: string, payload: unknown, o: DispatchOptions = {}) => {
    const schema = defs.get(name)?.schema;
    if (schema) {
      const r = await validate(schema, payload);
      if (!r.ok) throw new ValidationError(r.issues);
      payload = r.value;
    }
    const t = now();
    const job: Job = {
      id: crypto.randomUUID(),
      name,
      payload,
      status: "pending",
      attempts: 0,
      runAt: t + (o.delay ?? 0) * 1000,
      createdAt: t,
    };
    if (o.key !== undefined) job.key = o.key;
    return (await driver.push(job, o.dedupe && o.dedupe !== "pending" ? { dedupe: o.dedupe } : undefined)).id;
  };

  const invoke = async (def: AnyDefinition, job: Job) => {
    const ac = new AbortController();
    const run = Promise.resolve().then(() => def.handler(job.payload, { ...job, signal: ac.signal }));
    if (!def.timeout) return void (await run);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Job "${job.name}" timed out after ${def.timeout}ms`);
        ac.abort(err);
        reject(err);
      }, def.timeout);
    });
    try {
      await Promise.race([run, timedOut]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /** Run one claimed job to completion; returns false if the attempt failed. */
  const execute = async (job: Job): Promise<boolean> => {
    const def = defs.get(job.name);
    if (!def) {
      const error = `No handler defined for job "${job.name}"`;
      if (await driver.fail(job.id, error, null, now(), job.attempts)) {
        emit({ type: "failed", job: { ...job, status: "failed", lastError: error }, error });
      }
      return false;
    }
    try {
      await invoke(def, job);
    } catch (e) {
      const error = message(e);
      const retries = def.retries ?? 3;
      if (job.attempts <= retries) {
        const runAt = now() + (def.backoff ?? defaultBackoff)(job.attempts);
        // A false return means another worker reclaimed the job after our lock expired: stay silent.
        if (await driver.fail(job.id, error, runAt, now(), job.attempts)) {
          emit({ type: "retry", job: { ...job, status: "pending", runAt, lastError: error }, error });
        }
      } else if (await driver.fail(job.id, error, null, now(), job.attempts)) {
        emit({ type: "failed", job: { ...job, status: "failed", lastError: error }, error });
      }
      return false;
    }
    if (await driver.complete(job.id, now(), job.attempts)) {
      emit({ type: "completed", job: { ...job, status: "completed" } });
    }
    return true;
  };

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done);
    });

  return {
    define(name: string, def: AnyDefinition) {
      defs.set(name, def);
      return { name, dispatch: (payload: unknown, o?: DispatchOptions) => dispatch(name, payload, o) };
    },
    dispatch,
    async runOnce(o = {}) {
      const max = o.max ?? 1000;
      let processed = 0;
      let failed = 0;
      while (processed < max) {
        const job = await driver.claim(now(), lockMs());
        if (!job) break;
        processed++;
        if (!(await execute(job))) failed++;
      }
      return { processed, failed };
    },
    definition(name) {
      const d = defs.get(name);
      if (!d) return undefined;
      return {
        name,
        schema: d.schema,
        handler: d.handler as ResolvedDefinition["handler"],
        retries: d.retries ?? 3,
        backoff: d.backoff ?? defaultBackoff,
        timeout: d.timeout,
      };
    },
    async work(o = {}) {
      const { signal, pollInterval = 1000 } = o;
      const loop = async () => {
        while (!signal?.aborted) {
          let job: Job | undefined;
          try {
            job = await driver.claim(now(), lockMs());
            if (job) await execute(job);
          } catch {
            // driver hiccup (e.g. a busy database): back off and try again
            job = undefined;
          }
          if (!job) await sleep(pollInterval, signal);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 1) }, loop));
    },
    get: (id) => driver.get(id),
    list: (o) => driver.list(o),
    failed: () => driver.list({ status: "failed" }),
    retry: (id) => driver.retry(id, now()),
    prune: (olderThanMs) => driver.prune(now() - olderThanMs),
    on(type, fn) {
      const l = (e: QueueEvent) => {
        if (e.type === type) fn(e);
      };
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    close: () => driver.close(),
  } as Queue;
}
