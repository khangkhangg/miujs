import { beforeEach, describe, expect, test } from "bun:test";
import { policy } from "@miujs/access";
import { field, resource } from "../src/index.ts";
import { setup, type Harness } from "./helpers.ts";

const companies = resource("companies", {
  fields: { name: field.text({ required: true, searchable: true }) },
  tenant: "org",
  search: true,
});
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true, searchable: true }),
    email: field.email({ unique: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    stage: field.select(["lead", "lost"], { default: "lead" }),
    owner: field.user({ default: "currentUser" }),
  },
  tenant: "org",
  softDelete: true,
  search: true,
  actions: {
    markLost: {
      run: async ({ records, data }) => {
        for (const r of records) await data("contacts").update(r.id, { stage: "lost" });
        return { marked: records.length };
      },
    },
  },
});

let h: Harness;
let a: { company: string; contact: string };
let b: { company: string; contact: string };

beforeEach(async () => {
  h = await setup([companies, contacts], { policies: [policy("contacts", { update: ({ user, record, can }) => record.owner === user.id || can("contacts:manage") })] });
  const ca = (await h.req("POST", "/api/companies", { user: "ann", body: { name: "Alpha Co" } })).body;
  const pa = (await h.req("POST", "/api/contacts", { user: "ann", body: { name: "Alpha Person", email: "same@x.io", company: ca.id } })).body;
  const cb = (await h.req("POST", "/api/companies", { user: "eve", body: { name: "Beta Co" } })).body;
  const pb = (await h.req("POST", "/api/contacts", { user: "eve", body: { name: "Beta Person", email: "same@x.io", company: cb.id } })).body;
  a = { company: ca.id, contact: pa.id };
  b = { company: cb.id, contact: pb.id };
  expect([pa.id, pb.id].every(Boolean)).toBe(true);
});

const rowOf = (h: Harness, id: string) => h.db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<Record<string, unknown>>();

