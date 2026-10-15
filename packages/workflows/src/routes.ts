import { errors, route, t, type AuthUser, type Context, type RouteDef } from "miujs";
import { describeTrigger, type WebhookTrigger, type WorkflowDef } from "./define.ts";
import type { Engine, RunView } from "./engine.ts";
import { workflowErrors } from "./errors.ts";
import { RUN_STATUSES, type RunRecord } from "./store.ts";

/** Permission names passed to `ctx.authorize(perm)`. */
export interface Permissions {
  /** List workflows and runs. */
  read: string;
  /** Start runs manually. */
  run: string;
  /** Cancel and retry runs. */
  manage: string;
  /** Emit events. */
  emit: string;
}

type Authorize = (perm: string) => unknown;

/**
 * Structural permission check: `ctx.authorize(perm)` when an access plugin provides it (false
 * or a throw denies), otherwise the `admin` role.
 */
export async function checkPermission(ctx: Pick<Context, "user">, perm: string): Promise<void> {
  if (!ctx.user) throw errors.unauthorized();
  const authorize = (ctx as { authorize?: Authorize }).authorize;
  if (typeof authorize === "function") {
    if ((await authorize.call(ctx, perm)) === false) throw errors.forbidden(`Missing permission ${perm}`, `Grant "${perm}" to this user (see your access rules).`);
    return;
  }
  if (!ctx.user.roles?.includes("admin")) {
    throw errors.forbidden("Workflows require the admin role", `Sign in as an admin, or add an access plugin that provides ctx.authorize("${perm}").`);
  }
}

/** The list form of a run: no input/output payloads, no internals. */
export function runSummary(r: RunRecord) {
  return { id: r.id, workflow: r.workflow, status: r.status, trigger: r.trigger, error: r.error, createdAt: r.createdAt, updatedAt: r.updatedAt, finishedAt: r.finishedAt, wakeAt: r.wakeAt };
}

/** The detail form of a run, with its step timeline. */
export function runDetail(r: RunView) {
  const { token: _t, leaseUntil: _l, ...rest } = r;
  return rest;
}

export function describeWorkflow(d: WorkflowDef<any>) {
  const out: Record<string, unknown> = { name: d.name };
  if (d.description) out.description = d.description;
  out.triggers = d.triggers.map(describeTrigger);
  out.input = d.input.json;
  if (d.concurrency) out.concurrency = { limit: d.concurrency.limit };
  return out;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, "").toLowerCase();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return safeEqual(given, want);
}

/**
 * Handles a POST to a webhook trigger's path: checks the HMAC signature when a secret is set,
 * maps the JSON body to input and starts the run (202 with the run id). The workflows plugin
 * calls it from one dispatcher that looks paths up in the live registry, so workflows
 * registered at run time get webhooks without new routes.
 */
export async function handleWebhook(engine: Engine, def: WorkflowDef<any>, tr: WebhookTrigger, ctx: Context): Promise<Response> {
  const raw = await ctx.req.text();
  if (tr.secret !== undefined) {
    const secret = typeof tr.secret === "function" ? tr.secret(ctx.env) : tr.secret;
    if (!secret) {
      throw workflowErrors.config(`Webhook ${tr.path} has a secret configured, but it resolved to nothing`, "Set the secret in env (e.g. FORM_SECRET) or pass secret: \"...\" to webhook().");
    }
    if (!(await verifySignature(secret, raw, ctx.headers.get(tr.header ?? "x-signature")))) throw workflowErrors.signature();
  }
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      throw errors.custom({ code: "MIU_E_BAD_JSON", status: 400, message: "Webhook body is not valid JSON", fix: "Send a JSON body." });
    }
  }
  let input: unknown;
  try {
    input = tr.input ? tr.input(body, ctx.req) : body;
  } catch (err) {
    throw errors.badRequest(`Webhook body could not be mapped to workflow input: ${(err as Error)?.message ?? err}`, "Send the payload shape this webhook expects.");
  }
  const run = await engine.start(def, input, ctx.env, { trigger: { type: "webhook", path: tr.path } });
  return Response.json(run, { status: 202 });
}

