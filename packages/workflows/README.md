# @miujs/workflows

> Durable workflows for MiuJS: event, cron, webhook and manual triggers, journaled steps, sleeps, waits for events and approvals, JSON-defined workflows, routes and MCP tools.

`@miujs/workflows` runs automation that survives restarts and deploys while it sleeps or waits. A workflow's `run` function is replayed from the top on every resume; each `step.*` call is journaled, so completed steps return their recorded result instead of running again. Runs are resumed through `@miujs/queue` and stored in memory or in a SQL database through `@miujs/db`. Use it for follow-ups, approvals, onboarding sequences and other multi-day processes, and when agents should be able to start and inspect runs.

## Install

```bash
bun add @miujs/workflows miujs @miujs/db @miujs/queue
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, t } from "miujs";
import { defineWorkflow, workflows } from "@miujs/workflows";

export const hello = defineWorkflow("hello", {
  input: t.object({ name: t.string() }),
  run: async ({ input, step }) => {
    const greeting = await step.run("greet", async () => `hi ${input.name}`);
    return { greeting };
  },
});

const wf = workflows({ workflows: [hello] }); // memory run store and queue by default
const app = miu({ name: "automation", plugins: [wf], mcp: true });
await app.ready();

const { id } = await wf.start("hello", { name: "Ann" });
console.log(id, (await wf.getRun(id)).status);

export default app;
```

The plugin object also has `emit(event, data)`, `listRuns(filter)`, `cancel(id)`, `retry(id)` (resume a failed run from its failed step) and `decide(runId, step, user, decision, comment)`. In requests, `ctx.events.emit(event, data, { idempotencyKey })` starts event-triggered workflows and resumes runs waiting for that event.

## Steps

Code outside `step.*` calls must be deterministic: do side effects in `step.run`, and use `step.now()` / `step.uuid()` instead of `Date.now()` / `crypto.randomUUID()`. Step names must be unique within a run.

<!-- test -->
```ts
import { t } from "miujs";
import { NonRetryableError, defineWorkflow, on } from "@miujs/workflows";

async function enrich(email: string) {
  if (!email.includes("@")) throw new NonRetryableError("not an email"); // fail now, no retries
  return { email, company: email.split("@")[1] };
}

export const followUp = defineWorkflow("contact-follow-up", {
  trigger: on("contact.created"),
  input: t.object({ contactId: t.string(), email: t.string() }),
  concurrency: { key: (input) => input.contactId, limit: 1 },
  run: async ({ input, step, log }) => {
    const lead = await step.run("enrich", () => enrich(input.email), { retries: 5, backoff: "exponential" });
    await step.sleep("wait-a-day", "1d");
    const reply = await step.waitForEvent("reply", { event: "email.replied", match: { "data.contactId": input.contactId }, timeout: "3d" });
    if (!reply) {
      const decision = await step.waitForApproval("send-follow-up", { approvers: { role: "manager" }, timeout: "2d" });
      if (decision?.decision === "approve") await step.run("follow-up", () => log.info("following up", { company: lead.company }));
    }
  },
});
```

| Step | What it does |
| --- | --- |
| `step.run(name, fn, { retries, backoff })` | Run once; the JSON result is journaled. Retried on throw (default 3 retries, exponential backoff). |
| `step.sleep(name, duration)` / `step.sleepUntil(name, time)` | Pause durably. Durations: `"1d"`, `"12h"`, `"3 days"` or milliseconds. |
| `step.waitForEvent(name, { event, match, timeout })` | Park until a matching event; `null` on timeout. |
| `step.waitForApproval(name, { approvers, timeout })` | Park until an approver decides via `POST /workflows/approvals/:runId/:step`; `null` on timeout. |
| `step.now(name?)` / `step.uuid(name?)` | Journaled time and UUID. |

A step that fails every attempt throws `StepFailedError` into the workflow code.

## Triggers

<!-- test -->
```ts
import { cron, defineWorkflow, manual, on, webhook } from "@miujs/workflows";

export const weekly = defineWorkflow("weekly-report", {
  trigger: [
    cron("0 9 * * 1"),                                                      // 5-field UTC cron
    on("deal.updated", { match: { "data.stage": "won" } }),                 // event with a match
    webhook("/hooks/form", { secret: (env) => env.FORM_SECRET as string }), // POST, HMAC-SHA256 in x-signature
    manual(),                                                               // code, API or MCP only
  ],
  run: async ({ run }) => ({ trigger: run.trigger.type }),
});
```

Without `trigger`, a workflow is manual. Every workflow can also be started manually.

## JSON workflows

`fromJson` turns a JSON spec (the format a visual builder saves) into a workflow that runs on the same engine. `validateSpec` returns precise issues with a `path`, `message` and `fix`. Built-in actions are `http`, `send_email` and `log`; add your own with `defineAction`. Strings support `{{ expression }}` templates over `data`, `input` and `steps`.

