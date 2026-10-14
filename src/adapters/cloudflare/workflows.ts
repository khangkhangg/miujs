import { ValidationError } from "../../core/errors.ts";
import { validate, type AnySchema, type Infer } from "../../core/schema.ts";
import type { Workflow, WorkflowEvent, WorkflowInstance, WorkflowStep } from "./types.ts";

export interface MiuWorkflow<P, R> {
  /** The env binding name of the workflow (from wrangler.toml `[[workflows]] binding`). */
  readonly binding: string;
  readonly schema: AnySchema;
  /** Validate `params` and start an instance via `env[binding].create({ id, params })`. */
  create(env: object, params: P, opts?: { id?: string }): Promise<WorkflowInstance>;
  /** Look up an existing instance. */
  get(env: object, id: string): Promise<WorkflowInstance>;
  /** Validate the event payload, then run the workflow body. Call it from your entrypoint's `run`. */
  run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<R>;
}

/**
 * Typed, validated Cloudflare Workflow. The entrypoint class itself must extend
 * `WorkflowEntrypoint` from `cloudflare:workers`, which Miu does not import; delegate to `run`:
 *
 * ```ts
 * import { WorkflowEntrypoint } from "cloudflare:workers";
 * export const signup = defineWorkflow("SIGNUP", t.object({ email: t.string() }), async (event, step) => {
 *   await step.do("send welcome", () => sendEmail(event.payload.email));
 * });
 * export class SignupWorkflow extends WorkflowEntrypoint {
 *   run(event, step) { return signup.run(event, step); }
 * }
 * // in a route: await signup.create(c.env, { email });
 * ```
 */
export function defineWorkflow<S extends AnySchema, R>(
  binding: string,
  schema: S,
  run: (event: WorkflowEvent<Infer<S>>, step: WorkflowStep) => Promise<R>,
): MiuWorkflow<Infer<S>, R> {
  const check = async (value: unknown): Promise<Infer<S>> => {
    const r = await validate(schema, value);
    if (!r.ok) throw new ValidationError(r.issues);
    return r.value as Infer<S>;
  };
  const wf = (env: object): Workflow<Infer<S>> => {
    const b = (env as Record<string, Workflow<Infer<S>> | undefined>)[binding];
    if (!b || typeof b.create !== "function") throw new Error(`Workflow binding "${binding}" is not configured`);
    return b;
  };
  return {
    binding,
    schema,
    async create(env, params, opts = {}) {
      const b = wf(env);
      const valid = await check(params);
      return b.create(opts.id === undefined ? { params: valid } : { id: opts.id, params: valid });
    },
    get: async (env, id) => wf(env).get(id),
    async run(event, step) {
      const payload = await check(event.payload);
      return run({ ...event, payload }, step);
    },
  };
}
