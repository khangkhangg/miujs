import type { App, Env } from "miujs";
import type { QueueAdapter, QueueMessage, QueueRuntime } from "./adapter.ts";
import { queueErrors } from "./errors.ts";
import { _setWorkersDefault } from "./plugin.ts";

/** Cloudflare Queues cap `delaySeconds` at 12 hours. */
export const CF_MAX_DELAY = 43_200;

/** The part of a Cloudflare `Queue` producer binding this adapter uses. */
export interface QueueBindingLike {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

/** The part of a Cloudflare `Message` this adapter uses. */
export interface CfMessage {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface CfMessageBatch {
  queue: string;
  messages: readonly CfMessage[];
}

export interface CloudflareQueueOptions {
  /** Producer binding name in wrangler.toml. Default "JOBS". */
  binding?: string;
  /**
   * Queue name this app consumes. When set, batches from other queues are ignored (left for
   * other handlers). Default: handle every batch.
   */
  queue?: string;
}

function isMessage(body: unknown): body is QueueMessage {
  const b = body as QueueMessage | null;
  return typeof b === "object" && b !== null && typeof b.job === "string" && typeof b.id === "string";
}

/**
 * Cloudflare Queues adapter: the default on Workers.
 *
 * - `dispatch` sends `{ id, job, input }` to `env[binding]` (`delay` → `delaySeconds`, max 12h).
 * - The consumer runs each message's job: success → `ack()`; failure → `retry({ delaySeconds })`
 *   using the job's backoff, until its `retries` are used up, then `ack()` and an error log.
 *   Set `max_retries` in wrangler.toml above your largest `retries` so Cloudflare doesn't give up first.
 * - Unknown jobs, invalid input and foreign messages are acked and logged (retrying can't help).
 * - Cron Triggers run the schedules whose cron equals `controller.cron` by dispatching their job.
 */
export function cloudflareQueue(opts: CloudflareQueueOptions = {}): QueueAdapter {
  const binding = opts.binding ?? "JOBS";
  let rt: QueueRuntime | undefined;
  const runtime = () => {
    if (!rt) throw queueErrors.config("cloudflareQueue is not attached to a queue()", "Pass it as `queue({ adapter: cloudflareQueue() })`.");
    return rt;
  };

  const consume = async (batch: CfMessageBatch, env: Env) => {
    if (opts.queue && batch.queue !== opts.queue) return;
    const r = runtime();
    await Promise.all(
      batch.messages.map(async (m) => {
        if (!isMessage(m.body)) {
          r.log.error("queue message is not a MiuJS job; acking it", { messageId: m.id, queue: batch.queue });
          m.ack();
          return;
        }
        const res = await r.run(m.body, m.attempts, env);
        if (res.ok || !res.retry) m.ack();
        else m.retry({ delaySeconds: Math.min(CF_MAX_DELAY, Math.ceil(res.delaySeconds)) });
      }),
    );
  };

  const onCron = async (controller: { cron: string; scheduledTime?: number }, env: Env) => {
    const r = runtime();
    const cron = String(controller.cron).trim().split(/\s+/).join(" ");
    const at = typeof controller.scheduledTime === "number" ? controller.scheduledTime : Date.now();
    for (const s of r.schedules) {
      if (s.cron.source !== cron) continue;
      r.fired?.(s, Math.floor(at / 60_000) * 60_000);
      await r.dispatch(s.job, s.input, undefined, env);
    }
  };

  return {
    name: "cloudflare",
    attach(r) {
      if (rt) throw queueErrors.config("This cloudflareQueue() is already used by another queue()", "Create one cloudflareQueue() per queue() plugin.");
      rt = r;
    },
    async send(msg, o, env) {
      const q = env[binding] as QueueBindingLike | undefined;
      if (!q || typeof q.send !== "function") throw queueErrors.binding(binding);
      if (o.delay !== undefined && o.delay > CF_MAX_DELAY) throw queueErrors.delay(o.delay, CF_MAX_DELAY);
      await q.send(msg, o.delay ? { delaySeconds: Math.ceil(o.delay) } : undefined);
    },
    setup(app: App) {
      app.on("queue", (batch: CfMessageBatch, env: Env) => consume(batch, env));
      app.on("scheduled", (controller: { cron: string; scheduledTime?: number }, env: Env) => onCron(controller, env));
    },
    inspect: () => ({ binding, ...(opts.queue ? { queue: opts.queue } : {}) }),
    cloudflare() {
      const crons = [...new Set(runtime().schedules.map((s) => s.cron.source))];
      return { queues: { producers: [binding], consumers: [binding] }, ...(crons.length ? { crons } : {}) };
    },
  };
}

_setWorkersDefault(() => cloudflareQueue());