<!-- test -->
```ts
import { t } from "miujs";
import { defineAction, fromJson, validateSpec, workflows } from "@miujs/workflows";

const updateRecord = defineAction("update_record", {
  description: "Update a CRM record",
  params: t.object({ id: t.string(), fields: t.record(t.unknown()) }),
  run: async (params) => ({ updated: params.id }),
});

const spec = {
  name: "deal-flow",
  trigger: { type: "event", event: "deal.updated" },
  steps: [
    {
      id: "check",
      type: "condition",
      if: "data.amount > 10000 && data.stage == 'won'",
      then: [{ id: "approve", type: "approval", approvers: { role: "manager" }, timeout: "2d" }],
      else: [{ id: "small", type: "action", action: "log", params: { message: "small deal {{ data.id }}" } }],
    },
    { id: "record", type: "action", action: "update_record", params: { id: "{{ data.id }}", fields: { amount: "{{ data.amount }}" } } },
  ],
};

const checked = validateSpec(spec, { actions: [updateRecord] });
if (!checked.ok) console.log(checked.issues);

export const dealFlow = fromJson(spec, { actions: [updateRecord] });
export const plugin = workflows({ workflows: [dealFlow] });
```

Step types: `action`, `condition`, `wait`, `wait_for_event`, `approval`. Trigger types: `event`, `cron`, `webhook` (with `secretEnv`, `header`), `manual`.

## Routes and MCP

Routes (all `auth: "required"`, under `prefix`, default `/workflows`):

| Route | Purpose |
| --- | --- |
| `GET /workflows` | List workflows, triggers and input schemas. |
| `POST /workflows/:name/runs` | Start a run: body `{ input }`. |
| `GET /workflows/runs`, `GET /workflows/runs/:id` | List runs; one run with its step timeline. |
| `POST /workflows/runs/:id/cancel`, `POST /workflows/runs/:id/retry` | Cancel; retry from the failed step. |
| `POST /workflows/events` | Emit an event: body `{ event, data, idempotencyKey }`. |
| `POST /workflows/approvals/:runId/:step` | Decide: body `{ decision: "approve" \| "reject", comment }`. |

With `miu({ mcp: true })`, agents get the tools `workflows_list`, `workflow_start`, `workflow_runs`, `workflow_run` and `emit_event`. Routes and tools check `ctx.authorize(permission)` when it exists, with the permissions `workflows:read`, `workflows:run`, `workflows:manage` and `workflows:emit` (rename them with `permissions`).

## Durable storage

<!-- test -->
```ts
import { sqlite } from "@miujs/db";
import { defineWorkflow, dbRunStore, workflows } from "@miujs/workflows";

const ping = defineWorkflow("ping", { run: async ({ step }) => step.now("at") });

export const plugin = workflows({
  workflows: [ping],
  store: dbRunStore(sqlite("app.db")), // tables are created on first use (workflowMigrations)
  mailer: { send: async (msg) => console.log("send_email", msg) }, // any object with send(msg)
});
```

`memoryRunStore()` (the default) loses runs on restart. Use `dbRunStore(sqlite(path))` on a server or `dbRunStore(d1("DB"))` on Workers.

The memory store is bounded so a long-running process does not grow: it keeps the newest 1000 finished (completed, failed, cancelled) runs with their step journals, and remembers event idempotency keys for 24 hours, up to 10 000 keys. Active runs are always kept. To change the limits, pass `memoryRunStore({ maxFinishedRuns: 5000, idempotencyTtlMs: 3_600_000, maxIdempotencyKeys: 50_000 })`. A finished run that has been dropped can no longer be read or retried.

## Options

`workflows(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workflows` | `WorkflowDef[]` | required | Workflows from `defineWorkflow()` or `fromJson()`. |
| `store` | `RunStore` | `memoryRunStore()` | Run storage; `dbRunStore(database)` survives restarts. |
| `adapter` | `QueueAdapter` | `memoryQueue()`; on Workers `cloudflareQueue({ binding: "WORKFLOWS_QUEUE", queue: "miu-workflows" })` | Queue that resumes runs. |
| `clock` | `Clock` | `realClock` | Time source (`manualClock()` in tests). |
| `maxDelaySeconds` | `number` | 12 h on Cloudflare, unlimited otherwise | Longest single queue delay; longer sleeps are chained. |
| `leaseMs` | `number` | `900000` (15 min) | How long one invocation may hold a run. |
| `env` | `Env` | process env | Env for work started outside a request. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | fetch for steps and the `http` action. |
| `mailer` | `{ send(msg) }` | a plugin named `mail` with `send()`, if any | Mailer for the `send_email` action. |
| `prefix` | `string` | `"/workflows"` | Route prefix. |
| `permissions` | `Partial<{ read, run, manage, emit }>` | `workflows:read`, `workflows:run`, `workflows:manage`, `workflows:emit` | Permission names checked with `ctx.authorize`. |

