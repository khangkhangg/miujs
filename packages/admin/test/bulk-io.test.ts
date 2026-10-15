import { beforeEach, describe, expect, test } from "bun:test";
import { t } from "miujs";
import { parseCsv } from "../src/csv.ts";
import { field, resource, type HookArgs } from "../src/index.ts";
import { setup, type Harness } from "./helpers.ts";

const hookLog: string[] = [];

const companies = resource("companies", { fields: { name: field.text({ required: true }) }, tenant: "org" });
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true }),
    email: field.email({ unique: true }),
    company: field.relation("companies"),
    stage: field.select([{ value: "lead", label: "Lead" }, { value: "customer", label: "Customer" }], { default: "lead" }),
    value: field.money({ currency: "USD" }),
    tags: field.tags(),
    vip: field.boolean(),
    notes: field.longText(),
    data: field.json(),
    slug: field.text({ readOnly: true }),
  },
  tenant: "org",
  softDelete: true,
  actions: {
    tag: {
      label: "Add tag",
      input: t.object({ tag: t.string({ minLength: 1 }) }),
      run: async ({ records, input, data }) => {
        for (const r of records) await data("contacts").update(r.id, { tags: [...(r.tags as string[]), input.tag] });
        return { tagged: records.map((r) => r.id) };
      },
    },
    explode: { permission: "contacts:explode", run: () => "boom" },
  },
  hooks: {
    beforeCreate: ({ input }) => {
      hookLog.push("beforeCreate");
      if (input.name === "forbidden") throw new Error("nope");
      return { ...input, slug: String(input.name).toLowerCase().replace(/\s+/g, "-") };
    },
    afterCreate: ({ record }) => void hookLog.push(`afterCreate:${record.name}`),
    beforeUpdate: ({ changes, before }: HookArgs & { changes: Record<string, unknown>; before: Record<string, unknown> }) => {
      hookLog.push(`beforeUpdate:${before.name}`);
      return changes.name ? { ...changes, slug: String(changes.name).toLowerCase() } : changes;
    },
    afterUpdate: ({ changed }) => void hookLog.push(`afterUpdate:${changed.join(",")}`),
    beforeDelete: ({ record }) => void hookLog.push(`beforeDelete:${record.name}`),
    afterDelete: ({ soft }) => void hookLog.push(`afterDelete:${soft}`),
  },
});

let h: Harness;
beforeEach(async () => {
  hookLog.length = 0;
  h = await setup([companies, contacts]);
});

const create = async (body: Record<string, unknown>) => (await h.req("POST", "/api/contacts", { body })).body;

