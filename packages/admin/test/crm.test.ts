import { beforeEach, describe, expect, test } from "bun:test";
import { validateSpec } from "@miujs/workflows";
import { activities, companies, contacts, crm, crmResources, dealWonNotifyOwnerSpec, deals, newLeadFollowUpSpec, tasks, timeline } from "../src/crm.ts";
import { adminMigrations } from "../src/index.ts";
import { setup, type Harness } from "./helpers.ts";
import { sqlite } from "@miujs/db";

describe("CRM resources", () => {
  test("five tenant-scoped, soft-deleting, searchable resources", () => {
    expect([companies, contacts, deals, activities, tasks].map((r) => [r.name, r.tenant, r.softDelete])).toEqual([
      ["companies", "org", true],
      ["contacts", "org", true],
      ["deals", "org", true],
      ["activities", "org", true],
      ["tasks", "org", true],
    ]);
    expect(Object.keys(contacts.fields)).toEqual(["name", "email", "phone", "company", "stage", "value", "tags", "notes", "nextFollowUp", "owner"]);
    expect(deals.fields.stage.options.choices!.map((c) => [c.value, c.probability])).toEqual([
      ["lead", 10],
      ["qualified", 25],
      ["proposal", 50],
      ["negotiation", 75],
      ["won", 100],
      ["lost", 0],
    ]);
    expect(Object.keys(deals.views)).toEqual(["pipeline", "closingSoon"]);
    expect(activities.fields.type.options.choices!.map((c) => c.value)).toEqual(["call", "email", "meeting", "note"]);
    expect(adminMigrations(crmResources()).map((m) => m.id)).toEqual(["admin_001_companies", "admin_001_contacts", "admin_001_deals", "admin_001_activities", "admin_001_tasks", "admin_system_001_settings"]);
  });

  test("currency is configurable", () => {
    const rs = crmResources({ currency: "EUR" });
    expect(rs.find((r) => r.name === "deals")!.fields.amount.options.currency).toBe("EUR");
  });

  test("workflow specs are valid", () => {
    const kit = crm({ database: sqlite() });
    expect(validateSpec(newLeadFollowUpSpec, { actions: kit.actions })).toMatchObject({ ok: true });
    expect(validateSpec(dealWonNotifyOwnerSpec, { actions: kit.actions })).toMatchObject({ ok: true });
    expect(kit.workflows.map((w) => w.name)).toEqual(["crm-new-lead-follow-up", "crm-deal-won-notify-owner"]);
  });
});

