// workflows().manage(): runtime operations for @miujs/admin. The admin's workflow builder pages
// edit definitions; this section watches and drives runs: counts, the runs list with cancel, retry
// and wake now, starting a workflow or emitting an event by hand, and disabling workflows.
import { errors, t, type Context, type ManageAction, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import { previewJson, type QueueAdapter } from "@miujs/queue";
import type { Trigger, WorkflowDef } from "./define.ts";
import type { Engine } from "./engine.ts";
import { workflowErrors } from "./errors.ts";
import { RUN_STATUSES, TERMINAL, type RunFilter, type RunRecord, type RunStatus, type RunStore, type TriggerInfo } from "./store.ts";

/** Runs counted per status in the status; above it the count shows as "200+". */
export const STATUS_COUNT_CAP = 200;
const PAGE_MAX = 100;
/** Runs created in one millisecond that a cursor can step over. */
const MAX_SKIP = 10_000;

export interface WorkflowsManageDeps {
  engine: Engine;
  registry: ReadonlyMap<string, WorkflowDef<any>>;
  store: RunStore;
  adapter: QueueAdapter;
  disabled: Set<string>;
}

const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function triggerText(tr: Trigger): string {
  switch (tr.type) {
    case "event":
      return `event ${tr.event}`;
    case "cron":
      return `cron ${tr.cron}`;
    case "webhook":
      return `webhook ${tr.path}${tr.secret !== undefined ? " (signed)" : ""}`;
    default:
      return "manual";
  }
}

function startedBy(tr: TriggerInfo): string {
  if (tr.type === "event") return `event ${tr.event ?? ""}`.trim();
  if (tr.type === "cron") return `cron ${tr.cron ?? ""}`.trim();
  if (tr.type === "webhook") return `webhook ${tr.path ?? ""}`.trim();
  return tr.by ? `manual by ${tr.by}` : "manual";
}

/** A run as a list row. Never the resume token; the input with secret-looking keys hidden. */
function runRow(r: RunRecord): Record<string, ManageValue> {
  return {
    id: r.id,
    workflow: r.workflow,
    status: r.status,
    trigger: startedBy(r.trigger),
    input: previewJson(r.input),
    error: r.error ? clip(r.error.message) : null,
    step: r.error?.step ?? null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    finishedAt: iso(r.finishedAt),
  };
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw errors.badRequest(`${field} is not valid JSON`, 'Pass an object, or JSON text such as {"name":"Ann"}.');
  }
}

/** `<createdAt>.<runs at that createdAt already shown>`: exact paging through runs created in one millisecond. */
function parseCursor(cursor: string | undefined): { ts: number; skip: number } | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const m = /^(\d{1,15})\.(\d{1,5})$/.exec(cursor);
  if (!m || Number(m[2]) > MAX_SKIP) throw errors.badRequest(`Invalid cursor ${JSON.stringify(cursor)}`, "Pass the `next` value of the previous page, or no cursor for the first page.");
  return { ts: Number(m[1]), skip: Number(m[2]) };
}

const idInput = t.object({ id: t.string({ minLength: 1, maxLength: 200 }) });

