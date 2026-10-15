import { describe, expect, test } from "bun:test";
import { miu, t } from "miujs";
import { sqlite } from "@miujs/db";
import { admin, adminSchema, field, resource } from "../src/index.ts";
import { setup } from "./helpers.ts";

const companies = resource("companies", { fields: { name: field.text({ required: true }) }, tenant: "org" });
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true, max: 200, searchable: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    stage: field.select(["lead", { value: "won", label: "Won!", color: "green", probability: 100 }], { default: "lead" }),
    value: field.money({ currency: "JPY" }),
    pct: field.percent(),
    owner: field.user({ default: "currentUser", help: "Who follows up" }),
  },
  tenant: "org",
  softDelete: true,
  search: true,
  views: { pipeline: { kind: "kanban", groupBy: "stage" } },
  actions: {
    markLost: { label: "Mark lost", confirm: "Sure?", input: t.object({ reason: t.string() }), run: () => null },
    nuke: { permission: "contacts:nuke", run: () => null },
  },
});

describe("adminSchema()", () => {
  const s = adminSchema([companies, contacts]);
  const c = s.resources.find((r) => r.name === "contacts")!;

  test("top level", () => {
    expect(s.version).toBe(1);
    expect(s.basePath).toBe("/api");
    expect(s.operators).toEqual(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "isNull"]);
    expect(s.resources.map((r) => r.name)).toEqual(["companies", "contacts"]);
  });

  test("resource", () => {
    expect(c).toMatchObject({
      label: "Contacts",
      singular: "Contact",
      path: "/api/contacts",
      titleField: "name",
      defaultSort: "-createdAt",
      tenant: "org",
      softDelete: true,
      search: true,
      permissions: { read: "contacts:read", import: "contacts:import" },
      can: { read: true, create: true, update: true, delete: true, export: true, import: true },
    });
    expect(c.endpoints.list).toEqual({ method: "GET", path: "/api/contacts", tool: "contacts_list" });
    expect(c.endpoints.action).toEqual({ method: "POST", path: "/api/contacts/actions/:action", tool: "contacts_action" });
    expect(c.views).toEqual([{ name: "pipeline", label: "Pipeline", kind: "kanban", groupBy: "stage" }]);
  });

  test("fields carry type, options, relation and money info", () => {
    const f = Object.fromEntries(c.fields.map((x) => [x.name, x]));
    expect(c.fields.map((x) => x.name)).toEqual(["id", "name", "company", "stage", "value", "pct", "owner", "createdAt", "updatedAt", "createdBy", "updatedBy"]);
    expect(f.id).toMatchObject({ system: true, readOnly: true, operators: ["eq", "ne", "in"] });
    expect(f.name).toMatchObject({ type: "text", label: "Name", required: true, searchable: true, sortable: true, max: 200, schema: { type: "string", maxLength: 200 } });
    expect(f.name.operators).toContain("contains");
    expect(f.company.relation).toEqual({ resource: "companies", path: "/api/companies", titleField: "name", onDelete: "set null" });
    expect(f.stage.options).toEqual([
      { value: "lead", label: "Lead" },
      { value: "won", label: "Won!", color: "green", probability: 100 },
    ]);
    expect(f.stage.default).toBe("lead");
    expect(f.value).toMatchObject({ type: "money", currency: "JPY", currencyDigits: 0 });
    expect(f.pct).toMatchObject({ min: 0, max: 100 });
    expect(f.owner).toMatchObject({ type: "user", default: "currentUser", help: "Who follows up" });
    expect(f.createdAt).toMatchObject({ type: "datetime", system: true, readOnly: true });
  });

  test("actions", () => {
    expect(c.actions).toEqual([
      { name: "markLost", label: "Mark lost", permission: "contacts:update", confirm: "Sure?", maxRecords: 100, input: expect.objectContaining({ type: "object" }) },
      { name: "nuke", label: "Nuke", permission: "contacts:nuke", maxRecords: 100 },
    ]);
  });

  test("JSON-serializable", () => {
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("GET /api/_admin/schema", () => {
  test("filtered by what the user can do", async () => {
    const h = await setup([companies, contacts]);
    const owner = (await h.req("GET", "/api/_admin/schema")).body;
    expect(owner.resources.map((r: { name: string }) => r.name)).toEqual(["companies", "contacts"]);
    expect(owner.resources[1].actions.map((a: { name: string; can: boolean }) => [a.name, a.can])).toEqual([
      ["markLost", true],
      ["nuke", true],
    ]);
    const viewer = (await h.req("GET", "/api/_admin/schema", { user: "vic" })).body;
    const vc = viewer.resources.find((r: { name: string }) => r.name === "contacts");
    expect(vc.can).toEqual({ read: true, create: false, update: false, delete: false, export: false, import: false });
    expect(vc.actions).toEqual([]);
    const nora = (await h.req("GET", "/api/_admin/schema", { user: "nora" })).body;
    expect(nora.resources.map((r: { name: string }) => r.name)).toEqual(["contacts"]);
    expect((await h.req("GET", "/api/_admin/schema", { user: null, org: null })).status).toBe(401);
  });
});

describe("MCP tools", () => {
  test("routes are tools named <resource>_<op> with filter/field docs", async () => {
    const h = await setup([companies, contacts], { mcp: true });
    const tools = h.app.tools();
    const names = tools.map((x) => x.name);
    for (const n of ["contacts_list", "contacts_get", "contacts_create", "contacts_update", "contacts_delete", "contacts_bulk", "contacts_action", "contacts_export", "contacts_import", "companies_list", "admin_schema"]) {
      expect(names).toContain(n);
    }
    const list = tools.find((x) => x.name === "contacts_list")!;
    expect(list.description).toContain("filter");
    expect(list.description).toContain("contains");
    expect(list.description).toContain("stage (select, one of lead|won");
    expect(list.description).toContain("Requires permission: contacts:read");
    expect(list.annotations.readOnlyHint).toBe(true);
    expect(Object.keys(list.inputSchema.properties as object)).toEqual(expect.arrayContaining(["filter", "sort", "cursor", "limit", "q", "fields", "view", "include", "stage"]));
    const create = tools.find((x) => x.name === "contacts_create")!;
    expect((create.inputSchema.required as string[]) ?? []).toContain("name");
    expect(tools.find((x) => x.name === "contacts_delete")!.annotations.destructiveHint).toBe(true);

    // Calling a tool goes through auth, permissions and tenant scoping.
    const headers = { "x-user": "ann", "x-org-id": h.orgA };
    const made = await tools.find((x) => x.name === "contacts_create")!.call({ name: "Via MCP", stage: "won" }, { headers });
    expect(made.status).toBe(201);
    const found = await list.call({ filter: JSON.stringify({ stage: "won" }) }, { headers });
    expect((found.body as { items: { name: string }[] }).items.map((x) => x.name)).toEqual(["Via MCP"]);
    expect((await list.call({}, { headers: { "x-user": "eve", "x-org-id": h.orgB } })).body).toEqual({ items: [], nextCursor: null });
    expect((await list.call({})).status).toBe(401);
    // The same routes describe themselves in OpenAPI.
    const oa = h.app.openapi() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(oa.paths["/api/contacts"].get["x-permission"]).toBe("contacts:read");
    expect(Object.keys(oa.paths)).toContain("/api/contacts/export.csv");
  });

  test("mcp: false on a resource hides its tools but keeps the routes", async () => {
    const hidden = resource("secrets", { fields: { v: field.text() }, mcp: false, permissions: false });
    const app = miu({ logLevel: "silent", mcp: true, plugins: [admin({ resources: [hidden], database: sqlite() })] });
    await app.ready();
    expect(app.tools().map((x) => x.name)).not.toContain("secrets_list");
    expect(app.routes().map((r) => r.name)).toContain("secrets_list");
  });
});

describe("inspect()", () => {
  test("lists resources, routes, events and migrations", async () => {
    const h = await setup([companies, contacts]);
    const info = h.app.inspect().plugins.find((p) => p.name === "admin")!.info as any;
    expect(info.basePath).toBe("/api");
    expect(info.migrations).toEqual(["admin_001_companies", "admin_001_contacts"]);
    const c = info.resources.find((r: { name: string }) => r.name === "contacts");
    expect(c.events).toEqual(["contacts.created", "contacts.updated", "contacts.deleted"]);
    expect(c.routes).toEqual(
      expect.arrayContaining(["GET /api/contacts", "GET /api/contacts/:id", "POST /api/contacts", "PATCH /api/contacts/:id", "DELETE /api/contacts/:id", "POST /api/contacts/bulk", "POST /api/contacts/actions/:action", "GET /api/contacts/export.csv", "POST /api/contacts/import"]),
    );
    expect(info.schema).toBe("GET /api/_admin/schema");
  });
});

describe("config errors", () => {
  test("unknown relation target and missing database", async () => {
    expect(() => admin({ resources: [contacts] })).toThrow(/companies/);
    const app = miu({ logLevel: "silent", plugins: [admin({ resources: [resource("notes", { fields: { body: field.text() }, permissions: false })] })] });
    const res = await app.request("/api/notes", { headers: {} });
    // auth required comes first
    expect(res.status).toBe(401);
  });

  test("permissions: false resources need sign-in only; no ctx.db and no database is a clear error", async () => {
    const notes = resource("notes", { fields: { body: field.text() }, permissions: false });
    const app = miu({
      logLevel: "silent",
      plugins: [{ name: "u", onRequest: (ctx) => void (ctx.user = { id: "u1", roles: [] }) }, admin({ resources: [notes] })],
    });
    const res = await app.request("/api/notes");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_ADMIN_DATABASE_MISSING");
    const ok = miu({ logLevel: "silent", plugins: [{ name: "u", onRequest: (ctx) => void (ctx.user = { id: "u1", roles: [] }) }, admin({ resources: [notes], database: sqlite() })] });
    const made = await ok.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }) });
    expect(made.status).toBe(201);
    expect(((await (await ok.request("/api/notes")).json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  test("auto-migrate: on in dev, off in production unless asked", async () => {
    const notes = resource("notes", { fields: { body: field.text() }, permissions: false });
    const signedIn = { name: "u", onRequest: (ctx: { user?: unknown }) => void (ctx.user = { id: "u1", roles: [] }) };
    const tables = async (d: ReturnType<typeof sqlite>) => (await d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'").all()).results.length;
    const prodDb = sqlite();
    const prod = miu({ logLevel: "silent", dev: false, plugins: [signedIn, admin({ resources: [notes], database: prodDb })] });
    expect((await prod.request("/api/notes")).status).toBe(500);
    expect(await tables(prodDb)).toBe(0);
    const forcedDb = sqlite();
    const forced = miu({ logLevel: "silent", dev: false, plugins: [signedIn, admin({ resources: [notes], database: forcedDb, autoMigrate: true })] });
    expect((await forced.request("/api/notes")).status).toBe(200);
    expect(await tables(forcedDb)).toBe(1);
  });

  test("a permission without an access plugin is refused, never silently allowed", async () => {
    const app = miu({ logLevel: "silent", plugins: [{ name: "u", onRequest: (ctx) => void (ctx.user = { id: "u1", roles: [] }) }, admin({ resources: [companies], database: sqlite() })] });
    const res = await app.request("/api/companies");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MIU_E_PERMISSION_UNCHECKED");
  });
});