`defineWorkflow(name, config)`: `run` (required), `input` (a `t` schema; default any object), `trigger` (one or an array; default `manual()`), `description`, `concurrency: { key(input), limit }` (limit default `1`).

## Admin (`manage()`)

With `@miujs/admin`, the plugin shows a **Workflows** section next to the admin's workflow builder (which edits definitions; this section operates runs):

- **Status**: registered and disabled workflows, runs queued, running, sleeping, waiting and failed (each counted up to 200, then shown as `200+`), the store and queue in use, a **Workflows** table (triggers, enabled) and the 5 most recent failures.
- **Runs** list, newest first, filtered by workflow and status; search finds a run by id. Rows never include the resume token, and inputs hide secret-looking keys. Row actions: `cancel` (danger) and `retry` (failed runs, from the failed step). Both answer with a message instead of failing when there is nothing to do.
- **Actions**: `start` (start a workflow with JSON input as a manual run by the operator) and `emit` (send an event with optional data and idempotency key).
- **Settings**: `disabled`, a list of workflow names that start no new runs from any trigger (event, cron, webhook, manual, admin). Runs already started go on; cancel them from the runs list. Starting a disabled workflow fails with `MIU_E_CONFLICT` (409); emit reports it under `skipped`; cron firings are skipped without retries.

There is no "resume now" action for sleeping or waiting runs: they wake on their timer or event (use `emit`).

## Errors

- `MIU_E_WORKFLOW_CONFIG`: invalid `defineWorkflow`, trigger, action or plugin options.
- `MIU_E_WORKFLOW_DUPLICATE`: two workflows share a name.
- `MIU_E_WORKFLOW_UNKNOWN`: no workflow with this name.
- `MIU_E_WORKFLOW_RUN_NOT_FOUND` / `MIU_E_WORKFLOW_RUN_STATE`: unknown run, or the run cannot be cancelled or retried in its current state.
- `MIU_E_WORKFLOW_STEP_DUPLICATE`: two steps in one run share a name.
- `MIU_E_WORKFLOW_DURATION`: a duration such as `"1d"` could not be parsed.
- `MIU_E_WORKFLOW_SPEC_INVALID` / `MIU_E_WORKFLOW_ACTION_UNKNOWN` / `MIU_E_WORKFLOW_EXPRESSION`: problems in a JSON spec.
- `MIU_E_WORKFLOW_SIGNATURE`: a webhook signature did not match.
- `MIU_E_WORKFLOW_NOT_APPROVER` / `MIU_E_WORKFLOW_APPROVAL_NOT_PENDING`: the user may not decide, or nothing is waiting for approval.
- `MIU_E_WORKFLOW_EVENT_RESERVED`: `workflow.approval` cannot be emitted; use the approvals route.
- `MIU_E_WORKFLOW_MAILER_MISSING`: `send_email` ran without a mailer.

See [all error codes](../../docs/errors.md), e.g. [`MIU_E_WORKFLOW_CONFIG`](../../docs/errors.md#miu_e_workflow_config).

## Cloudflare Workers

The default engine resumes runs through Cloudflare Queues (binding `WORKFLOWS_QUEUE`); cron triggers become Worker cron triggers. Store runs in D1 with `dbRunStore(d1("DB"))`. `miu deploy cloudflare` declares the queue and crons:

```toml
[[queues.producers]]
binding = "WORKFLOWS_QUEUE"
queue = "workflows-queue"

[[queues.consumers]]
queue = "workflows-queue"

[triggers]
crons = ["0 9 * * 1"]
```

Add a `[[d1_databases]]` binding named `DB` yourself if you use `d1("DB")`. Queue delays are capped at 12 hours on Cloudflare; longer sleeps are chained automatically.

Alternatively, run a code-defined workflow on Cloudflare Workflows with `createCloudflareWorkflow(def, { base: WorkflowEntrypoint })`, where `WorkflowEntrypoint` comes from `cloudflare:workers`. `step.run` maps to `step.do`, sleeps and `waitForEvent` map directly, and `waitForApproval` waits for an event of type `approval-<step>`.

<!-- test -->
```ts
import { createCloudflareWorkflow, defineWorkflow } from "@miujs/workflows";

const nightly = defineWorkflow("nightly", { run: async ({ step }) => step.run("tick", () => 1) });

// wrangler: [[workflows]] name = "nightly" binding = "NIGHTLY" class_name = "Nightly"
export const Nightly = createCloudflareWorkflow(nightly);
```

`sqlite()` from `@miujs/db` runs on Bun only; the memory store and memory queue work everywhere.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/mail](../mail/README.md), [@miujs/files](../files/README.md), [@miujs/realtime](../realtime/README.md)
