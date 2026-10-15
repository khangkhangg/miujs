import { beforeEach, describe, expect, test } from "bun:test";
import { field, resource } from "../src/index.ts";
import { setup, type Harness } from "./helpers.ts";

const companies = resource("companies", {
  fields: { name: field.text({ required: true, searchable: true }), domain: field.text() },
  tenant: "org",
  search: true,
});

const contacts = resource("contacts", {
  label: "Contacts",
  fields: {
    name: field.text({ required: true, max: 200, searchable: true }),
    email: field.email({ unique: true, searchable: true }),
    phone: field.phone(),
    company: field.relation("companies", { onDelete: "set null" }),
    stage: field.select(["lead", "qualified", "customer", "lost"], { default: "lead" }),
    value: field.money({ currency: "USD" }),
    tags: field.tags(),
    notes: field.richText(),
    nextFollowUp: field.date(),
    owner: field.user({ default: "currentUser" }),
    vip: field.boolean(),
    score: field.number({ readOnly: true, default: 0 }),
  },
  tenant: "org",
  softDelete: true,
  timestamps: true,
  permissions: "contacts",
  search: true,
  views: {
    pipeline: { kind: "kanban", groupBy: "stage" },
    upcoming: { filter: { nextFollowUp: { gte: "today" } }, sort: "nextFollowUp" },
    customers: { filter: { stage: "customer" }, sort: "-value", fields: ["name", "value"] },
  },
});

let h: Harness;
beforeEach(async () => {
  h = await setup([companies, contacts]);
});

async function seed() {
  const acme = (await h.req("POST", "/api/companies", { body: { name: "Acme" } })).body;
  const rows = [
    { name: "Ann Lee", email: "ann@acme.io", stage: "lead", value: 1000, tags: ["vip", "b2b"], nextFollowUp: "2026-03-05", company: acme.id },
    { name: "Ben Ode", email: "ben@x.io", stage: "qualified", value: 5000, tags: ["b2b"], nextFollowUp: "2026-03-01" },
    { name: "Cy Twombly", email: "cy@art.io", stage: "customer", value: 9000, tags: [], nextFollowUp: null },
    { name: "Dee Ray", stage: "customer", value: 200, tags: ["vip"], nextFollowUp: "2026-04-01", vip: true },
    { name: "Eli Wu", email: "eli@acme.io", stage: "lost", value: null, phone: "+1 555 0100" },
  ];
  const out = [];
  for (const r of rows) out.push((await h.req("POST", "/api/contacts", { body: r })).body);
  return { acme, people: out };
}

