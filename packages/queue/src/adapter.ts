import type { App, CloudflareNeeds, Env, Logger } from "miujs";
import type { DispatchOptions, JobDef, Schedule } from "./job.ts";

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
}

/** A queue backend: in-process memory, Cloudflare Queues, ... */
export interface QueueAdapter {
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
