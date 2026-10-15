// Run a code-defined workflow on Cloudflare Workflows (durable execution by the platform)
// instead of the queue-based engine. Steps map 1:1 onto Cloudflare's WorkflowStep.

import { createLogger, detectRuntime, errors, validate, type Env, type Runtime } from "miujs";
import { normalizeApprovers, type Mailer, type Step, type StepRunOptions, type WorkflowDef, type WorkflowEvent } from "./define.ts";
import { parseDuration } from "./duration.ts";
import { workflowErrors } from "./errors.ts";
import { matches } from "./engine.ts";

/** The part of Cloudflare's `WorkflowStep` this adapter uses. */
export interface CfWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: CfStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number | string): Promise<void>;
  sleepUntil(name: string, until: Date | number): Promise<void>;
  waitForEvent<T = unknown>(name: string, opts: { type: string; timeout?: number | string }): Promise<{ payload: T; timestamp: Date; type: string }>;
}

export interface CfStepConfig {
  retries?: { limit: number; delay: number | string; backoff?: "constant" | "linear" | "exponential" };
  timeout?: number | string;
}

/** The part of Cloudflare's `WorkflowEvent` this adapter uses. */
export interface CfWorkflowEvent<P = unknown> {
  payload: P;
  timestamp: Date;
  instanceId: string;
}

type EntrypointBase = new (ctx: any, env: any) => { env?: unknown };