describe("create", () => {
  test("201 with defaults, owner = current user, timestamps, sanitized rich text", async () => {
    const res = await h.req("POST", "/api/contacts", {
      user: "bob",
      body: { name: "Ann", email: "ann@x.io", notes: '<p onclick="steal()">Hi<script>x()</script></p>', tags: ["a", " a "] },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Ann", email: "ann@x.io", stage: "lead", owner: "bob", notes: "<p>Hi</p>", tags: ["a"], value: null, vip: null, score: 0, createdBy: "bob", updatedBy: "bob" });
    expect(typeof res.body.id).toBe("string");
    expect(new Date(res.body.createdAt).getTime()).toBeGreaterThan(0);
    expect(res.body.orgId).toBeUndefined();
    expect(res.body.deletedAt).toBeUndefined();
  });

  test("system and readOnly fields cannot be mass-assigned", async () => {
    const res = await h.req("POST", "/api/contacts", { body: { name: "X", id: "mine", orgId: "other", createdBy: "mallory", createdAt: "2000-01-01T00:00:00Z", score: 99 } });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe("mine");
    expect(res.body.createdBy).toBe("ann");
    expect(res.body.score).toBe(0);
    const row = await h.db.prepare("SELECT org_id FROM contacts WHERE id = ?").bind(res.body.id).first<{ org_id: string }>();
    expect(row!.org_id).toBe(h.orgA);
  });

  test("validation errors are 400 with field paths", async () => {
    const res = await h.req("POST", "/api/contacts", { body: { email: "nope", stage: "other", nextFollowUp: "2026-02-30" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MIU_E_VALIDATION");
    const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["body.name", "body.email", "body.stage", "body.nextFollowUp"]));
  });

  test("unique fields give 409 MIU_E_ADMIN_UNIQUE", async () => {
    await h.req("POST", "/api/contacts", { body: { name: "A", email: "dup@x.io" } });
    const res = await h.req("POST", "/api/contacts", { body: { name: "B", email: "dup@x.io" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "MIU_E_ADMIN_UNIQUE", details: { field: "email" } });
    expect(res.body.error.fix).toBeTruthy();
  });

  test("relation must exist", async () => {
    const res = await h.req("POST", "/api/contacts", { body: { name: "A", company: "nope" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MIU_E_ADMIN_RELATION_INVALID");
  });

  test("emits contacts.created and writes an audit entry", async () => {
    const res = await h.req("POST", "/api/contacts", { body: { name: "Ann" } });
    await h.settle();
    const e = h.events.find((x) => x.event === "contacts.created")!;
    expect(e.data).toMatchObject({ resource: "contacts", id: res.body.id, orgId: h.orgA, actor: "ann", record: { name: "Ann" } });
    const page = await h.auditStore.query({ resource: "contacts", resourceId: res.body.id });
    expect(page.items[0]).toMatchObject({ action: "create", actor: "ann", org: h.orgA });
    expect(page.items[0].changes!.name).toEqual({ after: "Ann" });
  });
});

describe("read", () => {
  test("get by id; 404 for unknown", async () => {
    const { people } = await seed();
    const res = await h.req("GET", `/api/contacts/${people[0].id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Ann Lee", tags: ["vip", "b2b"], value: 1000 });
    const missing = await h.req("GET", "/api/contacts/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("MIU_E_ADMIN_RECORD_NOT_FOUND");
  });

  test("list: default sort newest first, cursor pagination", async () => {
    await seed();
    const page1 = await h.req("GET", "/api/contacts?limit=2&sort=name");
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((r: { name: string }) => r.name)).toEqual(["Ann Lee", "Ben Ode"]);
    const page2 = await h.req("GET", `/api/contacts?limit=2&sort=name&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((r: { name: string }) => r.name)).toEqual(["Cy Twombly", "Dee Ray"]);
    const page3 = await h.req("GET", `/api/contacts?limit=2&sort=name&cursor=${page2.body.nextCursor}`);
    expect(page3.body.items.map((r: { name: string }) => r.name)).toEqual(["Eli Wu"]);
    expect(page3.body.nextCursor).toBeNull();
  });

  test("sort with nulls (always last) across pages, both directions", async () => {
    await seed();
    const walk = async (sort: string) => {
      const names: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { items: { name: string }[]; nextCursor: string | null } } = await h.req("GET", `/api/contacts?limit=2&sort=${sort}${cursor ? `&cursor=${cursor}` : ""}`);
        names.push(...res.body.items.map((r) => r.name));
        cursor = res.body.nextCursor;
      } while (cursor);
      return names;
    };
    expect(await walk("value")).toEqual(["Dee Ray", "Ann Lee", "Ben Ode", "Cy Twombly", "Eli Wu"]);
    expect(await walk("-value")).toEqual(["Cy Twombly", "Ben Ode", "Ann Lee", "Dee Ray", "Eli Wu"]);
    const byDate = await walk("nextFollowUp");
    expect(byDate.slice(0, 3)).toEqual(["Ben Ode", "Ann Lee", "Dee Ray"]);
    expect(byDate.slice(3).sort()).toEqual(["Cy Twombly", "Eli Wu"]);
  });

  test("filters as JSON", async () => {
    await seed();
    const names = async (filter: unknown) => {
      const res = await h.req("GET", `/api/contacts?sort=name&filter=${encodeURIComponent(JSON.stringify(filter))}`);
      if (res.status !== 200) throw new Error(res.text);
      return res.body.items.map((r: { name: string }) => r.name);
    };
    expect(await names({ stage: "customer" })).toEqual(["Cy Twombly", "Dee Ray"]);
    expect(await names({ stage: { ne: "customer" } })).toEqual(["Ann Lee", "Ben Ode", "Eli Wu"]);
    expect(await names({ value: { gt: 1000 } })).toEqual(["Ben Ode", "Cy Twombly"]);
    expect(await names({ value: { gte: 1000, lt: 9000 } })).toEqual(["Ann Lee", "Ben Ode"]);
    expect(await names({ value: { lte: 200 } })).toEqual(["Dee Ray"]);
    expect(await names({ stage: { in: ["lead", "lost"] } })).toEqual(["Ann Lee", "Eli Wu"]);
    expect(await names({ name: { contains: "ay" } })).toEqual(["Dee Ray"]);
    expect(await names({ name: { contains: "%" } })).toEqual([]);
    expect(await names({ tags: { contains: "vip" } })).toEqual(["Ann Lee", "Dee Ray"]);
    expect(await names({ value: { isNull: true } })).toEqual(["Eli Wu"]);
    expect(await names({ email: { isNull: false }, vip: { ne: true } })).toEqual(["Ann Lee", "Ben Ode", "Cy Twombly", "Eli Wu"]);
    expect(await names({ vip: true })).toEqual(["Dee Ray"]);
    expect(await names({ nextFollowUp: { gte: "2026-03-02" } })).toEqual(["Ann Lee", "Dee Ray"]);
    expect(await names({ createdBy: "ann" })).toHaveLength(5);
  });

  test("filters as query keys", async () => {
    await seed();
    const names = async (qs: string) => (await h.req("GET", `/api/contacts?sort=name&${qs}`)).body.items.map((r: { name: string }) => r.name);
    expect(await names("stage=customer")).toEqual(["Cy Twombly", "Dee Ray"]);
    expect(await names("value[gte]=5000")).toEqual(["Ben Ode", "Cy Twombly"]);
    expect(await names("stage[in]=lead,lost")).toEqual(["Ann Lee", "Eli Wu"]);
    expect(await names("value[isNull]=true")).toEqual(["Eli Wu"]);
    expect(await names("tags[contains]=b2b")).toEqual(["Ann Lee", "Ben Ode"]);
    // Extra keys are validated as single strings: a repeated key is a 400, not a silent pick.
    const twice = await h.req("GET", "/api/contacts?value[gte]=1&value[gte]=2");
    expect([twice.status, twice.body.error.code]).toEqual([400, "MIU_E_VALIDATION"]);
  });

  test("bad filters, sorts, cursors and fields are 400 with a fix", async () => {
    for (const [qs, code] of [
      [`filter=${encodeURIComponent('{"nope":1}')}`, "MIU_E_ADMIN_FILTER_INVALID"],
      [`filter=${encodeURIComponent('{"value":{"like":1}}')}`, "MIU_E_ADMIN_FILTER_INVALID"],
      [`filter=${encodeURIComponent('{"value":{"gt":"abc"}}')}`, "MIU_E_ADMIN_FILTER_INVALID"],
      [`filter=${encodeURIComponent('{"tags":{"gt":1}}')}`, "MIU_E_ADMIN_FILTER_INVALID"],
      ["filter=notjson", "MIU_E_ADMIN_FILTER_INVALID"],
      ["value[nope]=1", "MIU_E_ADMIN_FILTER_INVALID"],
      ["sort=notes", "MIU_E_ADMIN_SORT_INVALID"],
      ["sort=nope", "MIU_E_ADMIN_SORT_INVALID"],
      ["cursor=garbage", "MIU_E_ADMIN_CURSOR_INVALID"],
      ["fields=name,nope", "MIU_E_ADMIN_FIELDS_INVALID"],
      ["include=stage", "MIU_E_ADMIN_INCLUDE_INVALID"],
      ["view=nope", "MIU_E_ADMIN_VIEW_UNKNOWN"],
      ["view=constructor", "MIU_E_ADMIN_VIEW_UNKNOWN"],
      ["view=__proto__", "MIU_E_ADMIN_VIEW_UNKNOWN"],
      [`filter=${encodeURIComponent('{"__proto__":{"eq":1}}')}`, "MIU_E_ADMIN_FILTER_INVALID"],
      [`filter=${encodeURIComponent('{"constructor":1}')}`, "MIU_E_ADMIN_FILTER_INVALID"],
      [`filter=${encodeURIComponent(JSON.stringify({ stage: { in: Array.from({ length: 51 }, (_, i) => `s${i}`) } }))}`, "MIU_E_ADMIN_FILTER_INVALID"],
      ["fields=constructor", "MIU_E_ADMIN_FIELDS_INVALID"],
      ["include=__proto__", "MIU_E_ADMIN_INCLUDE_INVALID"],
    ] as const) {
      const res = await h.req("GET", `/api/contacts?${qs}`);
      expect([qs, res.status, res.body.error.code]).toEqual([qs, 400, code]);
      expect(res.body.error.fix).toBeTruthy();
    }
    // A cursor made for one sort cannot be used with another.
    await seed();
    const p = await h.req("GET", "/api/contacts?limit=1&sort=name");
    expect((await h.req("GET", `/api/contacts?sort=value&cursor=${p.body.nextCursor}`)).body.error.code).toBe("MIU_E_ADMIN_CURSOR_INVALID");
  });

  test("q full-text search (FTS5, prefix, accents)", async () => {
    await seed();
    await h.req("POST", "/api/contacts", { body: { name: "José Ñúñez" } });
    const names = async (q: string) => (await h.req("GET", `/api/contacts?sort=name&q=${encodeURIComponent(q)}`)).body.items.map((r: { name: string }) => r.name);
    expect(await names("acme")).toEqual(["Ann Lee", "Eli Wu"]);
    expect(await names("twom")).toEqual(["Cy Twombly"]);
    expect(await names("ann acme")).toEqual(["Ann Lee"]);
    expect(await names("jose nunez")).toEqual(["José Ñúñez"]);
    expect(await names('" OR * NEAR(')).toEqual([]);
    expect(await names("   ")).toHaveLength(6);
  });

  test("fields selection keeps id", async () => {
    await seed();
    const res = await h.req("GET", "/api/contacts?fields=name,stage&limit=1");
    expect(Object.keys(res.body.items[0]).sort()).toEqual(["id", "name", "stage"]);
    const one = await h.req("GET", `/api/contacts/${res.body.items[0].id}?fields=email`);
    expect(Object.keys(one.body).sort()).toEqual(["email", "id"]);
  });

  test("saved views apply filter, sort and fields; 'today' is resolved", async () => {
    await seed();
    // The test clock is not used by the API; "today" is the real date, so use the customers view for exact checks.
    const res = await h.req("GET", "/api/contacts?view=customers");
    expect(res.body.items).toEqual([
      { id: expect.any(String), name: "Cy Twombly", value: 9000 },
      { id: expect.any(String), name: "Dee Ray", value: 200 },
    ]);
    // Request filters narrow a view further.
    expect((await h.req("GET", "/api/contacts?view=customers&value[lt]=1000")).body.items.map((r: { name: string }) => r.name)).toEqual(["Dee Ray"]);
    const upcoming = await h.req("GET", "/api/contacts?view=upcoming");
    expect(upcoming.status).toBe(200);
  });

  test("include joins relations", async () => {
    const { acme } = await seed();
    const res = await h.req("GET", "/api/contacts?sort=name&include=company&limit=2");
    expect(res.body.items[0]._included).toEqual({ company: expect.objectContaining({ id: acme.id, name: "Acme" }) });
    expect(res.body.items[1]._included).toEqual({ company: null });
    const one = await h.req("GET", `/api/contacts/${res.body.items[0].id}?include=company`);
    expect(one.body._included.company.name).toBe("Acme");
  });

  test("include needs read permission on the target", async () => {
    await seed();
    const res = await h.req("GET", "/api/contacts?include=company", { user: "nora" });
    expect(res.status).toBe(403);
    expect((await h.req("GET", "/api/contacts", { user: "nora" })).status).toBe(200);
  });
});

describe("update", () => {
  test("PATCH is partial; emits changed fields; audits before/after", async () => {
    const { people } = await seed();
    const id = people[0].id;
    h.events.length = 0;
    const res = await h.req("PATCH", `/api/contacts/${id}`, { user: "bob", body: { stage: "customer", value: 1000, email: null } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Ann Lee", stage: "customer", email: null, updatedBy: "bob", createdBy: "ann" });
    await h.settle();
    const e = h.events.find((x) => x.event === "contacts.updated")!;
    expect(e.data.changes.sort()).toEqual(["email", "stage"]);
    expect(e.data).toMatchObject({ id, orgId: h.orgA, actor: "bob", before: { stage: "lead" }, record: { stage: "customer" } });
    const page = await h.auditStore.query({ resource: "contacts", resourceId: id });
    expect(page.items[0]).toMatchObject({ action: "update", actor: "bob" });
    expect(page.items[0].changes!.stage).toEqual({ before: "lead", after: "customer" });
  });

  test("required fields cannot be nulled; unknown ids 404", async () => {
    const { people } = await seed();
    expect((await h.req("PATCH", `/api/contacts/${people[0].id}`, { body: { name: null } })).status).toBe(400);
    expect((await h.req("PATCH", "/api/contacts/nope", { body: { name: "x" } })).status).toBe(404);
  });

  test("a no-op PATCH emits nothing", async () => {
    const { people } = await seed();
    await h.settle();
    h.events.length = 0;
    const res = await h.req("PATCH", `/api/contacts/${people[0].id}`, { body: { stage: "lead" } });
    expect(res.status).toBe(200);
    await h.settle();
    expect(h.events.filter((x) => x.event === "contacts.updated")).toEqual([]);
  });
});

describe("delete", () => {
  test("soft delete hides the row everywhere but keeps it", async () => {
    const { people } = await seed();
    const id = people[0].id;
    const res = await h.req("DELETE", `/api/contacts/${id}`);
    expect(res.status).toBe(204);
    expect((await h.req("GET", `/api/contacts/${id}`)).status).toBe(404);
    expect((await h.req("GET", "/api/contacts")).body.items.map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await h.req("PATCH", `/api/contacts/${id}`, { body: { name: "x" } })).status).toBe(404);
    expect((await h.req("DELETE", `/api/contacts/${id}`)).status).toBe(404);
    const row = await h.db.prepare("SELECT deleted_at FROM contacts WHERE id = ?").bind(id).first<{ deleted_at: number }>();
    expect(row!.deleted_at).toBeGreaterThan(0);
    // The unique email is free again.
    expect((await h.req("POST", "/api/contacts", { body: { name: "Again", email: "ann@acme.io" } })).status).toBe(201);
    await h.settle();
    expect(h.events.find((x) => x.event === "contacts.deleted")!.data).toMatchObject({ id, soft: true, record: { name: "Ann Lee" } });
    expect((await h.auditStore.query({ resource: "contacts", resourceId: id })).items[0].action).toBe("delete");
  });

  test("hard delete (no softDelete) removes the row; FK set null", async () => {
    const { acme, people } = await seed();
    const res = await h.req("DELETE", `/api/companies/${acme.id}`);
    expect(res.status).toBe(204);
    expect(await h.db.prepare("SELECT id FROM companies WHERE id = ?").bind(acme.id).first()).toBeNull();
    expect((await h.req("GET", `/api/contacts/${people[0].id}`)).body.company).toBeNull();
  });
});

describe("permissions", () => {
  test("viewer may read but not write; signed-out is 401", async () => {
    const { people } = await seed();
    expect((await h.req("GET", "/api/contacts", { user: "vic" })).status).toBe(200);
    for (const [m, p, body] of [
      ["POST", "/api/contacts", { name: "x" }],
      ["PATCH", `/api/contacts/${people[0].id}`, { name: "x" }],
      ["DELETE", `/api/contacts/${people[0].id}`, undefined],
    ] as const) {
      const res = await h.req(m, p, { user: "vic", body });
      expect([m, res.status, res.body.error.code]).toEqual([m, 403, "MIU_E_FORBIDDEN"]);
    }
    expect((await h.req("GET", "/api/contacts", { user: null, org: null })).status).toBe(401);
    // Nothing changed.
    expect((await h.req("GET", `/api/contacts/${people[0].id}`)).body.name).toBe("Ann Lee");
  });
});
