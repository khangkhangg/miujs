import type { App, CloudflareNeeds, Env, Logger } from "miujs";
import type { DispatchOptions, JobDef, Schedule } from "./job.ts";
import type { DeadLetter } from "./memory.ts";

/** What travels through a queue backend. Must stay JSON-serializable. */
export interface QueueMessage {
  id: string;
  job: string;
  input: unknown;
}

export type RunResult =
  | { ok: true }
  | {
      ok: false;
      error: unknown;
      /** True when another attempt should be made after `delaySeconds`. */
      retry: boolean;
      delaySeconds: number;
    };

/** Given to adapters by `queue()`: the registered jobs and how to run them. */
export interface QueueRuntime {
  readonly jobs: ReadonlyMap<string, JobDef<any>>;
  readonly schedules: readonly Schedule<any>[];
  readonly log: Logger;
  /** Env for work that doesn't come from a request (schedules on Bun/Deno/Node). */
  defaultEnv(): Env;
  /** Run one attempt: validates input, runs the job, logs, and says whether to retry. Never throws. */
  run(msg: QueueMessage, attempt: number, env: Env): Promise<RunResult>;
  dispatch(job: JobDef<any>, input: unknown, opts: DispatchOptions | undefined, env: Env): Promise<{ id: string }>;
  /** A schedule fired for `minute` (ms) in this instance. Adapters call it when they dispatch one. */
  fired?(s: Schedule<any>, minute: number): void;
}

/** Where a message waits: due now, waiting for a delay or backoff, or leased by a worker. */
export type JobState = "pending" | "delayed" | "running";
export const JOB_STATES: readonly JobState[] = ["pending", "delayed", "running"];

/** One queued message, as the admin lists it. */
export interface JobRow {
  id: string;
  job: string;
  input: unknown;
  state: JobState;
  attempt: number;
  /** When it is due (ms); null while running. */
  runAt: number | null;
}

/** Message counts. Cheap: adapters count with an index or a length, never by loading messages. */
export interface QueueStats {
  /** Ready to run now. */
  pending: number;
  /** Waiting for a delay or retry backoff. */
  delayed: number;
  /** Leased by a worker (this one or another). */
  inflight: number;
  deadLetters: number;
}

/**
 * What an adapter offers operators through `queue().manage()` (rendered by @miujs/admin). All
 * optional: the admin shows only what the adapter supports. Lists page by offset; callers cap it.
 */
export interface QueueManagement {
  stats?(env: Env): Promise<QueueStats>;
  /** Messages in `state`, the next due first. */
  listJobs?(state: JobState, offset: number, limit: number, env: Env): Promise<JobRow[]>;
  /** Dead letters, newest first. */
  listDead?(offset: number, limit: number, env: Env): Promise<DeadLetter[]>;
  /** Remove a dead letter and queue its message again as attempt 1. False when there was none. */
  retryDead?(id: string, env: Env): Promise<boolean>;
  /** Forget a dead letter. False when there was none. */
  deleteDead?(id: string, env: Env): Promise<boolean>;
  /** Stop starting jobs in this process (messages are still accepted), and start again. */
  pause?(): void;
  resume?(): void;
  isPaused?(): boolean;
  getConcurrency?(): number;
  /** Change how many jobs this process runs at once, now. */
  setConcurrency?(n: number): void;
  /** The adapter's clock in ms (a test clock in tests). */
  now?(): number;
}

/** A queue backend: in-process memory, Cloudflare Queues, ... */
export interface QueueAdapter extends QueueManagement {
  readonly name: string;
  /** Called once by `queue()`. */
  attach(rt: QueueRuntime): void;
  /** Enqueue a validated message. `delay` is in seconds. */
  send(msg: QueueMessage, opts: { delay?: number }, env: Env): Promise<void>;
  /** Called from the plugin's `setup` (start workers, register Workers handlers). */
  setup?(app: App): void | Promise<void>;
  /** Stop timers. */
  stop?(): void;
  /** Remove a message that has not started yet (delayed, or waiting its turn). False when there was none. */
  cancel?(id: string, env: Env): Promise<boolean>;
  /** `QueueRuntime.schedules` gained or lost entries: start or stop the minute scheduler. */
  schedulesChanged?(): void;
  inspect?(): Record<string, unknown>;
  cloudflare?(): CloudflareNeeds;
}