describe("crm() wired into an app", () => {
  let h: Harness;
  let kit: ReturnType<typeof crm>;
  beforeEach(async () => {
    kit = crm({});
    // The kit is the admin plugin; its workflows go to the app's workflows() plugin.
    h = await setup([], { workflows: kit.workflows, plugins: [], admin: {}, record: ["tasks.created", "deals.updated"], crm: kit });
  });

  const tasksOf = async () => (await h.req("GET", "/api/tasks?sort=title")).body.items as Record<string, any>[];

  test("deal stage sets probability and closedAt", async () => {
    const d = (await h.req("POST", "/api/deals", { body: { title: "Big", amount: 500000, stage: "qualified" } })).body;
    expect(d).toMatchObject({ probability: 25, closedAt: null, owner: "ann" });
    const won = (await h.req("PATCH", `/api/deals/${d.id}`, { body: { stage: "won" } })).body;
    expect(won.probability).toBe(100);
    expect(new Date(won.closedAt).getTime()).toBeGreaterThan(0);
    const custom = (await h.req("PATCH", `/api/deals/${d.id}`, { body: { stage: "negotiation", probability: 60 } })).body;
    expect(custom).toMatchObject({ probability: 60, closedAt: null });
    expect((await h.req("GET", "/api/deals?view=pipeline")).status).toBe(200);
  });

  test("tasks: done sets completedAt", async () => {
    const t1 = (await h.req("POST", "/api/tasks", { body: { title: "Call", due: "2026-03-03" } })).body;
    expect(t1).toMatchObject({ status: "open", assignee: "ann", completedAt: null });
    const done = (await h.req("PATCH", `/api/tasks/${t1.id}`, { body: { status: "done" } })).body;
    expect(done.completedAt).not.toBeNull();
    expect((await h.req("PATCH", `/api/tasks/${t1.id}`, { body: { status: "open" } })).body.completedAt).toBeNull();
  });

  test("activities link to any record, only in the same org", async () => {
    const c = (await h.req("POST", "/api/contacts", { body: { name: "Ann" } })).body;
    const ok = await h.req("POST", "/api/activities", { body: { type: "call", subject: "Intro call", subjectType: "contacts", subjectId: c.id } });
    expect(ok.status).toBe(201);
    const missing = await h.req("POST", "/api/activities", { body: { type: "call", subject: "x", subjectType: "deals", subjectId: c.id } });
    expect([missing.status, missing.body.error.code]).toEqual([400, "MIU_E_ADMIN_RELATION_INVALID"]);
    const foreign = await h.req("POST", "/api/activities", { user: "eve", body: { type: "note", subject: "x", subjectType: "contacts", subjectId: c.id } });
    expect(foreign.status).toBe(400);
    const moved = await h.req("PATCH", `/api/activities/${ok.body.id}`, { body: { subjectType: "companies" } });
    expect(moved.status).toBe(400);
  });

  test("timeline merges activities and audit entries, newest first, scoped", async () => {
    const c = (await h.req("POST", "/api/contacts", { body: { name: "Ann", stage: "qualified" } })).body;
    await h.req("POST", "/api/activities", { body: { type: "call", subject: "Intro", subjectType: "contacts", subjectId: c.id, occurredAt: "2030-01-01T10:00:00Z" } });
    await h.req("PATCH", `/api/contacts/${c.id}`, { body: { stage: "customer" } });
    const res = await h.req("GET", `/api/crm/timeline/contacts/${c.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { kind: string; title: string }) => [e.kind, e.title])).toEqual([
      ["activity", "Intro"],
      ["audit", "update"],
      ["audit", "create"],
    ]);
    const upd = res.body.items[1];
    expect(upd.changes.stage).toEqual({ before: "qualified", after: "customer" });
    expect(upd).not.toHaveProperty("ip");
    // Other orgs and unknown resources: nothing.
    expect((await h.req("GET", `/api/crm/timeline/contacts/${c.id}`, { user: "eve" })).status).toBe(404);
    expect((await h.req("GET", `/api/crm/timeline/nope/${c.id}`)).status).toBe(400);
    // The helper works without HTTP.
    const entries = await timeline({ resource: "contacts", id: c.id }, { data: kit.data({ orgId: h.orgA }), orgId: h.orgA });
    expect(entries.map((e) => e.kind)).toEqual(["activity"]);
  });

  test("workflow: a new lead gets a follow-up task due tomorrow; others do not", async () => {
    const lead = (await h.req("POST", "/api/contacts", { user: "bob", body: { name: "Lena Lead" } })).body;
    await h.req("POST", "/api/contacts", { body: { name: "Cora Customer", stage: "customer" } });
    await h.settle();
    const ts = await tasksOf();
    expect(ts).toHaveLength(1);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(ts[0]).toMatchObject({ title: "Follow up with Lena Lead", assignee: "bob", subjectType: "contacts", subjectId: lead.id, status: "open", due: tomorrow, createdBy: null });
    // Org B sees none of it.
    expect((await h.req("GET", "/api/tasks", { user: "eve" })).body.items).toEqual([]);
  });

  test("workflow: deal won notifies the owner once", async () => {
    const d = (await h.req("POST", "/api/deals", { user: "bob", body: { title: "Mega", amount: 100 } })).body;
    await h.req("PATCH", `/api/deals/${d.id}`, { user: "bob", body: { stage: "won" } });
    await h.settle();
    await h.req("PATCH", `/api/deals/${d.id}`, { user: "bob", body: { amount: 200 } });
    await h.settle();
    const ts = await tasksOf();
    expect(ts.map((x) => [x.title, x.assignee, x.priority, x.subjectId])).toEqual([["Deal won: Mega", "bob", "high", d.id]]);
  });

  test("custom notify replaces the default", async () => {
    const sent: unknown[] = [];
    const kit2 = crm({ notify: async (n) => void sent.push(n) });
    const h2 = await setup([], { workflows: kit2.workflows, crm: kit2 });
    const d = (await h2.req("POST", "/api/deals", { body: { title: "Mega" } })).body;
    await h2.req("PATCH", `/api/deals/${d.id}`, { body: { stage: "won" } });
    await h2.settle();
    expect(sent).toEqual([expect.objectContaining({ orgId: h2.orgA, userId: "ann", subject: "Deal won: Mega", subjectType: "deals", subjectId: d.id })]);
    expect((await h2.req("GET", "/api/tasks")).body.items).toEqual([]);
  });
});
