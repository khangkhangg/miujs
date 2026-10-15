import { beforeEach, describe, expect, test } from "bun:test";
import { t } from "miujs";
import { defineAction, defineWorkflow, manual, type WorkflowSpec } from "@miujs/workflows";
import { uiResources } from "./fixtures.ts";
import { XSS, expectNoXss, uiSetup, type UiHarness } from "./harness.ts";

const told: string[] = [];
const tell = defineAction("tell", { description: "Record a message", params: t.object({ text: t.string(), times: t.optional(t.integer({ min: 1 })) }), retries: 0, run: (p) => void told.push(p.text) });
const boom = defineAction("boom", { params: t.object({}), retries: 0, run: () => {
  throw new Error("kaboom");
} });

let h: UiHarness;
beforeEach(async () => {
  told.length = 0;
  h = await uiSetup(uiResources(), {
    ui: { workflows: { actions: [tell, boom] } },
    workflows: [defineWorkflow("code-flow", { description: "From code", trigger: manual(), run: () => {} })],
  });
});

const spec = (o: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  name: "greet-leads",
  trigger: { type: "event", event: "contacts.created" },
  steps: [
    {
      id: "is_lead",
      type: "condition",
      if: "data.record.stage == 'lead'",
      then: [{ id: "say", type: "action", action: "tell", params: { text: "Hello {{ data.record.name }}" } }],
    },
  ],
  ...o,
});

describe("workflow API for the builder", () => {
  test("validate returns precise issues with paths and fixes", async () => {
    const bad = spec({ steps: [{ id: "x", type: "condition", if: "data.a ==", then: [{ id: "w", type: "wait", duration: "soon" }] }] as any });
    const r = await h.req("POST", "/admin/api/workflows/validate", { body: { spec: bad } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.issues.map((i: any) => i.path)).toEqual(["steps.0.if", "steps.0.then.0.duration"]);
    expect(r.body.issues[0].fix).toBeTruthy();
    expect((await h.req("POST", "/admin/api/workflows/validate", { body: { spec: spec() } })).body).toEqual({ ok: true, issues: [] });
  });

  test("save refuses invalid specs (400 with issues) and stores valid ones as new versions", async () => {
    const bad = await h.req("POST", "/admin/api/workflows", { body: { spec: { name: "x", trigger: { type: "manual" }, steps: [{ id: "a", type: "action", action: "nope" }] } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0]).toMatchObject({ path: "steps.0.action" });
    const v1 = await h.req("POST", "/admin/api/workflows", { body: { spec: spec() } });
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ name: "greet-leads", version: 1, status: "draft" });
    expect((await h.req("POST", "/admin/api/workflows", { body: { spec: spec() } })).body.version).toBe(2);
  });

  test("names of code-defined workflows are taken", async () => {
    const r = await h.req("POST", "/admin/api/workflows", { body: { spec: spec({ name: "code-flow" }) } });
    expect(r.status).toBe(409);
    expect(r.body.error.details.issues[0].path).toBe("name");
  });

  test("only published versions run, and they run through the engine", async () => {
    await h.req("POST", "/admin/api/workflows", { body: { spec: spec() } });
    await h.req("POST", "/api/contacts", { body: { name: "Draft time", stage: "lead" } });
    await h.settle();
    expect(told).toEqual([]);
    const pub = await h.req("POST", "/admin/api/workflows/greet-leads/publish", { body: { version: 1 } });
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual({ name: "greet-leads", published: 1 });
    await h.req("POST", "/api/contacts", { body: { name: "Ann", stage: "lead" } });
    await h.req("POST", "/api/contacts", { body: { name: "Cust", stage: "customer" } });
    await h.settle();
    expect(told).toEqual(["Hello Ann"]);
    await h.req("POST", "/admin/api/workflows/greet-leads/unpublish", { body: {} });
    await h.req("POST", "/api/contacts", { body: { name: "Later", stage: "lead" } });
    await h.settle();
    expect(told).toEqual(["Hello Ann"]);
  });

  test("publishing a missing version is a 404", async () => {
    expect((await h.req("POST", "/admin/api/workflows/nope/publish", { body: { version: 3 } })).status).toBe(404);
  });

  test("permissions: workflows:manage to edit, workflows:read to view", async () => {
    expect((await h.req("POST", "/admin/api/workflows", { body: { spec: spec() }, user: "wren" })).status).toBe(403);
    expect((await h.req("POST", "/admin/api/workflows/validate", { body: { spec: spec() }, user: "wren" })).status).toBe(200);
    expect((await h.req("POST", "/admin/api/workflows/validate", { body: { spec: spec() }, user: "bob" })).status).toBe(403);
    await h.req("POST", "/admin/api/workflows", { body: { spec: spec() } });
    expect((await h.req("GET", "/admin/workflows", { user: "wren" })).status).toBe(200);
    expect((await h.req("GET", "/admin/workflows", { user: "bob" })).status).toBe(403);
    expect((await h.req("GET", "/admin/workflows/new", { user: "wren" })).status).toBe(403);
    const view = await h.req("GET", "/admin/workflows/edit/greet-leads", { user: "wren" });
    expect(view.status).toBe(200);
    expect(view.text).toContain('data-can-edit="false"');
    expect(view.text).not.toContain("data-save>");
    expect(view.text).toContain('<span class="badge">draft</span>');
    expect((await h.req("POST", "/admin/workflows/publish/greet-leads", { form: { version: "1" }, user: "wren" })).status).toBe(403);
  });
});

