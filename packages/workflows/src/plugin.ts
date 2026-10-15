import { createLogger, definePlugin, errors, processEnv, t, targetRuntime, type App, type CloudflareNeeds, type Context, type Env, type Logger } from "miujs";
import { CF_MAX_DELAY, cloudflareQueue, defineJob, memoryQueue, parseCron, queue, realClock, schedule, type Clock, type QueueAdapter, type Schedule } from "@miujs/queue";
import { describeTrigger, isWorkflow, type Mailer, type WebhookTrigger, type WorkflowDef } from "./define.ts";
import { Engine, type EmitResult, type RunView } from "./engine.ts";
import { workflowErrors } from "./errors.ts";
import { workflowsManage } from "./manage.ts";
import { workflowMcpTools } from "./mcp.ts";
import { handleWebhook, workflowRoutes, type Permissions } from "./routes.ts";
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
    /** Durable workflows from `@miujs/workflows`: start, emit, getRun, listRuns, cancel, retry, wakeNow, decide. */
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
  /**
   * Extra Cloudflare Cron Triggers to deploy, for cron workflows registered at run time
   * (`register()`, e.g. published from the admin UI). Workers only fire crons listed in the
   * deployment; crons of workflows passed in `workflows` are added automatically.
   */
  crons?: string[];
}

