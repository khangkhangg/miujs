import { isSchema, t, type Env, type Infer, type Logger, type Schema } from "miujs";
import { parseCron, type Backoff } from "@miujs/queue";
import type { Duration } from "./duration.ts";
import { workflowErrors } from "./errors.ts";
import type { Approvers, TriggerInfo } from "./store.ts";

type MaybePromise<T> = T | Promise<T>;

/** An event as workflows see it (trigger payloads and `waitForEvent` results). */
export interface WorkflowEvent<D = unknown> {
  id: string;
  name: string;
  data: D;
  /** Emit time (ms). */
  ts: number;
}

export interface EventTrigger {
  type: "event";
  event: string;
  /** Dotted paths into the event (`{ "data.stage": "won" }`) that must equal these values. */
  match?: Record<string, unknown>;
  /** Map the event to the workflow input. Default: `event.data`. */
  input?: (event: WorkflowEvent) => unknown;
}
export interface CronTrigger {
  type: "cron";
  cron: string;
  input?: unknown;
}
export interface WebhookTrigger {
  type: "webhook";
  path: string;
  /** HMAC-SHA256 secret, or a function reading it from env. No secret: unsigned requests are accepted. */
  secret?: string | ((env: Env) => string | undefined);
  /** Header carrying the hex signature. Default "x-signature". */
  header?: string;
  /**
   * Replay protection (needs `secret`): seconds a signed request stays valid. The sender puts
   * the unix time (seconds) in `timestampHeader` and signs `${timestamp}.${body}`; older or
   * newer requests are refused. Default: off (the signature covers only the body).
   */
  tolerance?: number;
  /** Header carrying the unix timestamp for `tolerance`. Default "x-signature-timestamp". */
  timestampHeader?: string;
  /** Largest request body accepted, in bytes. Default 1 MiB. */
  maxBodySize?: number;
  /** Map the parsed JSON body to the workflow input. Default: the body. */
  input?: (body: unknown, req: Request) => unknown;
}
export interface ManualTrigger {
  type: "manual";
}
export type Trigger = EventTrigger | CronTrigger | WebhookTrigger | ManualTrigger;

/** Start when `event` is emitted (`workflows.emit` / `ctx.events.emit`). */
export function on(event: string, opts: Omit<EventTrigger, "type" | "event"> = {}): EventTrigger {
  if (typeof event !== "string" || event === "") {
    throw workflowErrors.config(`on() needs an event name, got ${JSON.stringify(event)}`, 'Call on("contact.created").');
  }
  return { type: "event", event, ...opts };
}

/** Start on a 5-field UTC cron schedule. */
export function cron(expr: string, opts: { input?: unknown } = {}): CronTrigger {
  return { type: "cron", cron: parseCron(expr).source, ...opts };
}

/** Start from `POST <path>`, optionally checking an HMAC signature. */
export function webhook(path: string, opts: Omit<WebhookTrigger, "type" | "path"> = {}): WebhookTrigger {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw workflowErrors.config(`webhook() needs a path starting with "/", got ${JSON.stringify(path)}`, 'Call webhook("/hooks/form").');
  }
  if (opts.tolerance !== undefined && (!Number.isInteger(opts.tolerance) || opts.tolerance < 1 || opts.secret === undefined)) {
    throw workflowErrors.config(`webhook(${JSON.stringify(path)}): tolerance must be a whole number of seconds >= 1, with a secret`, `Call webhook("${path}", { secret: (env) => env.HOOK_SECRET, tolerance: 300 }).`);
  }
  if (opts.maxBodySize !== undefined && (!Number.isInteger(opts.maxBodySize) || opts.maxBodySize < 0)) {
    throw workflowErrors.config(`webhook(${JSON.stringify(path)}): maxBodySize must be a whole number of bytes`, "Pass maxBodySize: 1048576 (1 MiB).");
  }
  return { type: "webhook", path, ...opts };
}

/** Only started from code, the API or MCP. (Every workflow can be started manually.) */
export function manual(): ManualTrigger {
  return { type: "manual" };
}

export interface StepRunOptions {
  /** Retries after the first failed attempt. Default 3. */
  retries?: number;
  /** Seconds before each retry: a number, "exponential" (5s, 10s, 20s ... 1h) or a function of the attempt. Default "exponential". */
  backoff?: Backoff | ((attempt: number) => number);
}

export interface WaitForEventOptions {
  event: string;
  /** Dotted paths into the event (`{ "data.contactId": id }`) that must equal these values. */
  match?: Record<string, unknown>;
  /** Resume with `null` after this long. Default: wait forever. */
  timeout?: Duration;
}

export interface ApprovalOptions {
  /** Who may decide: users with one of these roles, or these user ids. */
  approvers: { role?: string | string[]; users?: string[] };
  timeout?: Duration;
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  comment?: string;
  by: { id: string; name?: string; email?: string };
  at: number;
}

/** The durable step API given to `run`. Every step name must be unique within a run. */
export interface Step {
  /** Run `fn` once; its JSON result is journaled and returned on every replay. Retried on throw. */
  run<T>(name: string, fn: () => MaybePromise<T>, opts?: StepRunOptions): Promise<Awaited<T>>;
  /** Pause the run durably. */
  sleep(name: string, duration: Duration): Promise<void>;
  /** Pause until a time (ms or Date). */
  sleepUntil(name: string, until: number | Date): Promise<void>;
  /** Park the run until a matching event arrives; `null` on timeout. */
  waitForEvent<D = unknown>(name: string, opts: WaitForEventOptions): Promise<WorkflowEvent<D> | null>;
  /** Park the run until an approver decides via `POST /workflows/approvals/:runId/:step`; `null` on timeout. */
  waitForApproval(name: string, opts: ApprovalOptions): Promise<ApprovalDecision | null>;
  /** The current time (ms), journaled so replays see the same value. */
  now(name?: string): Promise<number>;
  /** A random UUID, journaled so replays see the same value. */
  uuid(name?: string): Promise<string>;
}

