import { isSchema, t, type Env, type Infer, type Logger, type Schema } from "miujs";
import type { Mailer } from "./define.ts";
import { workflowErrors } from "./errors.ts";

type MaybePromise<T> = T | Promise<T>;

/** What an action's `run` receives besides its params. */
export interface ActionContext {
  env: Env;
  log: Logger;
  fetch: typeof fetch;
  mailer?: Mailer;
  run: { id: string; workflow: string };
  /** The workflow input (trigger payload). */
  input: unknown;
}

export interface ActionDef<P = any> {
  readonly kind: "miu.workflow.action";
  readonly name: string;
  readonly description?: string;
  readonly params: Schema<P>;
  /** Step retries for this action unless the spec sets `retries`. Default 3. */
  readonly retries: number;
  readonly run: (params: P, ctx: ActionContext) => MaybePromise<unknown>;
}

/**
 * Register an action JSON workflows can call by name:
 *
 * ```ts
 * const updateRecord = defineAction("update_record", {
 *   params: t.object({ id: t.string(), fields: t.record(t.unknown()) }),
 *   run: async ({ id, fields }, { env }) => { ... },
 * });
 * fromJson(spec, { actions: [updateRecord] });
 * ```
 */
export function defineAction<S extends Schema<any>>(
  name: string,
  config: { description?: string; params: S; retries?: number; run: (params: Infer<S>, ctx: ActionContext) => MaybePromise<unknown> },
): ActionDef<Infer<S>> {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
    throw workflowErrors.config(`defineAction needs a name like "update_record", got ${JSON.stringify(name)}`, 'Call defineAction("update_record", { params, run }).');
  }
  if (!isSchema(config?.params)) throw workflowErrors.config(`Action "${name}": params must be a t schema`, "Pass `params: t.object({ ... })`.");
  if (typeof config.run !== "function") throw workflowErrors.config(`Action "${name}": run must be a function`, "Pass `run: async (params, ctx) => { ... }`.");
  const retries = config.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 0) throw workflowErrors.config(`Action "${name}": retries must be a whole number >= 0`, "Pass `retries: 3` (or 0).");
  return { kind: "miu.workflow.action", name, description: config.description, params: config.params, retries, run: config.run };
}

function nonRetryable<E extends Error>(e: E): E {
  return Object.assign(e, { retryable: false });
}

export const httpAction = defineAction("http", {
  description: "Call an HTTP endpoint. 5xx, 408 and 429 are retried; other non-2xx fail the step.",
  params: t.object({
    url: t.string({ format: "url" }),
    method: t.optional(t.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
    headers: t.optional(t.record(t.string())),
    body: t.optional(t.unknown()),
  }),
  run: async (p, ctx) => {
    const headers = new Headers(p.headers);
    let body: string | undefined;
    if (p.body !== undefined && p.body !== null) {
      if (typeof p.body === "string") body = p.body;
      else {
        body = JSON.stringify(p.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    const res = await ctx.fetch(p.url, { method: p.method ?? (body === undefined ? "GET" : "POST"), headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${p.url}: ${text.slice(0, 200)}`);
      throw res.status >= 500 || res.status === 408 || res.status === 429 ? err : nonRetryable(err);
    }
    return { status: res.status, body: parsed };
  },
});

export const sendEmailAction = defineAction("send_email", {
  description: "Send an email through the configured mailer (workflows({ mailer }) or a plugin named mail).",
  params: t.object({
    to: t.union([t.string(), t.array(t.string())]),
    subject: t.string({ minLength: 1 }),
    text: t.optional(t.string()),
    html: t.optional(t.string()),
    from: t.optional(t.string()),
    replyTo: t.optional(t.string()),
  }),
  run: async (p, ctx) => {
    if (!ctx.mailer) throw nonRetryable(workflowErrors.mailer());
    const result = await ctx.mailer.send(p);
    return { sent: true, ...(result && typeof result === "object" ? { result } : {}) };
  },
});

export const logAction = defineAction("log", {
  description: "Write a line to the app log.",
  params: t.object({ message: t.string(), level: t.optional(t.enum(["debug", "info", "warn", "error"])), data: t.optional(t.unknown()) }),
  retries: 0,
  run: (p, ctx) => {
    ctx.log[p.level ?? "info"](p.message, p.data === undefined ? undefined : { data: p.data });
    return null;
  },
});

export const BUILTIN_ACTIONS: readonly ActionDef[] = [httpAction, sendEmailAction, logAction];

/** For builders: every action with its params JSON schema. */
export function describeActions(actions: readonly ActionDef[] = []): { name: string; description?: string; params: unknown }[] {
  const all = new Map<string, ActionDef>();
  for (const a of [...BUILTIN_ACTIONS, ...actions]) all.set(a.name, a);
  return [...all.values()].map((a) => ({ name: a.name, description: a.description, params: a.params.json }));
}
