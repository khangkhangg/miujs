import { createLogger, definePlugin, errors, processEnv, t, targetRuntime, type App, type CloudflareNeeds, type Context, type Env, type Logger } from "miujs";
import { CF_MAX_DELAY, cloudflareQueue, defineJob, memoryQueue, queue, realClock, schedule, type Clock, type QueueAdapter } from "@miujs/queue";
import { describeTrigger, isWorkflow, type Mailer, type WorkflowDef } from "./define.ts";
import { Engine, type EmitResult, type RunView } from "./engine.ts";
import { workflowErrors } from "./errors.ts";
import { workflowMcpTools } from "./mcp.ts";
import { workflowRoutes, type Permissions } from "./routes.ts";
import { memoryRunStore, type RunFilter, type RunRecord, type RunStatus, type RunStore, type TriggerInfo } from "./store.ts";

/** What `ctx.events` offers in a request. */
export interface WorkflowEvents {
  /** Start workflows triggered by `event` and resume runs waiting for it. */
  emit(event: string, data?: unknown, opts?: { idempotencyKey?: string }): Promise<EmitResult>;
}

declare module "miujs" {
  interface Context {
    /** Workflow events from `@miujs/workflows`. */
    events: WorkflowEvents;
  }
  interface Services {
    /** Durable workflows from `@miujs/workflows`: start, emit, getRun, listRuns, cancel, retry, decide. */
    workflows: WorkflowsService;
  }
}

export interface WorkflowsOptions {
  workflows: WorkflowDef<any>[];
  /** Default `memoryRunStore()`. Use `dbRunStore(database)` to survive restarts. */
  store?: RunStore;
  /**
   * Queue backend for resuming runs. Default: `memoryQueue()` on Bun/Deno/Node;
   * `cloudflareQueue({ binding: "WORKFLOWS_QUEUE", queue: "miu-workflows" })` on Workers.
   */
  adapter?: QueueAdapter;
  /** Time source for the engine and the default memory queue. Tests pass `manualClock()`. */
  clock?: Clock;
  /** Longest single queue delay. Longer sleeps are chained. Default: 12h on Cloudflare, unlimited otherwise. */
  maxDelaySeconds?: number;
  /** How long one invocation may hold a run before another may claim it. Default 15 minutes. */
  leaseMs?: number;
  /** Env for work started outside a request (code, cron on Bun). Default: the process env. */
  env?: Env;
  /** fetch for steps and the `http` action. Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Mailer for the `send_email` action. Default: a plugin named "mail" with send(), if any. */
  mailer?: Mailer;
  /** Route prefix. Default "/workflows". */
  prefix?: string;
  /** Permission names checked through `ctx.authorize(perm)` when present. */
  permissions?: Partial<Permissions>;
}

const RESUME_JOB = "miu.workflows.resume";
const CRON_JOB = "miu.workflows.cron";

/**
 * Durable workflows: event, cron, webhook and manual triggers; replayed runs with a step
 * journal; sleeps, waits for events and approvals; routes and MCP tools to drive them.
 *
 * ```ts
 * const wf = workflows({ workflows: [followUp], store: dbRunStore(sqlite("app.db")) });
 * miu({ plugins: [auth(), wf] });
 * ```
 */