/** Same shape as `WorkflowEntrypoint` from "cloudflare:workers", for tests and non-Workers code. */
export class WorkflowEntrypointShape {
  ctx: unknown;
  env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The Workers built-in module; a variable, so bundlers for other runtimes never try to resolve it. */
const CF_WORKERS = "cloudflare:workers";

/**
 * `WorkflowEntrypoint` from "cloudflare:workers" when running on workerd, else undefined. workerd
 * only runs Workflow classes that extend it ("worker is not an actor" otherwise).
 */
export async function workersEntrypoint(runtime: Runtime = detectRuntime(), load: (spec: string) => Promise<unknown> = (spec) => import(spec)): Promise<EntrypointBase | undefined> {
  if (runtime !== "workerd") return undefined;
  try {
    const mod = (await load(CF_WORKERS)) as { WorkflowEntrypoint?: EntrypointBase };
    return typeof mod?.WorkflowEntrypoint === "function" ? mod.WorkflowEntrypoint : undefined;
  } catch {
    return undefined;
  }
}

// Loaded once, before any createCloudflareWorkflow() call at the top of a Worker's entry module.
const workersBase = await workersEntrypoint();

/** The class a Cloudflare Workflow extends: `base` if given; on workerd WorkflowEntrypoint; elsewhere the shape. */
export function entrypointBase(base: EntrypointBase | undefined, runtime: Runtime, workers: EntrypointBase | undefined, workflow = "workflow"): EntrypointBase {
  if (base) return base;
  if (runtime !== "workerd") return WorkflowEntrypointShape;
  if (workers) return workers;
  throw workflowErrors.config(
    `createCloudflareWorkflow("${workflow}") could not load WorkflowEntrypoint from "cloudflare:workers"; workerd would refuse the class ("worker is not an actor")`,
    'Pass the base class: import { WorkflowEntrypoint } from "cloudflare:workers"; createCloudflareWorkflow(def, { base: WorkflowEntrypoint }).',
  );
}

export interface CloudflareWorkflowOptions<B extends EntrypointBase> {
  /**
   * The class to extend. Default: `WorkflowEntrypoint` from "cloudflare:workers" on Workers, a
   * stand-in with the same shape elsewhere (tests, Bun, Node).
   */
  base?: B;
  mailer?: Mailer;
  fetch?: typeof fetch;
  /** Services for `ctx.service(name)` (there is no app inside a Cloudflare Workflow instance). */
  services?: Record<string, unknown>;
  /** Most non-matching events skipped per waitForEvent before giving up with null. Default 100. */
  maxEventSkips?: number;
}

/** Cloudflare event types allow letters, digits, "_" and "-": map other characters to "_". */
export function cfEventType(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function retryConfig(o: StepRunOptions | undefined): CfStepConfig {
  const limit = o?.retries ?? 3;
  const b = o?.backoff ?? "exponential";
  if (typeof b === "number") return { retries: { limit, delay: b * 1000, backoff: "constant" } };
  return { retries: { limit, delay: 5000, backoff: "exponential" } };
}

/**
 * A class for Cloudflare Workflows that runs `def`:
 *
 * ```ts
 * export const FollowUp = createCloudflareWorkflow(followUp);
 * // wrangler: [[workflows]] name = "contact-follow-up" binding = "FOLLOW_UP" class_name = "FollowUp"
 * ```
 *
 * On Workers the class extends `WorkflowEntrypoint` from "cloudflare:workers" (loaded for you);
 * pass `{ base: WorkflowEntrypoint }` to choose the base class yourself.
 *
 * Mapping: step.run → step.do (retries/backoff → retry config), step.sleep → step.sleep,
 * step.waitForEvent → step.waitForEvent (type = event name, `match` checked here; non-matching
 * events are skipped), step.now/uuid → step.do. waitForApproval waits for type
 * `approval-<step>`: send it with instance.sendEvent() after checking the approver yourself.
 */
export function createCloudflareWorkflow<B extends EntrypointBase = typeof WorkflowEntrypointShape>(def: WorkflowDef<any>, opts: CloudflareWorkflowOptions<B> = {}) {
  const Base = entrypointBase(opts.base, detectRuntime(), workersBase, def.name);
  const maxSkips = opts.maxEventSkips ?? 100;

  class MiuWorkflow extends Base {
    declare env: Env;
    async run(event: CfWorkflowEvent, cf: CfWorkflowStep): Promise<any> {
      const checked = validate(def.input, event.payload ?? {});
      if (!checked.ok) throw workflowErrors.input(def.name, checked.issues);
      const seen = new Set<string>();
      const claim = (name: string) => {
        if (seen.has(name)) throw workflowErrors.duplicateStep(def.name, name);
        seen.add(name);
      };
      let autoNow = 0;
      let autoUuid = 0;

      const wait = async (name: string, type: string, eventName: string, match: Record<string, unknown> | undefined, timeout: unknown): Promise<WorkflowEvent | null> => {
        claim(name);
        const t = timeout === undefined ? undefined : parseDuration(timeout as string);
        for (let i = 0; i <= maxSkips; i++) {
          let got: { payload: unknown; timestamp: Date };
          try {
            got = await cf.waitForEvent(i ? `${name}#${i}` : name, t === undefined ? { type } : { type, timeout: t });
          } catch {
            return null; // Cloudflare throws when the wait times out.
          }
          const evt: WorkflowEvent = { id: `${event.instanceId}:${name}#${i}`, name: eventName, data: got.payload, ts: new Date(got.timestamp).getTime() };
          if (matches(match, evt)) return evt;
        }
        return null;
      };

      const step: Step = {
        run: async (name, fn, o) => {
          claim(name);
          return cf.do(name, retryConfig(o), async () => (await fn()) as any);
        },
        sleep: async (name, duration) => {
          claim(name);
          await cf.sleep(name, parseDuration(duration));
        },
        sleepUntil: async (name, until) => {
          claim(name);
          await cf.sleepUntil(name, until);
        },
        waitForEvent: (name, o) => wait(name, cfEventType(o.event), o.event, o.match, o.timeout) as Promise<any>,
        waitForApproval: async (name, o) => {
          normalizeApprovers(o.approvers);
          const e = await wait(name, cfEventType(`approval-${name}`), `approval-${name}`, undefined, o.timeout);
          return (e?.data ?? null) as any;
        },
        now: async (name) => {
          const n = name ?? `now#${++autoNow}`;
          claim(n);
          return cf.do(n, async () => Date.now());
        },
        uuid: async (name) => {
          const n = name ?? `uuid#${++autoUuid}`;
          claim(n);
          return cf.do(n, async () => crypto.randomUUID());
        },
      };

      return def.run({
        input: checked.value,
        step,
        log: createLogger("info", { workflow: def.name, instanceId: event.instanceId }),
        env: this.env ?? {},
        run: { id: event.instanceId, workflow: def.name, trigger: { type: "manual" } },
        fetch: opts.fetch ?? globalThis.fetch,
        mailer: opts.mailer,
        service: <T,>(name: string): T => {
          if (!opts.services || !Object.prototype.hasOwnProperty.call(opts.services, name)) {
            throw errors.config("MIU_E_SERVICE_MISSING", `No "${name}" service in this Cloudflare Workflow`, `Pass createCloudflareWorkflow(def, { services: { ${name}: ... } }).`);
          }
          return opts.services[name] as T;
        },
      });
    }
  }
  Object.defineProperty(MiuWorkflow, "name", { value: `MiuWorkflow_${def.name.replace(/[^A-Za-z0-9_]/g, "_")}` });
  return MiuWorkflow as unknown as new (ctx: any, env: any) => InstanceType<B> & { env: Env; run(event: CfWorkflowEvent, step: CfWorkflowStep): Promise<any> };
}
