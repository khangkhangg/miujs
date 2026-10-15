import { errors, isMiuError, t, validate, type Context, type McpTool, type Schema } from "miujs";
import type { WorkflowDef } from "./define.ts";
import type { Engine } from "./engine.ts";
import { checkPermission, describeWorkflow, runDetail, runSummary, type Permissions } from "./routes.ts";
import { RUN_STATUSES } from "./store.ts";

/** MCP tools so agents can drive automation. Same permissions as the routes. */
export function workflowMcpTools(o: { engine: Engine; registry: Map<string, WorkflowDef<any>>; permissions: Permissions }): McpTool[] {
  const { engine, registry, permissions: perm } = o;
  const names = [...registry.keys()];
  const workflowName = names.length ? t.enum(names as [string, ...string[]], { description: "Workflow name (see workflows_list)" }) : t.string();

  const tool = <S extends Schema<any>>(name: string, description: string, schema: S, permission: string, fn: (args: any, ctx: Context) => Promise<unknown>): McpTool => ({
    name,
    description,
    inputSchema: schema.json,
    async call(raw, ctx) {
      try {
        const r = validate(schema, raw ?? {});
        if (!r.ok) throw errors.validation("arguments", r.issues);
        await checkPermission(ctx, permission);
        return await fn(r.value, ctx);
      } catch (err) {
        // The MCP layer only forwards the message: put the code and fix in it for agents.
        if (isMiuError(err)) throw new Error(`${err.code}: ${err.message}${err.fix ? ` Fix: ${err.fix}` : ""}`);
        throw err;
      }
    },
  });

  return [
    tool("workflows_list", "List automation workflows: name, description, triggers (event/cron/webhook/manual) and the input schema each expects.", t.object({}), perm.read, async () => ({
      workflows: [...registry.values()].map(describeWorkflow),
    })),
    tool(
      "workflow_start",
      "Start a workflow run now with the given input (validated against the workflow's input schema). Returns the run id; poll workflow_run for progress.",
      t.object({ workflow: workflowName, input: t.optional(t.record(t.unknown(), { description: "Workflow input object" })) }),
      perm.run,
      async (a, ctx) => engine.start(a.workflow, a.input ?? {}, ctx.env, { trigger: { type: "manual", by: ctx.user!.id } }),
    ),
    tool(
      "workflow_runs",
      "List workflow runs, newest first. Filter by workflow and status (queued, running, sleeping, waiting, completed, failed, cancelled).",
      t.object({ workflow: t.optional(t.string()), status: t.optional(t.enum(RUN_STATUSES)), limit: t.optional(t.integer({ min: 1, max: 200 })), before: t.optional(t.number({ description: "Page cursor: `next` from the previous call" })) }),
      perm.read,
      async (a, ctx) => {
        const limit = a.limit ?? 20;
        const runs = await engine.listRuns({ workflow: a.workflow, status: a.status, before: a.before, limit }, ctx.env);
        return { runs: runs.map(runSummary), next: runs.length === limit ? runs[runs.length - 1].createdAt : null };
      },
    ),
    tool(
      "workflow_run",
      "Get one workflow run: status, input, output, error and the step timeline (what it is sleeping or waiting for).",
      t.object({ id: t.string({ description: "Run id" }) }),
      perm.read,
      async (a, ctx) => runDetail(await engine.getRun(a.id, ctx.env)),
    ),
    tool(
      "emit_event",
      "Emit a business event (e.g. contact.created). Starts workflows triggered by it and resumes runs waiting for it. Use idempotencyKey to avoid duplicates.",
      t.object({ event: t.string({ minLength: 1 }), data: t.optional(t.unknown()), idempotencyKey: t.optional(t.string({ minLength: 1 })) }),
      perm.emit,
      async (a, ctx) => engine.emit(a.event, a.data ?? null, ctx.env, { idempotencyKey: a.idempotencyKey }),
    ),
  ];
}