export function workflowRoutes(o: { engine: Engine; registry: Map<string, WorkflowDef<any>>; prefix: string; permissions: Permissions }): RouteDef[] {
  const { engine, registry, permissions: perm } = o;
  const p = o.prefix.replace(/\/+$/, "");
  const common = { tags: ["workflows"], auth: "required" as const, mcp: false };

  const list = route.get(`${p}`, {
    ...common,
    name: "listWorkflows",
    summary: "List workflow definitions with their triggers and input schema",
    handler: async (ctx) => {
      await checkPermission(ctx, perm.read);
      return { workflows: [...registry.values()].map(describeWorkflow) };
    },
  });

  const start = route.post(`${p}/:name/runs`, {
    ...common,
    name: "startWorkflowRun",
    summary: "Start a workflow run manually",
    params: t.object({ name: t.string() }),
    body: t.optional(t.object({ input: t.optional(t.unknown()) })),
    status: 201,
    handler: async (ctx) => {
      await checkPermission(ctx, perm.run);
      return engine.start(ctx.params.name, ctx.body?.input ?? {}, ctx.env, { trigger: { type: "manual", by: ctx.user.id } });
    },
  });

  const runs = route.get(`${p}/runs`, {
    ...common,
    name: "listWorkflowRuns",
    summary: "List workflow runs, newest first (filter by workflow and status; page with before=next)",
    query: t.object({
      workflow: t.optional(t.string()),
      status: t.optional(t.enum(RUN_STATUSES)),
      limit: t.optional(t.integer({ min: 1, max: 200 })),
      before: t.optional(t.number()),
    }),
    handler: async (ctx) => {
      await checkPermission(ctx, perm.read);
      const limit = ctx.query.limit ?? 50;
      const found = await engine.listRuns({ workflow: ctx.query.workflow, status: ctx.query.status, before: ctx.query.before, limit }, ctx.env);
      return { runs: found.map(runSummary), next: found.length === limit ? found[found.length - 1].createdAt : null };
    },
  });

  const getRun = route.get(`${p}/runs/:id`, {
    ...common,
    name: "getWorkflowRun",
    summary: "Get a workflow run with its step timeline",
    params: t.object({ id: t.string() }),
    handler: async (ctx) => {
      await checkPermission(ctx, perm.read);
      return runDetail(await engine.getRun(ctx.params.id, ctx.env));
    },
  });

  const cancel = route.post(`${p}/runs/:id/cancel`, {
    ...common,
    name: "cancelWorkflowRun",
    summary: "Cancel a queued, running, sleeping or waiting run",
    params: t.object({ id: t.string() }),
    handler: async (ctx) => {
      await checkPermission(ctx, perm.manage);
      return runSummary(await engine.cancel(ctx.params.id, ctx.env));
    },
  });

  const retry = route.post(`${p}/runs/:id/retry`, {
    ...common,
    name: "retryWorkflowRun",
    summary: "Retry a failed run from its failed step",
    params: t.object({ id: t.string() }),
    handler: async (ctx) => {
      await checkPermission(ctx, perm.manage);
      return runSummary(await engine.retry(ctx.params.id, ctx.env));
    },
  });

  const emit = route.post(`${p}/events`, {
    ...common,
    name: "emitWorkflowEvent",
    summary: "Emit an event: starts matching workflows and resumes runs waiting for it",
    body: t.object({ event: t.string({ minLength: 1 }), data: t.optional(t.unknown()), idempotencyKey: t.optional(t.string({ minLength: 1 })) }),
    status: 202,
    handler: async (ctx) => {
      await checkPermission(ctx, perm.emit);
      return engine.emit(ctx.body.event, ctx.body.data ?? null, ctx.env, { idempotencyKey: ctx.body.idempotencyKey });
    },
  });

  const approve = route.post(`${p}/approvals/:runId/:step`, {
    ...common,
    name: "decideWorkflowApproval",
    summary: "Approve or reject a run waiting on step.waitForApproval (approvers only)",
    params: t.object({ runId: t.string(), step: t.string() }),
    body: t.object({ decision: t.enum(["approve", "reject"]), comment: t.optional(t.string({ maxLength: 2000 })) }),
    handler: async (ctx) => {
      const user = ctx.user as AuthUser;
      return engine.decide(ctx.params.runId, ctx.params.step, user, ctx.body.decision, ctx.body.comment, ctx.env);
    },
  });

  return [list, runs, getRun, cancel, retry, emit, approve, start];
}