export function workflows(opts: WorkflowsOptions) {
  const registry = new Map<string, WorkflowDef<any>>();
  for (const def of opts.workflows ?? []) {
    if (!isWorkflow(def)) throw workflowErrors.config("workflows() got something that is not a workflow", "Pass workflows created with defineWorkflow() or fromJson().");
    if (registry.has(def.name)) throw workflowErrors.duplicateWorkflow(def.name);
    registry.set(def.name, def);
  }
  const clock = opts.clock ?? realClock;
  const store = opts.store ?? memoryRunStore();
  const adapter = opts.adapter ?? (targetRuntime() === "workerd" ? cloudflareQueue({ binding: "WORKFLOWS_QUEUE", queue: "miu-workflows" }) : memoryQueue({ clock }));
  const maxDelaySeconds = opts.maxDelaySeconds ?? (adapter.name === "cloudflare" ? CF_MAX_DELAY : Number.MAX_SAFE_INTEGER);
  const defaultEnv = (): Env => opts.env ?? processEnv();
  let log: Logger = createLogger("info", { plugin: "workflows" });
  let appMailer: Mailer | undefined;
  let appRef: App | undefined;

  const resumeJob = defineJob(RESUME_JOB, {
    input: t.object({ runId: t.string(), token: t.string() }),
    run: ({ input, env }) => engine.resume(input.runId, input.token, env),
  });
  const cronJob = defineJob(CRON_JOB, {
    input: t.object({ workflow: t.string(), cron: t.string() }),
    run: async ({ input, env }) => {
      const def = registry.get(input.workflow);
      const tr = def?.triggers.find((x) => x.type === "cron" && x.cron === input.cron);
      await engine.start(input.workflow, tr && tr.type === "cron" ? (tr.input ?? {}) : {}, env, { trigger: { type: "cron", cron: input.cron } });
    },
  });
  const schedules = [...registry.values()].flatMap((def) =>
    def.triggers.flatMap((tr) => (tr.type === "cron" ? [schedule(tr.cron, cronJob, { workflow: def.name, cron: tr.cron })] : [])),
  );
  const q = queue({ jobs: [resumeJob, cronJob], schedules, adapter });

  const engine: Engine = new Engine({
    workflows: registry,
    store,
    clock,
    maxDelaySeconds,
    leaseMs: opts.leaseMs ?? 15 * 60_000,
    dispatch: async (msg, delaySeconds, env) => {
      await q.dispatch(resumeJob, msg, delaySeconds > 0 ? { delay: delaySeconds } : undefined, env);
    },
    log: () => log,
    fetch: () => opts.fetch ?? globalThis.fetch,
    mailer: () => opts.mailer ?? appMailer ?? (appRef?.hasService("mail") ? appRef.service<Mailer>("mail") : undefined),
    service: (name) => {
      if (!appRef) {
        throw errors.config("MIU_E_SERVICE_MISSING", `No app to look up the "${name}" service in`, "Add workflows() to miu({ plugins }) and start runs after `await app.ready()`.");
      }
      return appRef.service(name);
    },
  });

  const api = {
    /** Start a run. Input is validated against the workflow's schema. */
    start(workflow: string | WorkflowDef<any>, input: unknown = {}, o: { env?: Env; trigger?: TriggerInfo } = {}): Promise<{ id: string; status: RunStatus }> {
      return engine.start(workflow, input, o.env ?? defaultEnv(), { trigger: o.trigger });
    },
    /** Emit an event: starts event-triggered workflows and resumes matching waiters. */
    emit(event: string, data?: unknown, o: { idempotencyKey?: string; env?: Env } = {}): Promise<EmitResult> {
      return engine.emit(event, data, o.env ?? defaultEnv(), o);
    },
    /** A run with its step timeline. */
    getRun(id: string, env: Env = defaultEnv()): Promise<RunView> {
      return engine.getRun(id, env);
    },
    listRuns(filter: RunFilter = {}, env: Env = defaultEnv()): Promise<RunRecord[]> {
      return engine.listRuns(filter, env);
    },
    cancel(id: string, env: Env = defaultEnv()): Promise<RunRecord> {
      return engine.cancel(id, env);
    },
    /** Resume a failed run from its failed step. */
    retry(id: string, env: Env = defaultEnv()): Promise<RunRecord> {
      return engine.retry(id, env);
    },
    /** Decide a pending approval as `user` (checked against the step's approvers). */
    decide(runId: string, step: string, user: { id: string; roles?: string[]; name?: string; email?: string }, decision: "approve" | "reject", comment?: string, env: Env = defaultEnv()) {
      return engine.decide(runId, step, user, decision, comment, env);
    },
  };

  const permissions: Permissions = { read: "workflows:read", run: "workflows:run", manage: "workflows:manage", emit: "workflows:emit", ...opts.permissions };
  const routes = workflowRoutes({ engine, registry, prefix: opts.prefix ?? "/workflows", permissions });

  return definePlugin({
    name: "workflows",
    routes,
    engine,
    /** The internal queue plugin that resumes runs. */
    queue: q,
    adapter,
    ...api,
    async setup(app: App) {
      log = app.log.child({ plugin: "workflows" });
      appRef = app;
      if (!app.hasService("workflows")) app.provide("workflows", api);
      await q.setup(app);
    },
    onRequest(ctx: Context) {
      ctx.events = { emit: (event, data, o) => engine.emit(event, data, ctx.env, o ?? {}) };
    },
    mcpTools: () => workflowMcpTools({ engine, registry, permissions }),
    /** Stop the queue's timers (schedules and delays). */
    stop() {
      q.stop();
    },
    /** Memory queue only: run everything due, advancing a test clock through delays. */
    async drain() {
      const d = (adapter as { drain?: () => Promise<void> }).drain;
      if (d) await d.call(adapter);
    },
    inspect() {
      return {
        store: store.describe(),
        queue: { adapter: adapter.name, maxDelaySeconds: maxDelaySeconds === Number.MAX_SAFE_INTEGER ? null : maxDelaySeconds },
        workflows: [...registry.values()].map((d) => ({
          name: d.name,
          description: d.description,
          triggers: d.triggers.map(describeTrigger),
          concurrency: d.concurrency ? { limit: d.concurrency.limit } : undefined,
          json: d.spec !== undefined,
          input: d.input.json,
        })),
        actions: [...new Set([...registry.values()].flatMap((d) => d.actions ?? []))],
        routes: routes.map((r) => `${r.method} ${r.path}`),
      };
    },
    cloudflare(): CloudflareNeeds {
      return q.cloudflare();
    },
  });
}

export type WorkflowsPlugin = ReturnType<typeof workflows>;

/** `app.service("workflows")`: start runs and emit events from code outside requests. */
export type WorkflowsService = Pick<WorkflowsPlugin, "start" | "emit" | "getRun" | "listRuns" | "cancel" | "retry" | "decide">;