describe("workflow pages", () => {
  test("list shows saved workflows with their published version, and code workflows read-only", async () => {
    await h.req("POST", "/admin/api/workflows", { body: { spec: spec({ description: XSS }) } });
    await h.req("POST", "/admin/api/workflows/greet-leads/publish", { body: { version: 1 } });
    const r = await h.req("GET", "/admin/workflows");
    expectNoXss(r.text);
    expect(r.text).toContain('<a href="/admin/workflows/edit/greet-leads">greet-leads</a>');
    expect(r.text).toContain("v1</span>");
    expect(r.text).toContain("code-flow");
    expect(r.text).toContain('href="/admin/workflows/new"');
    expect(r.text).toContain('<a href="/admin/workflows" aria-current="page">Workflows</a>');
  });

  test("the editor carries the spec, actions (with param schemas) and resource events", async () => {
    const r = await h.req("GET", "/admin/workflows/new");
    expect(r.status).toBe(200);
    expect(r.text).toContain("data-workflow-builder");
    expect(r.text).toContain("&quot;name&quot;:&quot;tell&quot;");
    expect(r.text).toContain("&quot;contacts.created&quot;");
    expect(r.text).toContain('data-save-url="/admin/api/workflows"');
    expect(r.text).toContain('<label for="wf-json">');
  });

  test("the JSON form saves without JavaScript and shows issues by step", async () => {
    const bad = spec({ steps: [{ id: "first", type: "wait", duration: "1h" }, { id: "second", type: "action", action: "tell", params: {} }] as any });
    const r = await h.req("POST", "/admin/workflows/save", { form: { json: JSON.stringify(bad) } });
    expect(r.status).toBe(400);
    expect(r.text).toContain('data-issue-path="steps.1"');
    expect(r.text).toContain("<strong>Step second</strong>");
    const broken = await h.req("POST", "/admin/workflows/save", { form: { json: "{nope" } });
    expect(broken.status).toBe(400);
    expect(broken.text).toContain("The JSON could not be read");
    const ok = await h.req("POST", "/admin/workflows/save", { form: { json: JSON.stringify(spec()), publish: "1" } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/admin/workflows/edit/greet-leads?done=published");
    const edit = await h.req("GET", "/admin/workflows/edit/greet-leads");
    expect(edit.text).toContain("Versions");
    expect(edit.text).toContain('action="/admin/workflows/unpublish/greet-leads"');
  });

  test("runs list and run timeline with status, durations and errors; retry and cancel", async () => {
    const failing: WorkflowSpec = { name: "fails", trigger: { type: "manual" }, steps: [{ id: "explode", type: "action", action: "boom", params: {} }] };
    await h.req("POST", "/admin/api/workflows", { body: { spec: failing } });
    await h.req("POST", "/admin/api/workflows/fails/publish", { body: { version: 1 } });
    const started = await h.req("POST", "/workflows/fails/runs", { body: {} });
    expect(started.status).toBe(201);
    await h.settle();
    const list = await h.req("GET", "/admin/workflows/runs/fails");
    expect(list.text).toContain('<span class="status failed">failed</span>');
    expect(list.text).toContain("kaboom");
    const runId = started.body.id;
    const run = await h.req("GET", `/admin/workflows/run/${runId}`);
    expect(run.text).toContain("<td>explode</td>");
    expect(run.text).toContain("kaboom");
    expect(run.text).toContain(`action="/admin/workflows/run/${runId}/retry"`);
    const retry = await h.req("POST", `/admin/workflows/run/${runId}/retry`, { form: {} });
    expect(retry.status).toBe(303);
    expect(retry.headers.get("location")).toBe(`/admin/workflows/run/${runId}?done=retry`);

    const waiting: WorkflowSpec = { name: "waits", trigger: { type: "manual" }, steps: [{ id: "nap", type: "wait", duration: "2d" }] };
    await h.req("POST", "/admin/api/workflows", { body: { spec: waiting } });
    await h.req("POST", "/admin/api/workflows/waits/publish", { body: { version: 1 } });
    const w = await h.req("POST", "/workflows/waits/runs", { body: {} });
    await h.app.drain();
    const page = await h.req("GET", `/admin/workflows/run/${w.body.id}`);
    expect(page.text).toContain(`action="/admin/workflows/run/${w.body.id}/cancel"`);
    const cancel = await h.req("POST", `/admin/workflows/run/${w.body.id}/cancel`, { form: {} });
    expect(cancel.status).toBe(303);
    expect((await h.req("GET", `/workflows/runs/${w.body.id}`)).body.status).toBe("cancelled");
  });

  test("cancel and retry are refused without workflows:manage (enforced by the workflows routes)", async () => {
    const r = await h.req("POST", "/admin/workflows/run/whatever/cancel", { form: {}, user: "wren" });
    expect(r.status).toBe(403);
  });
});
