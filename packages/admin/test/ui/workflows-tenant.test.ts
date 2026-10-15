// Workflows built in the admin UI belong to the organization they were built in. Before this,
// admin_workflows was app-wide: an org admin (an org role with workflows:manage) could publish a
// workflow that fired on every organization's events, edit or unpublish another org's
// workflow, read other orgs' runs, and drive actions (crm.create_task) into another org by
// writing its id in the params.

import { beforeEach, describe, expect, test } from "bun:test";
import { t } from "miujs";
import { defineAction, defineWorkflow, manual, type WorkflowSpec } from "@miujs/workflows";
import { uiResources } from "./fixtures.ts";
import { uiSetup, type UiHarness } from "./harness.ts";

const told: string[] = [];
const tell = defineAction("tell", { params: t.object({ text: t.string() }), retries: 0, run: (p) => void told.push(p.text) });
const scoped = defineAction("scoped_write", { params: t.object({ orgId: t.string(), text: t.string() }), retries: 0, run: (p) => void told.push(`${p.orgId}:${p.text}`) });

let h: UiHarness;
beforeEach(async () => {
  told.length = 0;
  h = await uiSetup(uiResources(), {
    ui: { workflows: { actions: [tell, scoped] } },
    workflows: [defineWorkflow("code-flow", { trigger: manual(), run: () => {} })],
  });
});

const publishAs = async (user: string, spec: WorkflowSpec) => {
  expect((await h.req("POST", "/admin/api/workflows", { body: { spec }, user })).status).toBe(200);
  expect((await h.req("POST", `/admin/api/workflows/${spec.name}/publish`, { body: { version: 1 }, user })).status).toBe(200);
};

const greet: WorkflowSpec = {
  name: "greet",
  trigger: { type: "event", event: "contacts.created" },
  steps: [{ id: "say", type: "action", action: "tell", params: { text: "Hello {{ data.record.name }}" } }],
};

describe("UI workflows are scoped to their organization", () => {
  test("another org cannot see, edit, overwrite, publish or unpublish it", async () => {
    await publishAs("ann", greet);
    const list = await h.req("GET", "/admin/workflows", { user: "eve" });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("/admin/workflows/edit/greet");
    expect((await h.req("GET", "/admin/workflows/edit/greet", { user: "eve" })).status).toBe(404);
    expect((await h.req("POST", "/admin/api/workflows", { body: { spec: { ...greet, trigger: { type: "manual" } } }, user: "eve" })).status).toBe(409);
    expect((await h.req("POST", "/admin/api/workflows/greet/publish", { body: { version: 1 }, user: "eve" })).status).toBe(404);
    expect((await h.req("POST", "/admin/api/workflows/greet/unpublish", { body: {}, user: "eve" })).status).toBe(404);
    expect((await h.req("POST", "/admin/workflows/unpublish/greet", { form: {}, user: "eve" })).status).toBe(404);
    // Still published, still org A's version 1.
    await h.req("POST", "/api/contacts", { body: { name: "Al" } });
    await h.settle();
    expect(told).toEqual(["Hello Al"]);
  });

  test("an org's event workflow never sees other organizations' events", async () => {
    await publishAs("ann", greet);
    expect((await h.req("POST", "/api/contacts", { body: { name: "Bea" }, user: "eve" })).status).toBe(201);
    expect((await h.req("POST", "/api/contacts", { body: { name: "Al" } })).status).toBe(201);
    await h.settle();
    expect(told).toEqual(["Hello Al"]);
  });

  test("wait_for_event only resumes on the owning org's events", async () => {
    await publishAs("ann", {
      name: "then-company",
      trigger: { type: "event", event: "contacts.created" },
      steps: [
        { id: "company", type: "wait_for_event", event: "companies.created", timeout: "1d" },
        { id: "say", type: "action", action: "tell", params: { text: "company {{ steps.company.output.data.record.name }}" } },
      ],
    });
    await h.req("POST", "/api/contacts", { body: { name: "Al" } });
    await h.app.drain();
    for (let i = 0; i < 20 && (await h.wf.listRuns({ workflow: "then-company" }))[0]?.status !== "waiting"; i++) await new Promise((r) => setTimeout(r, 1));
    const [run] = await h.wf.listRuns({ workflow: "then-company" });
    expect(run.status).toBe("waiting");
    await h.req("POST", "/api/companies", { body: { name: "Other Org Inc" }, user: "eve" });
    await h.app.drain();
    await h.req("POST", "/api/companies", { body: { name: "Acme" } });
    await h.settle();
    expect(told).toEqual(["company Acme"]);
  });

  test("actions that take an orgId can only target the owning org", async () => {
    await publishAs("ann", { name: "cross", trigger: { type: "manual" }, steps: [{ id: "w", type: "action", action: "scoped_write", params: { orgId: h.orgB, text: "x" } }] });
    await publishAs("ann", { name: "own", trigger: { type: "manual" }, steps: [{ id: "w", type: "action", action: "scoped_write", params: { orgId: h.orgA, text: "y" } }] });
    const bad = await h.wf.start("cross", {});
    await h.wf.start("own", {});
    await h.settle();
    expect(told).toEqual([`${h.orgA}:y`]);
    expect((await h.wf.getRun(bad.id)).status).toBe("failed");
  });

  test("runs of another org's workflow, and of code workflows, are not shown to an org", async () => {
    await publishAs("ann", { name: "mine", trigger: { type: "manual" }, steps: [{ id: "nap", type: "wait", duration: "2d" }] });
    const run = await h.wf.start("mine", {});
    const code = await h.wf.start("code-flow", {});
    await h.settle();
    expect((await h.req("GET", "/admin/workflows/runs/mine")).status).toBe(200);
    expect((await h.req("GET", `/admin/workflows/run/${run.id}`)).status).toBe(200);
    expect((await h.req("GET", "/admin/workflows/runs/mine", { user: "eve" })).status).toBe(404);
    expect((await h.req("GET", `/admin/workflows/run/${run.id}`, { user: "eve" })).status).toBe(404);
    expect((await h.req("POST", `/admin/workflows/run/${run.id}/cancel`, { form: {}, user: "eve" })).status).toBe(404);
    expect((await h.wf.getRun(run.id)).status).not.toBe("cancelled");
    expect((await h.req("GET", "/admin/workflows/runs/code-flow", { user: "eve" })).status).toBe(404);
    expect((await h.req("GET", `/admin/workflows/run/${code.id}`, { user: "eve" })).status).toBe(404);
  });
});
