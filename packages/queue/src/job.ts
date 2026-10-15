import { isSchema, validate, type Env, type Infer, type Logger, type Schema } from "miujs";
import { parseCron, type Cron } from "./cron.ts";
import { queueErrors } from "./errors.ts";

type MaybePromise<T> = T | Promise<T>;

export interface DispatchOptions {
  /** Seconds to wait before the first attempt. */
  delay?: number;
}

export type Dispatch = <J extends JobDef<any>>(job: J, input: JobInput<J>, opts?: DispatchOptions) => Promise<{ id: string }>;

/** What a job's `run` receives. */
export interface JobContext<I> {
  /** Validated input. */
  input: I;
  /** 1 on the first try, 2 on the first retry, ... */
  attempt: number;
  maxAttempts: number;
  /** Message id (stable across retries). */
  id: string;
  job: string;
  log: Logger;
  /** Env vars (Bun/Deno/Node) or bindings (Workers). */
  env: Env;
  /** Enqueue another job. */
  dispatch: Dispatch;
}

/** Fixed delay in seconds, or doubling from 5s up to 1h. */
export type Backoff = "exponential" | number;

export interface JobConfig<S extends Schema<any>> {
  input: S;
  /** Retries after the first failed attempt. Default 3 (4 attempts in all). */
  retries?: number;
  /** Delay before each retry. Default "exponential" (5s, 10s, 20s, ... up to 1h). */
  backoff?: Backoff;
  run: (ctx: JobContext<Infer<S>>) => MaybePromise<unknown>;
}

export interface JobDef<I = unknown> {
  readonly kind: "miu.job";
  readonly name: string;
  readonly input: Schema<I>;
  readonly retries: number;
  readonly backoff: Backoff;
  readonly maxAttempts: number;
  readonly run: (ctx: JobContext<I>) => MaybePromise<unknown>;
}

export type JobInput<J> = J extends JobDef<infer I> ? I : never;

/**
 * Declare a background job.
 *
 * ```ts
 * export const sendEmail = defineJob("send-email", {
 *   input: t.object({ to: t.string() }),
 *   run: async ({ input, log }) => { ... },
 * });
 * ```
 */
export function defineJob<S extends Schema<any>>(name: string, config: JobConfig<S>): JobDef<Infer<S>> {
  if (typeof name !== "string" || name === "") {
    throw queueErrors.config(`defineJob needs a non-empty name, got ${JSON.stringify(name)}`, 'Call defineJob("send-email", { ... }).');
  }
  const retries = config.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 0) {
    throw queueErrors.config(`Job "${name}": retries must be a whole number >= 0, got ${String(retries)}`, "Pass `retries: 3` (or 0 to never retry).");
  }
  const backoff = config.backoff ?? "exponential";
  if (backoff !== "exponential" && !(typeof backoff === "number" && Number.isFinite(backoff) && backoff >= 0)) {
    throw queueErrors.config(`Job "${name}": backoff must be "exponential" or seconds >= 0, got ${String(backoff)}`, 'Pass `backoff: "exponential"` or a number of seconds, e.g. `backoff: 30`.');
  }
  if (!isSchema(config.input)) {
    throw queueErrors.config(`Job "${name}": input must be a t schema`, "Pass `input: t.object({ ... })` (use t.object({}) for jobs without input).");
  }
  if (typeof config.run !== "function") {
    throw queueErrors.config(`Job "${name}": run must be a function`, "Pass `run: async ({ input }) => { ... }`.");
  }
  return { kind: "miu.job", name, input: config.input, retries, backoff, maxAttempts: retries + 1, run: config.run };
}

export function isJob(v: unknown): v is JobDef {
  return typeof v === "object" && v !== null && (v as JobDef).kind === "miu.job";
}

/** Seconds to wait after failed attempt number `attempt` (1-based). */
export function backoffSeconds(job: Pick<JobDef, "backoff">, attempt: number): number {
  if (typeof job.backoff === "number") return job.backoff;
  return Math.min(3600, 5 * 2 ** (attempt - 1));
}

/** Validates `input` against the job's schema; throws a MIU_E_VALIDATION MiuError. */
export function checkInput<I>(job: JobDef<I>, input: unknown): I {
  const r = validate(job.input, input);
  if (!r.ok) throw queueErrors.input(job.name, r.issues);
  return r.value;
}

export interface Schedule<I = unknown> {
  readonly cron: Cron;
  readonly job: JobDef<I>;
  readonly input: I;
}

/** Run `job` with `input` whenever `cron` matches (5 fields, UTC). Pass to `queue({ schedules })`. */
export function schedule<J extends JobDef<any>>(cron: string, job: J, input?: JobInput<J>): Schedule<JobInput<J>> {
  const parsed = parseCron(cron);
  if (!isJob(job)) throw queueErrors.config(`schedule("${cron}", ...) needs a job from defineJob()`, "Pass a job created with defineJob().");
  return { cron: parsed, job, input: checkInput(job, input ?? {}) };
}