describe("tenant isolation: org A can never see or touch org B", () => {
  test("unique values are per org", () => {
    // Both orgs created "same@x.io" in beforeEach.
    expect(a.contact).not.toBe(b.contact);
  });

  test("list, search, filters and views only return own rows", async () => {
    for (const qs of ["", "?q=beta", "?q=person", `?filter=${encodeURIComponent(JSON.stringify({ id: b.contact }))}`, `?id=${b.contact}`, `?company=${b.company}`]) {
      const res = await h.req("GET", `/api/contacts${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((r: { id: string }) => r.id)).not.toContain(b.contact);
    }
    expect((await h.req("GET", "/api/contacts")).body.items.map((r: { name: string }) => r.name)).toEqual(["Alpha Person"]);
  });

  test("a cursor cannot pull rows from another org", async () => {
    const res = await h.req("GET", "/api/contacts?limit=1&sort=name", { user: "eve" });
    const leaked = await h.req("GET", `/api/contacts?limit=10&sort=name&cursor=${res.body.nextCursor ?? ""}`);
    expect(leaked.body.items.map((r: { id: string }) => r.id)).not.toContain(b.contact);
  });

  test("get / patch / delete of another org's id are 404 and change nothing", async () => {
    expect((await h.req("GET", `/api/contacts/${b.contact}`)).status).toBe(404);
    expect((await h.req("PATCH", `/api/contacts/${b.contact}`, { body: { name: "pwned" } })).status).toBe(404);
    expect((await h.req("DELETE", `/api/contacts/${b.contact}`)).status).toBe(404);
    expect((await h.req("DELETE", `/api/companies/${b.company}`)).status).toBe(404);
    const row = await rowOf(h, b.contact);
    expect(row).toMatchObject({ name: "Beta Person", deleted_at: null });
    expect(await h.db.prepare("SELECT id FROM companies WHERE id = ?").bind(b.company).first()).not.toBeNull();
  });

  test("cannot link a record to another org's record (create and update)", async () => {
    const res = await h.req("POST", "/api/contacts", { body: { name: "X", company: b.company } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MIU_E_ADMIN_RELATION_INVALID");
    const upd = await h.req("PATCH", `/api/contacts/${a.contact}`, { body: { company: b.company } });
    expect(upd.status).toBe(400);
    expect((await rowOf(h, a.contact))!.company).toBe(a.company);
  });

  test("include never embeds another org's record", async () => {
    // Even if a row were linked across orgs at the SQL level, include stays scoped.
    await h.db.prepare("UPDATE contacts SET company = ? WHERE id = ?").bind(b.company, a.contact).run();
    const res = await h.req("GET", "/api/contacts?include=company");
    expect(res.body.items[0]._included).toEqual({ company: null });
    const one = await h.req("GET", `/api/contacts/${a.contact}?include=company`);
    expect(one.body._included).toEqual({ company: null });
  });

  test("bulk update/delete with a foreign id writes nothing at all", async () => {
    for (const body of [
      { action: "update", ids: [a.contact, b.contact], changes: { stage: "lost" } },
      { action: "delete", ids: [a.contact, b.contact] },
      { action: "delete", ids: [b.contact] },
    ]) {
      const res = await h.req("POST", "/api/contacts/bulk", { body });
      expect(res.status).toBe(404);
    }
    expect(await rowOf(h, a.contact)).toMatchObject({ stage: "lead", deleted_at: null });
    expect(await rowOf(h, b.contact)).toMatchObject({ stage: "lead", deleted_at: null });
  });

  test("actions refuse foreign ids", async () => {
    const res = await h.req("POST", "/api/contacts/actions/markLost", { body: { ids: [b.contact] } });
    expect(res.status).toBe(404);
    expect((await rowOf(h, b.contact))!.stage).toBe("lead");
  });

  test("export only contains own rows", async () => {
    const res = await h.req("GET", "/api/contacts/export.csv");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Alpha Person");
    expect(res.text).not.toContain("Beta Person");
    expect(res.text).not.toContain(b.contact);
  });

  test("import writes into the caller's org only, and cannot reference foreign records", async () => {
    const bad = await h.req("POST", "/api/contacts/import", { body: { csv: `name,company\nNew,${b.company}\nByName,Beta Co\n`, dryRun: true } });
    expect(bad.status).toBe(200);
    expect(bad.body.errors.map((e: { row: number; errors: { field: string }[] }) => [e.row, e.errors[0].field])).toEqual([
      [1, "company"],
      [2, "company"],
    ]);
    const ok = await h.req("POST", "/api/contacts/import", { body: { csv: "name,company,email\nNew,Alpha Co,same@x.io\n" } });
    // same@x.io exists in org A (and in B): refused as a duplicate in A.
    expect(ok.status).toBe(400);
    const ok2 = await h.req("POST", "/api/contacts/import", { body: { csv: "name,company,org_id,orgId\nNew,Alpha Co,x,y\n" } });
    expect(ok2.status).toBe(200);
    const row = await rowOf(h, ok2.body.ids[0]);
    expect(row).toMatchObject({ org_id: h.orgA, company: a.company, name: "New" });
  });

  test("the org comes from verified membership, never the request", async () => {
    // No org selected: no org role applies (403); a global owner still gets no unscoped query (400).
    expect((await h.req("GET", "/api/contacts", { org: null })).status).toBe(403);
    const none = await h.req("GET", "/api/contacts", { user: "root", org: null });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("MIU_E_ACCESS_NO_ORG");
    expect((await h.req("POST", "/api/contacts", { user: "root", org: null, body: { name: "x" } })).status).toBe(400);
    expect((await h.req("POST", "/api/contacts/bulk", { user: "root", org: null, body: { action: "delete", ids: [b.contact] } })).status).toBe(400);
    // Selecting an org you do not belong to: 403 before any query.
    const foreign = await h.req("GET", "/api/contacts", { user: "ann", org: h.orgB });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("MIU_E_ACCESS_NOT_MEMBER");
    const zed = await h.req("POST", "/api/contacts", { user: "zed", org: h.orgA, body: { name: "x" } });
    expect(zed.status).toBe(403);
  });

  test("events and audit entries carry the right org", async () => {
    await h.settle();
    const created = h.events.filter((e) => e.event === "contacts.created");
    expect(created.map((e) => [e.data.record.name, e.data.orgId])).toEqual([
      ["Alpha Person", h.orgA],
      ["Beta Person", h.orgB],
    ]);
    const auditB = await h.auditStore.query({ resource: "contacts", resourceId: b.contact });
    expect(auditB.items[0].org).toBe(h.orgB);
  });
});

describe("row-level policies", () => {
  test("update needs owner (policy) even with the role permission", async () => {
    const res = await h.req("PATCH", `/api/contacts/${a.contact}`, { user: "bob", body: { name: "Bob's now" } });
    expect(res.status).toBe(403);
    expect((await rowOf(h, a.contact))!.name).toBe("Alpha Person");
    const mine = (await h.req("POST", "/api/contacts", { user: "bob", body: { name: "Bob's" } })).body;
    expect((await h.req("PATCH", `/api/contacts/${mine.id}`, { user: "bob", body: { name: "Bob's 2" } })).status).toBe(200);
  });

  test("read policies filter list, get and export", async () => {
    const h2 = await setup([companies, contacts], { policies: [policy("contacts", { read: ({ user, record, can }) => record.owner === user.id || can("contacts:manage") })] });
    const annRec = (await h2.req("POST", "/api/contacts", { user: "ann", body: { name: "Ann's" } })).body;
    const bobRec = (await h2.req("POST", "/api/contacts", { user: "bob", body: { name: "Bob's" } })).body;
    const names = async (user: string) => (await h2.req("GET", "/api/contacts?sort=name", { user })).body.items.map((r: { name: string }) => r.name);
    expect(await names("bob")).toEqual(["Bob's"]);
    expect(await names("ann")).toEqual(["Ann's", "Bob's"]);
    expect((await h2.req("GET", `/api/contacts/${annRec.id}`, { user: "bob" })).status).toBe(403);
    expect((await h2.req("GET", `/api/contacts/${bobRec.id}`, { user: "bob" })).status).toBe(200);
    expect((await h2.req("GET", "/api/contacts/export.csv", { user: "ann" })).text).toContain("Bob's");
  });

  test("create policies see the new record (e.g. no assigning to others)", async () => {
    const h2 = await setup([companies, contacts], { policies: [policy("contacts", { create: ({ user, record, can }) => record.owner === user.id || can("contacts:assign") })] });
    expect((await h2.req("POST", "/api/contacts", { user: "bob", body: { name: "Mine" } })).status).toBe(201);
    const res = await h2.req("POST", "/api/contacts", { user: "bob", body: { name: "Theirs", owner: "ann" } });
    expect(res.status).toBe(403);
    expect((await h2.req("POST", "/api/contacts/import", { user: "ann", body: { csv: "name,owner\nX,bob\n" } })).status).toBe(200);
    expect((await h2.db.prepare("SELECT count(*) AS n FROM contacts WHERE name = 'Theirs'").first<{ n: number }>())!.n).toBe(0);
  });

  test("bulk checks the policy on every record before writing any", async () => {
    const mine = (await h.req("POST", "/api/contacts", { user: "bob", body: { name: "Bob's" } })).body;
    const res = await h.req("POST", "/api/contacts/bulk", { user: "bob", body: { action: "update", ids: [mine.id, a.contact], changes: { stage: "lost" } } });
    expect(res.status).toBe(403);
    expect((await rowOf(h, mine.id))!.stage).toBe("lead");
  });

  test("actions check their permission against each record", async () => {
    const res = await h.req("POST", "/api/contacts/actions/markLost", { user: "bob", body: { ids: [a.contact] } });
    expect(res.status).toBe(403);
    expect((await rowOf(h, a.contact))!.stage).toBe("lead");
    const ok = await h.req("POST", "/api/contacts/actions/markLost", { user: "ann", body: { ids: [a.contact] } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ action: "markLost", count: 1, result: { marked: 1 } });
    expect((await rowOf(h, a.contact))!.stage).toBe("lost");
  });
});