export function workflowsManage(d: WorkflowsManageDeps): ManageSection[] {
  const { engine, registry, disabled } = d;
  const runOf = async (id: string, ctx: Context): Promise<RunRecord> => {
    const run = await engine.store(ctx.env).getRun(id);
    if (!run) throw workflowErrors.runNotFound(id);
    return run;
  };

  const counted: { status: RunStatus; label: string; hint: string }[] = [
    { status: "queued", label: "Queued", hint: "Waiting to run (or held back by a concurrency limit)." },
    { status: "running", label: "Running", hint: "Running now, or between steps." },
    { status: "sleeping", label: "Sleeping", hint: "In step.sleep or a retry backoff." },
    { status: "waiting", label: "Waiting", hint: "Waiting for an event or an approval." },
    { status: "failed", label: "Failed", hint: "Failed runs still in the store. Retry them from the runs list." },
  ];

  async function status(ctx: Context) {
    const stats: ManageStat[] = [
      { label: "Workflows", value: registry.size, hint: "Registered in this instance." },
      { label: "Disabled", value: [...registry.keys()].filter((n) => disabled.has(n)).length, hint: "Start no new runs. Change under Settings." },
    ];
    for (const c of counted) {
      const n = (await engine.listRuns({ status: c.status, limit: STATUS_COUNT_CAP + 1 }, ctx.env)).length;
      const stat: ManageStat = { label: c.label, value: n > STATUS_COUNT_CAP ? `${STATUS_COUNT_CAP}+` : n, hint: c.hint };
      if (c.status === "failed" && n > 0) stat.tone = "critical";
      stats.push(stat);
    }
    stats.push({ label: "Store", value: d.store.kind }, { label: "Queue", value: d.adapter.name });
    const failures = await engine.listRuns({ status: "failed", limit: 5 }, ctx.env);
    return {
      stats,
      tables: [
        {
          title: "Workflows",
          columns: [
            { key: "name", label: "Workflow", type: "code" as const },
            { key: "description", label: "Description" },
            { key: "triggers", label: "Triggers" },
            { key: "enabled", label: "Enabled", type: "boolean" as const },
          ],
          rows: [...registry.values()].map((w) => ({ name: w.name, description: w.description ?? null, triggers: w.triggers.map(triggerText).join(", "), enabled: !disabled.has(w.name) })),
        },
        {
          title: "Recent failures",
          columns: [
            { key: "id", label: "Run", type: "code" as const },
            { key: "workflow", label: "Workflow", type: "code" as const },
            { key: "step", label: "Step", type: "code" as const },
            { key: "error", label: "Error" },
            { key: "at", label: "Failed", type: "date" as const },
          ],
          rows: failures.map((r) => ({ id: r.id, workflow: r.workflow, step: r.error?.step ?? null, error: r.error ? clip(r.error.message) : null, at: iso(r.finishedAt ?? r.updatedAt) })),
        },
      ],
    };
  }

  const cancel: ManageAction<{ id: string }> = {
    name: "cancel",
    title: "Cancel",
    description: "Stop the run: it will not resume. Steps that already ran are not undone.",
    danger: true,
    input: idInput,
    async run(input, ctx) {
      const run = await runOf(input.id, ctx);
      if (TERMINAL.has(run.status)) return `Run ${run.id} is already ${run.status}; nothing to do.`;
      await engine.cancel(run.id, ctx.env);
      return `Cancelled run ${run.id}.`;
    },
  };
  const retry: ManageAction<{ id: string }> = {
    name: "retry",
    title: "Retry",
    description: "Resume a failed run from its failed step. Completed steps are not run again.",
    input: idInput,
    async run(input, ctx) {
      const run = await runOf(input.id, ctx);
      if (run.status !== "failed") return `Run ${run.id} is ${run.status}; only failed runs can be retried.`;
      await engine.retry(run.id, ctx.env);
      return `Retrying run ${run.id} from its failed step.`;
    },
  };

  const wakeNow: ManageAction<{ id: string }> = {
    name: "wakeNow",
    title: "Wake now",
    description: "Continue a sleeping run now, or time out its waitForEvent now (the step returns null, as on a timeout). Approvals are decided, not woken.",
    input: idInput,
    async run(input, ctx) {
      const r = await engine.wakeNow(input.id, ctx.env);
      return r.woke ? `Woke run ${r.runId}.` : `Run ${r.runId} is ${r.status}; nothing to do.`;
    },
  };

  const actions: ManageAction[] = [
    {
      name: "start",
      title: "Start a workflow",
      description: "Start a run now with JSON input, as a manual run by you. The input is validated by the workflow's schema.",
      input: t.object({
        workflow: t.string({ minLength: 1, maxLength: 200, description: "Workflow name" }),
        input: t.optional(t.unknown({ description: "JSON input (an object, or JSON text)" })),
      }),
      async run(input: { workflow: string; input?: unknown }, ctx) {
        const value = parseJson(input.input ?? {}, "input");
        const by = ctx.user?.id;
        const r = await engine.start(input.workflow, value, ctx.env, { trigger: by ? { type: "manual", by } : { type: "manual" } });
        return { ...r, message: `Started ${input.workflow} as run ${r.id}.` };
      },
    },
    {
      name: "emit",
      title: "Emit an event",
      description: "Send an event: starts workflows it triggers and resumes runs waiting for it.",
      input: t.object({
        event: t.string({ minLength: 1, maxLength: 200, description: "Event name, e.g. contact.created" }),
        data: t.optional(t.unknown({ description: "Event data (JSON)" })),
        idempotencyKey: t.optional(t.string({ minLength: 1, maxLength: 200, description: "Emitting twice with one key has no second effect" })),
      }),
      async run(input: { event: string; data?: unknown; idempotencyKey?: string }, ctx) {
        const r = await engine.emit(input.event, parseJson(input.data, "data"), ctx.env, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {});
        const message = r.duplicate
          ? `Duplicate of event ${r.id} (same idempotency key); nothing happened.`
          : `Event ${r.id}: started ${r.started.length}, resumed ${r.resumed.length}, skipped ${r.skipped.length}.`;
        return { ...r, message };
      },
    },
  ];

  return [
    {
      id: "workflows",
      title: "Workflows",
      description: "Workflow runs: counts, failures, cancel and retry, manual starts and events, and disabling workflows.",
      status,
      lists: [
        {
          name: "runs",
          title: "Runs",
          columns: [
            { key: "id", label: "Run", type: "code" },
            { key: "workflow", label: "Workflow", type: "code" },
            { key: "status", label: "Status" },
            { key: "trigger", label: "Started by" },
            { key: "input", label: "Input (secrets hidden)", type: "code" },
            { key: "error", label: "Error" },
            { key: "step", label: "Failed step", type: "code" },
            { key: "createdAt", label: "Created", type: "date" },
            { key: "updatedAt", label: "Updated", type: "date" },
            { key: "finishedAt", label: "Finished", type: "date" },
          ],
          idKey: "id",
          searchable: true,
          get filters() {
            return [
              { key: "workflow", label: "Workflow", options: [...registry.keys()] },
              { key: "status", label: "Status", options: [...RUN_STATUSES] },
            ];
          },
          async list(q, ctx) {
            const filter: RunFilter = {};
            const wf = q.filters?.workflow;
            if (wf) filter.workflow = wf;
            const st = q.filters?.status;
            if (st) {
              if (!RUN_STATUSES.includes(st as RunStatus)) throw errors.badRequest(`Unknown run status ${JSON.stringify(st)}`, `Filter by one of: ${RUN_STATUSES.join(", ")}.`);
              filter.status = st as RunStatus;
            }
            const search = q.search?.trim();
            if (search) {
              // Search finds one run by id: cheap on every store.
              const run = search.length <= 200 ? await engine.store(ctx.env).getRun(search) : null;
              const fits = run && (!filter.workflow || run.workflow === filter.workflow) && (!filter.status || run.status === filter.status);
              return { rows: fits ? [runRow(run)] : [] };
            }
            const cur = parseCursor(q.cursor);
            const skip = cur?.skip ?? 0;
            const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(q.limit) || PAGE_MAX));
            const got = await engine.listRuns({ ...filter, ...(cur ? { before: cur.ts + 1 } : {}), limit: skip + limit + 1 }, ctx.env);
            // Newest first: the first `skip` runs are those at cur.ts already shown.
            const rest = got.slice(skip);
            const items = rest.slice(0, limit);
            const rows = items.map(runRow);
            if (rest.length <= limit || items.length === 0) return { rows };
            const last = items[items.length - 1].createdAt;
            let same = items.filter((r) => r.createdAt === last).length;
            if (cur && last === cur.ts) same += skip;
            return same > MAX_SKIP ? { rows } : { rows, next: `${last}.${same}` };
          },
          rowActions: [cancel, retry, wakeNow],
        },
      ],
      settings: {
        schema: t.object({
          disabled: t.array(t.string({ minLength: 1, maxLength: 200 }), { max: 1000, description: "Workflows that start no new runs (runs already started go on)" }),
        }),
        get: () => ({ disabled: [...disabled] }),
        set(v: { disabled: string[] }) {
          disabled.clear();
          for (const n of v.disabled) disabled.add(n);
        },
      },
      actions,
    },
  ];
}
