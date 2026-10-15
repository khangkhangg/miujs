// Adversarial checks of the resource API: row-level policies through relations, mass
// assignment, filter/sort injection, cross-tenant ids in bulk and import.

import { describe, expect, test } from "bun:test";
import { policy } from "@miujs/access";
import { field, resource } from "../src/index.ts";
import { setup } from "./helpers.ts";

const companies = resource("companies", {
  fields: { name: field.text({ required: true, searchable: true }) },
  tenant: "org",
});
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true, searchable: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    owner: field.user({ default: "currentUser" }),
    secret: field.text({ readOnly: true }),
  },
  tenant: "org",
  softDelete: true,
});
const deals = resource("deals", {
  fields: { title: field.text({ required: true }), contact: field.relation("contacts", { onDelete: "set null" }) },
  tenant: "org",
});

const ownOnly = policy("contacts", { read: ({ user, record, can }) => (record as { owner?: unknown }).owner === user.id || can("contacts:manage") });

describe("row-level read policies apply to related records", () => {
  test("include does not embed a related record the policy hides", async () => {
    const h = await setup([companies, contacts, deals], { policies: [ownOnly] });
    const hidden = (await h.req("POST", "/api/contacts", { user: "ann", body: { name: "Ann's private contact" } })).body;
    const deal = (await h.req("POST", "/api/deals", { user: "ann", body: { title: "Shared deal", contact: hidden.id } })).body;
    // bob may read deals and contacts (role), but the policy hides ann's contact from him.
    expect((await h.req("GET", `/api/contacts/${hidden.id}`, { user: "bob" })).status).toBe(403);
    const list = await h.req("GET", "/api/deals?include=contact", { user: "bob" });
    expect(list.status).toBe(200);
    expect(list.body.items[0]._included.contact).toBeNull();
    expect(list.text).not.toContain("Ann's private contact");
    const one = await h.req("GET", `/api/deals/${deal.id}?include=contact`, { user: "bob" });
    expect(one.body._included.contact).toBeNull();
    // ann sees it.
    expect((await h.req("GET", `/api/deals/${deal.id}?include=contact`, { user: "ann" })).body._included.contact.name).toBe("Ann's private contact");
  });
});