describe("hooks", () => {
  test("run in order and can change data; readOnly fields are set by hooks", async () => {
    const c = await create({ name: "Ann Lee" });
    expect(c.slug).toBe("ann-lee");
    await h.req("PATCH", `/api/contacts/${c.id}`, { body: { name: "Ann B", slug: "ignored" } });
    expect((await h.req("GET", `/api/contacts/${c.id}`)).body.slug).toBe("ann b");
    await h.req("DELETE", `/api/contacts/${c.id}`);
    expect(hookLog).toEqual(["beforeCreate", "afterCreate:Ann Lee", "beforeUpdate:Ann Lee", "afterUpdate:name,slug", "beforeDelete:Ann B", "afterDelete:true"]);
  });

  test("a throwing before-hook stops the write", async () => {
    const res = await h.req("POST", "/api/contacts", { body: { name: "forbidden" } });
    expect(res.status).toBe(500);
    expect((await h.db.prepare("SELECT count(*) AS n FROM contacts").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("bulk", () => {
  test("update many, emits one event per record", async () => {
    const x = await create({ name: "X" });
    const y = await create({ name: "Y" });
    await h.settle();
    h.events.length = 0;
    const res = await h.req("POST", "/api/contacts/bulk", { body: { action: "update", ids: [x.id, y.id, x.id], changes: { stage: "customer" } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: "update", count: 2, ids: [x.id, y.id] });
    const list = await h.req("GET", "/api/contacts?stage=customer");
    expect(list.body.items).toHaveLength(2);
    await h.settle();
    expect(h.events.filter((e) => e.event === "contacts.updated")).toHaveLength(2);
  });

  test("delete many; needs changes for update; is atomic on unique conflicts", async () => {
    const x = await create({ name: "X", email: "x@x.io" });
    const y = await create({ name: "Y" });
    const z = await create({ name: "Z" });
    expect((await h.req("POST", "/api/contacts/bulk", { body: { action: "update", ids: [x.id] } })).status).toBe(400);
    const clash = await h.req("POST", "/api/contacts/bulk", { body: { action: "update", ids: [y.id, z.id], changes: { email: "x@x.io" } } });
    expect(clash.status).toBe(409);
    expect((await h.req("GET", `/api/contacts/${y.id}`)).body.email).toBeNull();
    const del = await h.req("POST", "/api/contacts/bulk", { body: { action: "delete", ids: [y.id, z.id] } });
    expect(del.body.count).toBe(2);
    expect((await h.req("GET", "/api/contacts")).body.items.map((r: { id: string }) => r.id)).toEqual([x.id]);
  });

  test("bulk delete needs the delete permission", async () => {
    const x = await create({ name: "X" });
    expect((await h.req("POST", "/api/contacts/bulk", { user: "vic", body: { action: "delete", ids: [x.id] } })).status).toBe(403);
    // ed may update but not delete.
    expect((await h.req("POST", "/api/contacts/bulk", { user: "ed", body: { action: "update", ids: [x.id], changes: { stage: "customer" } } })).status).toBe(200);
    const res = await h.req("POST", "/api/contacts/bulk", { user: "ed", body: { action: "delete", ids: [x.id] } });
    expect(res.status).toBe(403);
    expect((await h.req("GET", `/api/contacts/${x.id}`)).status).toBe(200);
  });
});

describe("actions", () => {
  test("validated input, scoped data access, audit per record", async () => {
    const x = await create({ name: "X", tags: ["a"] });
    const res = await h.req("POST", "/api/contacts/actions/tag", { body: { ids: [x.id], input: { tag: "vip" } } });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ tagged: [x.id] });
    expect((await h.req("GET", `/api/contacts/${x.id}`)).body.tags).toEqual(["a", "vip"]);
    const audit = await h.auditStore.query({ resource: "contacts", resourceId: x.id });
    expect(audit.items.map((e) => e.action)).toContain("action.tag");
  });

  test("bad input, unknown action, missing permission", async () => {
    const x = await create({ name: "X" });
    expect((await h.req("POST", "/api/contacts/actions/tag", { body: { ids: [x.id], input: {} } })).status).toBe(400);
    const unknown = await h.req("POST", "/api/contacts/actions/nope", { body: { ids: [x.id] } });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "MIU_E_ADMIN_ACTION_UNKNOWN"]);
    expect((await h.req("POST", "/api/contacts/actions/explode", { user: "bob", body: { ids: [x.id] } })).status).toBe(403);
    expect((await h.req("POST", "/api/contacts/actions/explode", { user: "ann", body: { ids: [x.id] } })).body.result).toBe("boom");
  });
});

describe("export.csv", () => {
  test("streams CSV with header, filters, money in major units and formula guard", async () => {
    const acme = (await h.req("POST", "/api/companies", { body: { name: "Acme" } })).body;
    await create({ name: "=HYPERLINK(\"http://evil\",\"x\")", value: 123456, tags: ["a", "b"], vip: true, company: acme.id, notes: "line1\nline2, \"q\"", data: { k: 1 } });
    await create({ name: "@cmd", value: -500, stage: "customer" });
    await create({ name: "Plain", email: "p@x.io" });
    const res = await h.req("GET", "/api/contacts/export.csv?sort=name", { user: "exp" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="contacts.csv"');
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(["id", "name", "email", "company", "stage", "value", "tags", "vip", "notes", "data", "slug", "createdAt", "updatedAt"]);
    const byName = Object.fromEntries(rows.slice(1).map((r) => [r[1], r]));
    const evil = byName[`'=HYPERLINK("http://evil","x")`];
    expect(evil).toBeDefined();
    expect(evil.slice(2, 11)).toEqual(["", acme.id, "lead", "1234.56", "a, b", "true", 'line1\nline2, "q"', '{"k":1}', "=hyperlink(\"http://evil\",\"x\")".replace(/^=/, "'=")]);
    expect(byName["'@cmd"][5]).toBe("-5.00");
    expect(rows).toHaveLength(4);
    const filtered = parseCsv((await h.req("GET", "/api/contacts/export.csv?stage=customer&fields=name,value")).text);
    expect(filtered).toEqual([
      ["id", "name", "value"],
      [expect.any(String), "'@cmd", "-5.00"],
    ]);
    const audit = await h.auditStore.query({ resource: "contacts" });
    expect(audit.items.find((e) => e.action === "export")!.metadata).toMatchObject({ count: 1 });
  });

  test("pages through large tables", async () => {
    const h2 = await setup([companies, contacts], { admin: { exportPageSize: 2 } });
    for (let i = 0; i < 5; i++) await h2.req("POST", "/api/contacts", { body: { name: `P${i}` } });
    const rows = parseCsv((await h2.req("GET", "/api/contacts/export.csv?sort=name")).text);
    expect(rows.slice(1).map((r) => r[1])).toEqual(["P0", "P1", "P2", "P3", "P4"]);
  });

  test("permissions and bad filters", async () => {
    expect((await h.req("GET", "/api/contacts/export.csv", { user: "vic" })).status).toBe(403);
    const bad = await h.req("GET", "/api/contacts/export.csv?sort=nope", { user: "exp" });
    expect([bad.status, bad.body.error.code]).toEqual([400, "MIU_E_ADMIN_SORT_INVALID"]);
  });
});

describe("import", () => {
  const good = `Name,Email,Stage,Value,Tags,VIP,Company,Ignored col\nAnn,ann@x.io,Customer,"1,234.50","a, b",yes,Acme,zzz\nBen,,lead,10,,no,,\n`;

  test("dry run reports per-row errors and writes nothing", async () => {
    await h.req("POST", "/api/companies", { body: { name: "Acme" } });
    await create({ name: "Existing", email: "taken@x.io" });
    const csv = `name,email,value,stage,vip\n,a@x.io,1,lead,\nOk,taken@x.io,abc,nope,maybe\nDup,d@x.io,1,lead,\nDup2,d@x.io,1.234,lead,\nFine,f@x.io,2,lead,true\n`;
    const res = await h.req("POST", "/api/contacts/import", { body: { csv, dryRun: true } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, total: 5, valid: 2, invalid: 3 });
    const errs = Object.fromEntries(res.body.errors.map((e: { row: number; errors: { field: string; message: string }[] }) => [e.row, e.errors.map((x) => x.field).sort()]));
    expect(errs).toEqual({ 1: ["name"], 2: ["email", "stage", "value", "vip"], 4: ["email", "value"] });
    expect((await h.db.prepare("SELECT count(*) AS n FROM contacts").first<{ n: number }>())!.n).toBe(1);
    // Commit refuses the whole file.
    const commit = await h.req("POST", "/api/contacts/import", { body: { csv } });
    expect(commit.status).toBe(400);
    expect(commit.body.error.code).toBe("MIU_E_ADMIN_IMPORT_INVALID");
    expect(commit.body.error.details.rows).toHaveLength(3);
    expect((await h.db.prepare("SELECT count(*) AS n FROM contacts").first<{ n: number }>())!.n).toBe(1);
  });

  test("commit maps headers by label, converts values, resolves relations by title, runs hooks and events", async () => {
    const acme = (await h.req("POST", "/api/companies", { body: { name: "Acme" } })).body;
    await h.settle();
    h.events.length = 0;
    const res = await h.req("POST", "/api/contacts/import", { body: { csv: good } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, total: 2, valid: 2, imported: 2, ignored: ["Ignored col"] });
    expect(res.body.columns).toEqual({ Name: "name", Email: "email", Stage: "stage", Value: "value", Tags: "tags", VIP: "vip", Company: "company" });
    const ann = (await h.req("GET", `/api/contacts/${res.body.ids[0]}`)).body;
    expect(ann).toMatchObject({ name: "Ann", email: "ann@x.io", stage: "customer", value: 123450, tags: ["a", "b"], vip: true, company: acme.id, slug: "ann" });
    const ben = (await h.req("GET", `/api/contacts/${res.body.ids[1]}`)).body;
    expect(ben).toMatchObject({ name: "Ben", email: null, stage: "lead", value: 1000, vip: false, company: null });
    await h.settle();
    expect(h.events.filter((e) => e.event === "contacts.created")).toHaveLength(2);
  });

  test("explicit mapping, formula-guard round trip, multipart upload", async () => {
    const res = await h.req("POST", "/api/contacts/import", { body: { csv: "Full name,Junk\n'=SUM(1),x\n", mapping: { "Full name": "name", Junk: null } } });
    expect(res.status).toBe(200);
    expect((await h.req("GET", `/api/contacts/${res.body.ids[0]}`)).body.name).toBe("=SUM(1)");
    const fd = new FormData();
    fd.set("file", new File(["name\nUploaded\n"], "c.csv", { type: "text/csv" }));
    fd.set("dryRun", "false");
    const up = await h.req("POST", "/api/contacts/import", { raw: fd });
    expect(up.status).toBe(200);
    expect(up.body.imported).toBe(1);
    expect((await h.req("POST", "/api/contacts/import", { body: { csv: "name\nX\n", mapping: { name: "nope" } } })).status).toBe(400);
    expect((await h.req("POST", "/api/contacts/import", { body: { csv: "name\n" } })).body.error.code).toBe("MIU_E_ADMIN_IMPORT_EMPTY");
  });

  test("row limit and permission", async () => {
    const h2 = await setup([companies, contacts], { admin: { importMaxRows: 2 } });
    const big = await h2.req("POST", "/api/contacts/import", { body: { csv: "name\na\nb\nc\n" } });
    expect([big.status, big.body.error.code]).toEqual([413, "MIU_E_ADMIN_IMPORT_TOO_LARGE"]);
    expect((await h.req("POST", "/api/contacts/import", { user: "bob", body: { csv: "name\na\n" } })).status).toBe(403);
  });
});

describe("data API (server side)", () => {
  test("scoped CRUD outside requests emits events through the workflows plugin", async () => {
    const data = h.adminPlugin.data({ orgId: h.orgA, userId: "system" });
    const rec = await data("contacts").create({ name: "From job" });
    expect(rec).toMatchObject({ name: "From job", createdBy: "system", slug: "from-job" });
    expect((await data("contacts").list({ filter: { name: "From job" } })).items).toHaveLength(1);
    // Another org cannot see it.
    expect(await h.adminPlugin.data({ orgId: h.orgB })("contacts").get(rec.id)).toBeNull();
    await expect(h.adminPlugin.data({})("contacts").list()).rejects.toThrow(/organization/);
    // Input is validated like the HTTP routes; readOnly and unknown fields are dropped.
    await expect(data("contacts").create({ email: "nope" })).rejects.toThrow(/name is required|email/);
    await expect(data("contacts").update(rec.id, { stage: "bogus" })).rejects.toThrow(/stage/);
    expect((await data("contacts").update(rec.id, { slug: "x", orgId: h.orgB } as Record<string, unknown>)).slug).toBe("from-job");
    await h.settle();
    expect(h.events.find((e) => e.event === "contacts.created" && e.data.id === rec.id)!.data.orgId).toBe(h.orgA);
    expect(h.app.service("admin")).toBeDefined();
  });
});