/** What a workflow was looked for by, when it is not registered here. */
export type UnknownWorkflow = { workflow: string } | { webhook: string } | { cron: string };

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
  // Workflows an operator disabled (admin settings): they start no new runs.
  const disabled = new Set<string>();

  const resumeJob = defineJob(RESUME_JOB, {
    input: t.object({ runId: t.string(), token: t.string() }),
    run: ({ input, env }) => engine.resume(input.runId, input.token, env),
  });
  const cronJob = defineJob(CRON_JOB, {
    input: t.object({ workflow: t.string(), cron: t.string() }),
    run: async ({ input, env }) => {
      const def = await engine.lookup(input.workflow, env);
      const tr = def?.triggers.find((x) => x.type === "cron" && x.cron === input.cron);
      if (!def || !tr || tr.type !== "cron") {
        log.warn("cron fired for a workflow that is no longer registered; skipped", { workflow: input.workflow, cron: input.cron });
        return;
      }
      if (disabled.has(def.name)) {
        log.info("cron fired for a disabled workflow; skipped", { workflow: def.name, cron: input.cron });
        return;
      }
      await engine.start(def, tr.input ?? {}, env, { trigger: { type: "cron", cron: input.cron } });
    },
  });

  // Live trigger indexes. The queue reads `schedules` on every tick (and on Workers' scheduled
  // event), and webhooks are dispatched from onRequest, so register()/unregister() take effect
  // without rebuilding routes or the queue.
  const schedules: Schedule<any>[] = [];
  // addSchedule/removeSchedule start the queue's minute scheduler with the first cron and stop it with the last.
  const q = queue({ jobs: [resumeJob, cronJob], schedules, adapter });
  const hooks = new Map<string, { def: WorkflowDef<any>; tr: WebhookTrigger }>();
  const checkHooks = (def: WorkflowDef<any>) => {
    for (const tr of def.triggers) {
      if (tr.type !== "webhook") continue;
      const taken = hooks.get(tr.path);
      if (taken) throw workflowErrors.config(`Webhook path ${tr.path} is used by workflow "${taken.def.name}" and "${def.name}"`, "Give each webhook trigger its own path.");
    }
  };
  const index = (def: WorkflowDef<any>) => {
    for (const tr of def.triggers) {
      if (tr.type === "cron") q.addSchedule(schedule(tr.cron, cronJob, { workflow: def.name, cron: tr.cron }));
      else if (tr.type === "webhook") hooks.set(tr.path, { def, tr });
    }
  };
  const unindex = (name: string) => {
    for (const sc of schedules.filter((x) => (x.input as { workflow: string }).workflow === name)) q.removeSchedule(sc);
    for (const [path, h] of hooks) if (h.def.name === name) hooks.delete(path);
  };
  for (const def of registry.values()) {
    checkHooks(def);
    index(def);
  }
  const extraCrons = (opts.crons ?? []).map((c) => parseCron(c).source);
  const unknownHandlers: ((what: UnknownWorkflow, env: Env) => Promise<void> | void)[] = [];
  const askUnknown = async (what: UnknownWorkflow, env: Env) => {
    for (const fn of unknownHandlers) {
      try {
        await fn(what, env);
      } catch (err) {
        log.error("workflows: onUnknown handler failed", { what, err });
      }
    }
  };

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
    resolve: (name, env) => askUnknown({ workflow: name }, env),
    isDisabled: (name) => disabled.has(name),
    service: (name) => {
      if (!appRef) {
        throw errors.config("MIU_E_SERVICE_MISSING", `No app to look up the "${name}" service in`, "Add workflows() to miu({ plugins }) and start runs after `await app.ready()`.");
      }
      return appRef.service(name);
    },
  });

  const api = {
    /**
     * Add a workflow while the app runs: its event, manual, cron and webhook triggers work at
     * once. Throws when the name or a webhook path is taken.
     */
    register(def: WorkflowDef<any>): void {
      if (!isWorkflow(def)) throw workflowErrors.config("register() got something that is not a workflow", "Pass a workflow created with defineWorkflow() or fromJson().");
      if (registry.has(def.name)) throw workflowErrors.duplicateWorkflow(def.name);
      checkHooks(def);
      engine.register(def);
      index(def);
    },
    /** True when a workflow with this name is registered here. */
    has(name: string): boolean {
      return engine.has(name);
    },
    /** Remove a workflow with its cron schedules and webhook. False when it was not registered. */
    unregister(name: string): boolean {
      unindex(name);
      return engine.unregister(name);
    },
    /**
     * Called when a run, a webhook or a cron event names a workflow this instance does not know,
     * e.g. one registered in another isolate. The handler may `register()` it; the lookup is then
     * retried once. It gets the env of the request or event (Workers bindings). Unknown webhook
     * paths call it too, so throttle expensive lookups.
     */
    onUnknown(fn: (what: UnknownWorkflow, env: Env) => Promise<void> | void): void {
      unknownHandlers.push(fn);
    },
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
    /**
     * Wake a sleeping or event-waiting run now: a sleep ends, a wait times out (returns null).
     * Idempotent; approvals are refused (MIU_E_CONFLICT) so they cannot be skipped.
     */
    wakeNow(id: string, env: Env = defaultEnv()) {
      return engine.wakeNow(id, env);
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
      // Registered before the queue's handler: a cron that no schedule here matches may belong to a
      // workflow registered in another isolate, so onUnknown gets a chance to load it first.
      app.on("scheduled", async (controller: unknown, env: unknown) => {
        const cron = String((controller as { cron?: unknown } | null)?.cron ?? "").trim().split(/\s+/).join(" ");
        if (cron && !schedules.some((sc) => sc.cron.source === cron)) await askUnknown({ cron }, (env ?? {}) as Env);
      });
      await q.setup(app);
    },
    async onRequest(ctx: Context) {
      ctx.events = { emit: (event, data, o) => engine.emit(event, data, ctx.env, o ?? {}) };
      // One dispatcher for every webhook trigger, looked up in the live registry. Only requests no
      // route matched, so other routes and 404/405 answers are unchanged.
      if (ctx.route || ctx.method !== "POST") return;
      let hit = hooks.get(ctx.path);
      if (!hit && unknownHandlers.length) {
        await askUnknown({ webhook: ctx.path }, ctx.env);
        hit = hooks.get(ctx.path);
      }
      if (hit) return handleWebhook(engine, hit.def, hit.tr, ctx);
    },
    mcpTools: () => workflowMcpTools({ engine, registry, permissions }),
    /** Runs, manual starts, events and disabling workflows, for @miujs/admin. */
    manage: () => workflowsManage({ engine, registry, store, adapter, disabled }),
    /** Stop the queue (timers, new runs); resolves when steps already running finished. */
    async stop() {
      await q.stop();
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
        routes: [...routes.map((r) => `${r.method} ${r.path}`), ...[...hooks.keys()].map((path) => `POST ${path}`)],
      };
    },
    cloudflare(): CloudflareNeeds {
      const needs = q.cloudflare();
      const crons = [...new Set([...(needs.crons ?? []), ...extraCrons])];
      return crons.length ? { ...needs, crons } : needs;
    },
  });
}

export type WorkflowsPlugin = ReturnType<typeof workflows>;

/** `app.service("workflows")`: start runs and emit events from code outside requests. */
export type WorkflowsService = Pick<WorkflowsPlugin, "start" | "emit" | "getRun" | "listRuns" | "cancel" | "retry" | "wakeNow" | "decide" | "register" | "unregister" | "has" | "onUnknown">;