/** An email to send. Same shape as @miujs/mail messages. */
export interface WorkflowMail {
  to: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  template?: string;
  data?: unknown;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** Something with `send(msg)`, e.g. the @miujs/mail client. */
export interface Mailer {
  send(msg: WorkflowMail): MaybePromise<unknown>;
}

export interface WorkflowContext<I> {
  input: I;
  step: Step;
  log: Logger;
  env: Env;
  run: { id: string; workflow: string; trigger: TriggerInfo };
  /** Injectable fetch (workflows({ fetch })), defaults to globalThis.fetch. */
  fetch: typeof fetch;
  /** The configured mailer, if any. */
  mailer?: Mailer;
  /** A service another plugin provided (`app.provide`), e.g. `service("admin")`. Throws MIU_E_SERVICE_MISSING. */
  service<T = unknown>(name: string): T;
}

export interface WorkflowConfig<S extends Schema<any>> {
  description?: string;
  trigger?: Trigger | Trigger[];
  input?: S;
  /** At most `limit` active runs (queued-and-dispatched, running, sleeping or waiting) per key. */
  concurrency?: { key: (input: Infer<S>) => string; limit?: number };
  run: (ctx: WorkflowContext<Infer<S>>) => MaybePromise<unknown>;
}

export interface WorkflowDef<I = unknown> {
  readonly kind: "miu.workflow";
  readonly name: string;
  readonly description?: string;
  readonly triggers: Trigger[];
  readonly input: Schema<I>;
  readonly concurrency?: { key: (input: I) => string; limit: number };
  readonly run: (ctx: WorkflowContext<I>) => MaybePromise<unknown>;
  /** Set by fromJson(): the validated JSON spec. */
  readonly spec?: unknown;
  /** Set by fromJson(): the action names the spec may call. */
  readonly actions?: readonly string[];
}

/**
 * Declare a durable workflow. `run` is replayed from the top on every resume, so code outside
 * `step.*` calls must be deterministic: use `step.now()`/`step.uuid()`, and do side effects in
 * `step.run`.
 */
export function defineWorkflow<S extends Schema<any> = Schema<Record<string, unknown>>>(name: string, config: WorkflowConfig<S>): WorkflowDef<Infer<S>> {
  if (typeof name !== "string" || name === "") {
    throw workflowErrors.config(`defineWorkflow needs a non-empty name, got ${JSON.stringify(name)}`, 'Call defineWorkflow("contact-follow-up", { ... }).');
  }
  if (typeof config?.run !== "function") {
    throw workflowErrors.config(`Workflow "${name}": run must be a function`, "Pass `run: async ({ input, step }) => { ... }`.");
  }
  if (config.input !== undefined && !isSchema(config.input)) {
    throw workflowErrors.config(`Workflow "${name}": input must be a t schema`, "Pass `input: t.object({ ... })`, or leave it out to accept any object.");
  }
  const limit = config.concurrency?.limit ?? 1;
  if (config.concurrency && (typeof config.concurrency.key !== "function" || !Number.isInteger(limit) || limit < 1)) {
    throw workflowErrors.config(`Workflow "${name}": concurrency needs key(input) and a whole-number limit >= 1`, "Pass `concurrency: { key: (input) => input.contactId, limit: 1 }`.");
  }
  const triggers = config.trigger === undefined ? [manual()] : Array.isArray(config.trigger) ? config.trigger : [config.trigger];
  for (const tr of triggers) {
    if (!tr || !["event", "cron", "webhook", "manual"].includes((tr as Trigger).type)) {
      throw workflowErrors.config(`Workflow "${name}": unknown trigger ${JSON.stringify(tr)}`, 'Use on("event"), cron("0 9 * * 1"), webhook("/hooks/x") or manual().');
    }
  }
  return {
    kind: "miu.workflow",
    name,
    description: config.description,
    triggers,
    input: (config.input ?? t.record(t.unknown())) as Schema<Infer<S>>,
    concurrency: config.concurrency ? { key: config.concurrency.key, limit } : undefined,
    run: config.run,
  };
}

export function isWorkflow(v: unknown): v is WorkflowDef {
  return typeof v === "object" && v !== null && (v as WorkflowDef).kind === "miu.workflow";
}

export function normalizeApprovers(a: ApprovalOptions["approvers"]): Approvers {
  const out: Approvers = {};
  if (a?.role !== undefined) out.role = ([] as string[]).concat(a.role);
  if (a?.users !== undefined) out.users = [...a.users];
  if (!out.role?.length && !out.users?.length) {
    throw workflowErrors.config("waitForApproval needs approvers", 'Pass `approvers: { role: "manager" }` or `approvers: { users: ["u1"] }`.');
  }
  return out;
}

/** Plain description of a trigger for inspect / GET /workflows. */
export function describeTrigger(tr: Trigger): Record<string, unknown> {
  switch (tr.type) {
    case "event":
      return { type: "event", event: tr.event, ...(tr.match ? { match: tr.match } : {}) };
    case "cron":
      return { type: "cron", cron: tr.cron };
    case "webhook":
      return { type: "webhook", path: tr.path, signed: tr.secret !== undefined, ...(tr.tolerance !== undefined ? { tolerance: tr.tolerance } : {}) };
    default:
      return { type: "manual" };
  }
}