describe("mass assignment and injection", () => {
  test("ids, org, system and read-only fields in a body are ignored", async () => {
    const h = await setup([companies, contacts, deals]);
    const res = await h.req("POST", "/api/contacts", {
      body: { name: "X", id: "chosen", orgId: h.orgB, org_id: h.orgB, createdBy: "eve", created_by: "eve", deletedAt: 1, deleted_at: 1, secret: "set by client" },
    });
    expect(res.status).toBe(201);
    const row = await h.db.prepare("SELECT * FROM contacts WHERE id = ?").bind(res.body.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ org_id: h.orgA, created_by: "ann", deleted_at: null, secret: null });
    expect(res.body.id).not.toBe("chosen");
    const patch = await h.req("PATCH", `/api/contacts/${res.body.id}`, { body: { orgId: h.orgB, org_id: h.orgB, secret: "x", createdBy: "eve" } });
    expect(patch.status).toBe(200);
    expect(await h.db.prepare("SELECT org_id, secret, created_by FROM contacts WHERE id = ?").bind(res.body.id).first()).toEqual({ org_id: h.orgA, secret: null, created_by: "ann" });
  });

  test("filters and sorts only accept known fields and operators; LIKE wildcards are literal", async () => {
    const h = await setup([companies, contacts, deals]);
    await h.req("POST", "/api/contacts", { body: { name: "100% real" } });
    await h.req("POST", "/api/contacts", { body: { name: "abc" } });
    await h.req("POST", "/api/contacts", { user: "eve", body: { name: "B's 100%" } });
    const bad = [
      `filter=${encodeURIComponent(JSON.stringify({ orgId: h.orgB }))}`,
      `filter=${encodeURIComponent(JSON.stringify({ org_id: h.orgB }))}`,
      `filter=${encodeURIComponent(JSON.stringify({ deletedAt: { isNull: false } }))}`,
      `filter=${encodeURIComponent(JSON.stringify({ name: { "1=1) OR (1": 1 } }))}`,
      `filter=${encodeURIComponent('{"__proto__":{"eq":1}}')}`,
      "sort=org_id",
      `sort=${encodeURIComponent('name"; DROP TABLE contacts; --')}`,
    ];
    for (const q of bad) expect([q, (await h.req("GET", `/api/contacts?${q}`)).status]).toEqual([q, 400]);
    // Unknown query keys are not filters (and never reach SQL).
    expect((await h.req("GET", `/api/contacts?org_id=${h.orgB}&orgId=${h.orgB}`)).body.items.map((r: { name: string }) => r.name).sort()).toEqual(["100% real", "abc"]);
    const like = await h.req("GET", `/api/contacts?filter=${encodeURIComponent(JSON.stringify({ name: { contains: "%" } }))}`);
    expect(like.body.items.map((r: { name: string }) => r.name)).toEqual(["100% real"]);
    const q = await h.req("GET", `/api/contacts?q=${encodeURIComponent("0%")}`);
    expect(q.status).toBe(200);
    expect(q.body.items.map((r: { name: string }) => r.name)).toEqual(["100% real"]);
  });

  test("bulk, actions and relations never reach another org's ids", async () => {
    const h = await setup([companies, contacts, deals]);
    const theirs = (await h.req("POST", "/api/contacts", { user: "eve", body: { name: "Beta" } })).body;
    const theirCo = (await h.req("POST", "/api/companies", { user: "eve", body: { name: "Beta Co" } })).body;
    const mine = (await h.req("POST", "/api/contacts", { body: { name: "Alpha" } })).body;
    expect((await h.req("POST", "/api/contacts/bulk", { body: { action: "delete", ids: [mine.id, theirs.id] } })).status).toBe(404);
    expect((await h.req("POST", "/api/contacts/bulk", { body: { action: "update", ids: [theirs.id], changes: { name: "pwned" } } })).status).toBe(404);
    expect((await h.req("PATCH", `/api/contacts/${mine.id}`, { body: { company: theirCo.id } })).status).toBe(400);
    expect((await h.req("POST", "/api/deals", { body: { title: "x", contact: theirs.id } })).status).toBe(400);
    // CSV import: a relation by id or by title only resolves inside the org.
    const imp = await h.req("POST", "/api/contacts/import", { body: { csv: `name,company\nA,${theirCo.id}\nB,Beta Co\n`, dryRun: true } });
    expect(imp.body.invalid).toBe(2);
    expect((await h.req("GET", `/api/contacts/${theirs.id}`)).status).toBe(404);
    expect((await h.db.prepare("SELECT name, deleted_at FROM contacts WHERE id = ?").bind(theirs.id).first())).toEqual({ name: "Beta", deleted_at: null });
  });
});

describe("crm timeline", () => {
  test("activities a read policy hides stay out of a record's timeline", async () => {
    const { crm } = await import("../src/crm.ts");
    const kit = crm({});
    const h = await setup([], { crm: kit, record: [], policies: [policy("activities", { read: ({ user, record }) => (record as { owner?: unknown }).owner === user.id })] });
    const c = (await h.req("POST", "/api/contacts", { body: { name: "Shared" } })).body;
    await h.req("POST", "/api/activities", { user: "ann", body: { type: "note", subject: "Ann's private note", subjectType: "contacts", subjectId: c.id } });
    await h.req("POST", "/api/activities", { user: "bob", body: { type: "note", subject: "Bob's note", subjectType: "contacts", subjectId: c.id } });
    const res = await h.req("GET", `/api/crm/timeline/contacts/${c.id}`, { user: "bob" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Bob's note");
    expect(res.text).not.toContain("Ann's private note");
  });
});
