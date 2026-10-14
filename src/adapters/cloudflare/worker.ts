import type { ExecutionContext } from "../../core/context.ts";
import type { MessageBatch, ScheduledController } from "./types.ts";

/** A holder for the Worker's `env`, filled on each invocation by {@link toWorker}. */
export interface WorkerEnv<B> {
  /** The env of the latest invocation. Throws if read before the first request. */
  readonly current: B;
  set(env: B): void;
}

/**
 * Module-scope access to bindings: pass it to `toWorker({ env })`, then build stores
 * with getters such as `kvStore(() => env.current.CACHE)`. `env` is the same object for
 * every request in an isolate, so this is safe. (On recent runtimes,
 * `import { env } from "cloudflare:workers"` works too.)
 */
export function workerEnv<B = Record<string, unknown>>(): WorkerEnv<B> {
  let value: B | undefined;
  let isSet = false;
  return {
    get current(): B {
      if (!isSet) throw new Error("Worker env read before the first request; access it inside handlers");
      return value as B;
    },
    set(env) {
      value = env;
      isSet = true;
    },
  };
}

export interface WorkerHandler<B> {
  fetch(request: Request, env: B, ctx: ExecutionContext): Promise<Response>;
  queue?(batch: MessageBatch<any>, env: B, ctx: ExecutionContext): Promise<void>;
  scheduled?(controller: ScheduledController, env: B, ctx: ExecutionContext): Promise<void>;
}

export interface ToWorkerOptions<B> {
  /** Records `env` on every invocation. */
  env?: WorkerEnv<B>;
  /** Queue consumer, e.g. `queueConsumer(jobs)`. */
  queue?: (batch: MessageBatch<any>, env: B, ctx: ExecutionContext) => Promise<void>;
  /** Cron trigger handler. */
  scheduled?: (controller: ScheduledController, env: B, ctx: ExecutionContext) => Promise<void>;
}

/** Build an `ExportedHandler` (`export default toWorker(app, {...})`) from a Miu app plus optional queue/cron handlers. */
export function toWorker<B = any>(
  app: { fetch(req: Request, env?: any, ctx?: ExecutionContext): Promise<Response> },
  opts: ToWorkerOptions<B> = {},
): WorkerHandler<B> {
  const worker: WorkerHandler<B> = {
    fetch(request, env, ctx) {
      opts.env?.set(env);
      return app.fetch(request, env, ctx);
    },
  };
  const { queue, scheduled } = opts;
  if (queue) {
    worker.queue = (batch, env, ctx) => {
      opts.env?.set(env);
      return queue(batch, env, ctx);
    };
  }
  if (scheduled) {
    worker.scheduled = (controller, env, ctx) => {
      opts.env?.set(env);
      return scheduled(controller, env, ctx);
    };
  }
  return worker;
}
