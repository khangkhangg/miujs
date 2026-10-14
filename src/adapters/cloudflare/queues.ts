import { ValidationError } from "../../core/errors.ts";
import { validate } from "../../core/schema.ts";
import type { ExecutionContext } from "../../core/context.ts";
import type { Job } from "../../batteries/queue/types.ts";
import type { Queue, QueueEvent, ResolvedDefinition } from "../../batteries/queue/queue.ts";
import { resolveBinding, type BindingRef, type MessageBatch, type QueueProducer } from "./types.ts";

/**
 * Cloudflare Queues push messages to a consumer instead of letting workers claim
 * jobs, so rather than a `QueueDriver` Miu offers a producer and a consumer that
 * share the job definitions of an ordinary Miu `Queue`:
 *
 * ```ts
 * const jobs = createQueue({ driver: memoryQueueDriver() }); // only holds definitions here
 * jobs.define("email", { schema, handler, retries: 3 });
 * await cloudflareQueue(jobs, env.JOBS).dispatch("email", { to });   // producer
 * export default toWorker(app, { queue: queueConsumer(jobs) });       // consumer
 * ```
 *
 * Keep `max_retries` in wrangler.toml at least the job's `retries`: Miu acks a message
 * once its retries are exhausted (reporting a `failed` event), and Cloudflare drops
 * or dead-letters it earlier if `max_retries` is lower. Dedupe keys are not supported.
 */

/** Message body sent to the Cloudflare queue. */
export interface CloudflareJobMessage<P = unknown> {
  id: string;
  name: string;
  payload: P;
}

/** Cloudflare Queues reject delays above 12 hours. */
export const MAX_DELAY_SECONDS = 43_200;

type Definitions = Pick<Queue, "definition">;

export interface CloudflareQueue {
  /** Validate (when the job is defined) and send; resolves to the generated job id. `delay` is in seconds. */
  dispatch(name: string, payload: unknown, opts?: { delay?: number }): Promise<string>;
}

/** Producer: dispatch Miu jobs onto a Cloudflare Queue binding (or a getter like `() => env.JOBS`). */
export function cloudflareQueue(queue: Definitions, binding: BindingRef<QueueProducer<CloudflareJobMessage>>): CloudflareQueue {
  return {
    async dispatch(name, payload, opts = {}) {
      const schema = queue.definition(name)?.schema;
      if (schema) {
        const r = await validate(schema, payload);
        if (!r.ok) throw new ValidationError(r.issues);
        payload = r.value;
      }
      const id = crypto.randomUUID();
      const options: { delaySeconds?: number } = {};
      if (opts.delay) options.delaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(opts.delay)));
      await resolveBinding(binding).send({ id, name, payload }, options);
      return id;
    },
  };
}

export interface QueueConsumerOptions {
  /** Called on `completed`, `retry` and `failed`, like `createQueue({ onEvent })`. */
  onEvent?: (event: QueueEvent) => void;
}

export type QueueHandler = (batch: MessageBatch<CloudflareJobMessage>, env: unknown, ctx: ExecutionContext) => Promise<void>;

const errorMessage = (e: unknown) =>
  e instanceof ValidationError ? `Invalid payload: ${JSON.stringify(e.issues)}` : e instanceof Error ? e.message : String(e);

async function invoke(def: ResolvedDefinition, payload: unknown, job: Job): Promise<void> {
  const ac = new AbortController();
  const run = Promise.resolve().then(() => def.handler(payload, { ...job, payload, signal: ac.signal }));
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
}

/**
 * Consumer: a `queue(batch, env, ctx)` handler running each message's job handler
 * (messages in a batch run concurrently). Success acks; a failure retries with the
 * job's backoff (rounded up to whole seconds, using `message.attempts`) until its
 * retries are exhausted, then acks. Unknown jobs, malformed bodies and invalid
 * payloads fail permanently.
 */
export function queueConsumer(queue: Definitions, opts: QueueConsumerOptions = {}): QueueHandler {
  const emit = (event: QueueEvent) => {
    try {
      opts.onEvent?.(event);
    } catch {
      // a broken listener must not break the consumer
    }
  };

  return async (batch) => {
    await Promise.all(
      batch.messages.map(async (msg) => {
        const body = msg.body as Partial<CloudflareJobMessage> | null;
        const ts = msg.timestamp.getTime();
        const job: Job = {
          id: typeof body?.id === "string" ? body.id : msg.id,
          name: typeof body?.name === "string" ? body.name : "",
          payload: body?.payload,
          status: "running",
          attempts: msg.attempts,
          runAt: ts,
          createdAt: ts,
        };
        const fail = (error: string) => {
          msg.ack();
          emit({ type: "failed", job: { ...job, status: "failed", lastError: error }, error });
        };
        if (!body || typeof body !== "object" || !job.name) return fail("Malformed queue message");
        const def = queue.definition(job.name);
        if (!def) return fail(`No handler defined for job "${job.name}"`);

        let payload = job.payload;
        if (def.schema) {
          const r = await validate(def.schema, payload);
          if (!r.ok) return fail(errorMessage(new ValidationError(r.issues)));
          payload = r.value;
        }
        try {
          await invoke(def, payload, job);
        } catch (e) {
          const error = errorMessage(e);
          if (msg.attempts <= def.retries) {
            const delaySeconds = Math.min(MAX_DELAY_SECONDS, Math.ceil(def.backoff(msg.attempts) / 1000));
            msg.retry({ delaySeconds });
            emit({ type: "retry", job: { ...job, status: "pending", lastError: error }, error });
          } else {
            fail(error);
          }
          return;
        }
        msg.ack();
        emit({ type: "completed", job: { ...job, status: "completed" } });
      }),
    );
  };
}
