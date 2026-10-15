// The System area API: every plugin's manage() sections behind permissions, validation and audit.
import { describe, expect, test } from "bun:test";
import { definePlugin, errors, t, type ManageSection } from "miujs";
import { sqlite } from "@miujs/db";
import { adminMigrations } from "../src/index.ts";
import { fakeClock, jobsPlugin, systemSetup, XSS } from "./system-fixtures.ts";

const S = "/api/_admin/system";

describe("system overview", () => {
  test("lists every plugin with its sections, inspect and Cloudflare needs, plus the built-in app section", async () => {
    const h = await systemSetup();
    const r = await h.req("GET", S);
    expect(r.status).toBe(200);
    const names = r.body.plugins.map((p: any) => p.name);
    expect(names[0]).toBe("app");
    expect(names).toEqual(expect.arrayContaining(["jobs", "mailer", "db", "audit", "admin"]));
    const jobs = r.body.plugins.find((p: any) => p.name === "jobs");
    expect(jobs.inspect).toBe(true);
    expect(jobs.cloudflare).toEqual({ kv: ["JOBS"] });
    expect(jobs.sections).toEqual([{ id: "queue", title: "Queue", description: `Background jobs ${XSS}`, status: true, lists: ["jobs"], settings: true, actions: ["purge", "ping", "boom", "html"] }]);
    expect(jobs.can).toEqual({ read: true, settings: true });
    const app = r.body.plugins[0];
    expect(app.builtin).toBe(true);
    expect(app.sections.map((s: any) => s.id)).toEqual(["overview"]);
  });

  test("signed out → 401; signed in without the admin role → 403 (never open by default)", async () => {
    const h = await systemSetup();
    expect((await h.req("GET", S, { user: null })).status).toBe(401);
    const r = await h.req("GET", S, { user: "bob" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("MIU_E_ADMIN_SYSTEM_FORBIDDEN");
    expect(r.body.error.fix).toContain("admin");
    expect((await h.req("GET", `${S}/jobs/queue`, { user: "bob" })).status).toBe(403);
    expect((await h.req("POST", `${S}/jobs/queue/actions/ping`, { user: "bob", body: {} })).status).toBe(403);
    expect(h.jobs.runs).toEqual([]);
  });

  test("GET /:plugin returns sections and redacted inspect()", async () => {
    const h = await systemSetup();
    const r = await h.req("GET", `${S}/jobs`);
    expect(r.status).toBe(200);
    expect(r.body.inspect).toEqual({ backend: "memory", secret: "[REDACTED]" });
    expect(r.body.sections[0].id).toBe("queue");
  });

  test("system: false serves no system routes", async () => {
    const h = await systemSetup({ admin: { system: false } });
    expect((await h.req("GET", S)).status).toBe(404);
  });
});

describe("system sections", () => {
  test("status, lists, settings schema and actions of a section", async () => {
    const h = await systemSetup();
    const r = await h.req("GET", `${S}/jobs/queue`);
    expect(r.status).toBe(200);
    expect(r.body.status.stats[0]).toEqual({ label: "Pending", value: 3, tone: "warning", hint: "waiting to run" });
    expect(r.body.status.tables[0].rows).toEqual([{ id: `w1${XSS}`, mem: 2048 }]);
    expect(r.body.lists[0]).toMatchObject({ name: "jobs", idKey: "id", searchable: true, filters: [{ key: "state", label: "State", options: ["failed", "done"] }] });
    expect(r.body.lists[0].rowActions.map((a: any) => [a.name, a.danger, a.allowed])).toEqual([
      ["retry", false, true],
      ["remove", true, true],
    ]);
    expect(r.body.lists[0].rowActions[1].input.properties.reason.type).toBe("string");
    expect(r.body.settings.schema.properties.concurrency.type).toBe("integer");
    expect(r.body.settings.canWrite).toBe(true);
    expect(r.body.actions.find((a: any) => a.name === "purge")).toMatchObject({ title: "Purge old jobs", danger: true, allowed: true, permission: "system.jobs:purge" });
  });

  test("a failing status() still returns the section, with the error", async () => {
    const bad = definePlugin({ name: "flaky", manage: (): ManageSection[] => [{ id: "main", title: "Main", status: () => { throw new Error("db down"); } }] });
    const h = await systemSetup({ plugins: [bad] });
    const r = await h.req("GET", `${S}/flaky/main`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBeNull();
    expect(r.body.statusError).toBe("Status unavailable");
  });

  test("unknown plugin, section, list and action → 404 MIU_E_ADMIN_SYSTEM_* with a fix", async () => {
    const h = await systemSetup();
    const cases: [string, string, string, unknown?][] = [
      ["GET", `${S}/nope/queue`, "MIU_E_ADMIN_SYSTEM_PLUGIN_UNKNOWN"],
      ["GET", `${S}/nope`, "MIU_E_ADMIN_SYSTEM_PLUGIN_UNKNOWN"],
      ["GET", `${S}/jobs/nope`, "MIU_E_ADMIN_SYSTEM_SECTION_UNKNOWN"],
      ["GET", `${S}/jobs/queue/lists/nope`, "MIU_E_ADMIN_SYSTEM_LIST_UNKNOWN"],
      ["POST", `${S}/jobs/queue/actions/nope`, "MIU_E_ADMIN_SYSTEM_ACTION_UNKNOWN", {}],
      ["POST", `${S}/jobs/queue/lists/jobs/job1/actions/nope`, "MIU_E_ADMIN_SYSTEM_ACTION_UNKNOWN", {}],
      ["GET", `${S}/mailer/outbox/settings`, "MIU_E_ADMIN_SYSTEM_SETTINGS_UNKNOWN"],
    ];
    for (const [method, path, code, body] of cases) {
      const r = await h.req(method, path, { body });
      expect([path, r.status, r.body.error.code]).toEqual([path, 404, code]);
      expect(r.body.error.fix.length).toBeGreaterThan(10);
    }
  });
});

describe("system lists", () => {
  test("pages with a cursor; limit is capped at 100; search and filters pass through", async () => {
    const h = await systemSetup();
    const p1 = await h.req("GET", `${S}/jobs/queue/lists/jobs?limit=3`);
    expect(p1.status).toBe(200);
    expect(p1.body.rows.map((r: any) => r.id)).toEqual(["job0", "job1", "job2"]);
    expect(p1.body.next).toBe("3");
    const p3 = await h.req("GET", `${S}/jobs/queue/lists/jobs?limit=3&cursor=6`);
    expect(p3.body.rows.map((r: any) => r.id)).toEqual(["job6"]);
    expect(p3.body.next).toBeNull();
    await h.req("GET", `${S}/jobs/queue/lists/jobs?limit=5000`);
    expect(h.jobs.queries.at(-1)!.limit).toBe(100);
    await h.req("GET", `${S}/jobs/queue/lists/jobs`);
    expect(h.jobs.queries.at(-1)!.limit).toBe(25);
    const f = await h.req("GET", `${S}/jobs/queue/lists/jobs?search=Job&filters=${encodeURIComponent(JSON.stringify({ state: "failed" }))}`);
    expect(f.body.rows.map((r: any) => r.id)).toEqual(["job1", "job5"]);
    expect(h.jobs.queries.at(-1)).toEqual({ limit: 25, search: "Job", filters: { state: "failed" } });
  });

  test("invalid filters and limits are refused before the plugin sees them", async () => {
    const h = await systemSetup();
    const before = h.jobs.queries.length;
    const bad = [
      `filters=${encodeURIComponent("{nope")}`,
      `filters=${encodeURIComponent(JSON.stringify({ owner: "x" }))}`,
      `filters=${encodeURIComponent(JSON.stringify({ state: "weird" }))}`,
      `filters=${encodeURIComponent(JSON.stringify(["a"]))}`,
      "limit=0",
    ];
    for (const q of bad) {
      const r = await h.req("GET", `${S}/jobs/queue/lists/jobs?${q}`);
      expect([q, r.status]).toEqual([q, 400]);
    }
    expect(h.jobs.queries.length).toBe(before);
  });

  test("search on a list that is not searchable → 400", async () => {
    const plain = definePlugin({
      name: "plain",
      manage: (): ManageSection[] => [{ id: "s", title: "S", lists: [{ name: "l", title: "L", idKey: "id", columns: [{ key: "id", label: "Id" }], list: () => ({ rows: [{ id: "a" }] }) }] }],
    });
    const h = await systemSetup({ plugins: [plain] });
    const r = await h.req("GET", `${S}/plain/s/lists/l?search=x`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MIU_E_ADMIN_SYSTEM_SEARCH_UNSUPPORTED");
    expect((await h.req("GET", `${S}/plain/s/lists/l`)).body).toEqual({ rows: [{ id: "a" }], next: null });
  });
});

describe("system actions", () => {
  test("input is validated with the declared schema", async () => {
    const h = await systemSetup();
    const r = await h.req("POST", `${S}/jobs/queue/actions/purge`, { body: { olderThanDays: 0 } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MIU_E_VALIDATION");
    expect((await h.req("POST", `${S}/jobs/queue/actions/purge`, { body: "nope" })).status).toBe(400);
    expect(h.jobs.runs).toEqual([]);
  });

  test("runs, returns the result and audits actor, plugin, section, action, redacted input and status", async () => {
    const h = await systemSetup();
    const r = await h.req("POST", `${S}/jobs/queue/actions/purge`, { body: { olderThanDays: 7, password: "hunter2", extra: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { purged: 2 } });
    expect(h.jobs.runs).toEqual([{ action: "purge", input: { olderThanDays: 7, password: "hunter2" } }]);
    const rows = (await h.auditStore.query({ resource: "system.jobs" })).items;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ action: "system.action", actor: "root", resourceId: "queue/purge" });
    expect(rows[0].metadata).toEqual({ plugin: "jobs", section: "queue", action: "purge", danger: true, input: { olderThanDays: 7, password: "[REDACTED]" }, status: "ok" });
    expect(JSON.stringify(rows)).not.toContain("hunter2");
  });

  test("an action without an input schema gets {} whatever is sent", async () => {
    const h = await systemSetup();
    const r = await h.req("POST", `${S}/jobs/queue/actions/ping`, { body: { sneaky: true } });
    expect(r.body).toEqual({ ok: true, result: "pong" });
    expect(h.jobs.runs).toEqual([{ action: "ping", input: {} }]);
    expect((await h.req("POST", `${S}/jobs/queue/actions/ping`)).status).toBe(200);
  });

  test("a failing action keeps its error and is audited with status error", async () => {
    const h = await systemSetup();
    const r = await h.req("POST", `${S}/jobs/queue/actions/boom`, { body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MIU_E_TEST_BOOM");
    const row = (await h.auditStore.query({ resource: "system.jobs" })).items[0];
    expect(row.metadata).toMatchObject({ action: "boom", status: "error", error: "MIU_E_TEST_BOOM" });
  });

  test("row actions get { id } merged into their validated input", async () => {
    const h = await systemSetup();
    const a = await h.req("POST", `${S}/jobs/queue/lists/jobs/job3/actions/retry`, { body: {} });
    expect(a.body).toEqual({ ok: true, result: { retried: "job3" } });
    expect((await h.req("POST", `${S}/jobs/queue/lists/jobs/job3/actions/remove`, { body: {} })).status).toBe(400);
    const b = await h.req("POST", `${S}/jobs/queue/lists/jobs/job3/actions/remove`, { body: { reason: "dup", id: "other" } });
    expect(b.status).toBe(200);
    expect(h.jobs.runs).toEqual([
      { action: "retry", input: { id: "job3" } },
      { action: "remove", input: { reason: "dup", id: "job3" } },
    ]);
    const row = (await h.auditStore.query({ resource: "system.jobs" })).items[0];
    expect(row.resourceId).toBe("queue/jobs/job3/remove");
    expect(row.metadata).toMatchObject({ list: "jobs", id: "job3", action: "remove", danger: true });
  });

  test("input is redacted before it reaches any audit client", async () => {
    const seen: any[] = [];
    const spy = definePlugin({
      name: "spy-audit",
      onRequest(ctx) {
        (ctx as any).audit = { log: async (e: unknown) => void seen.push(e) };
      },
    });
    const h = await systemSetup({ audit: false, plugins: [spy] });
    await h.req("POST", `${S}/jobs/queue/actions/purge`, { body: { olderThanDays: 1, password: "hunter2" } });
    expect(seen[0].metadata.input).toEqual({ olderThanDays: 1, password: "[REDACTED]" });
  });

  test("works without @miujs/audit installed", async () => {
    const h = await systemSetup({ audit: false });
    expect((await h.req("POST", `${S}/jobs/queue/actions/ping`, { body: {} })).status).toBe(200);
  });
});

describe("system settings", () => {
  test("GET redacts secret-looking keys; PUT validates, applies, persists and audits", async () => {
    const h = await systemSetup();
    const g = await h.req("GET", `${S}/jobs/queue/settings`);
    expect(g.status).toBe(200);
    expect(g.body.value).toEqual({ concurrency: 4, paused: false, apiToken: "[REDACTED]" });
    expect(g.body.schema.properties.paused.type).toBe("boolean");

    const bad = await h.req("PUT", `${S}/jobs/queue/settings`, { body: { concurrency: 99, paused: false } });
    expect(bad.status).toBe(400);
    expect(h.jobs.sets).toEqual([]);

    // "[REDACTED]" sent back means "keep the current value".
    const p = await h.req("PUT", `${S}/jobs/queue/settings`, { body: { concurrency: 8, paused: true, apiToken: "[REDACTED]" } });
    expect(p.status).toBe(200);
    expect(p.body.value).toEqual({ concurrency: 8, paused: true, apiToken: "[REDACTED]" });
    expect(h.jobs.sets).toEqual([{ concurrency: 8, paused: true, apiToken: "secret-token" }]);

    const stored = await h.db.prepare(`SELECT plugin, section, value, updated_by FROM admin_system_settings`).all();
    expect(stored.results).toEqual([{ plugin: "jobs", section: "queue", value: JSON.stringify({ concurrency: 8, paused: true, apiToken: "secret-token" }), updated_by: "root" }]);

    const row = (await h.auditStore.query({ resource: "system.jobs" })).items[0];
    expect(row).toMatchObject({ action: "system.settings", actor: "root", resourceId: "queue" });
    expect(row.changes).toEqual({ concurrency: { before: 4, after: 8 }, paused: { before: false, after: true } });
    expect(JSON.stringify(row)).not.toContain("secret-token");
  });

  test("stored values are re-applied on the first request of a new instance, and re-read after the TTL", async () => {
    const database = sqlite();
    const clock = fakeClock();
    const a = await systemSetup({ database, clock });
    const b = await systemSetup({ database, clock });
    await b.req("GET", S); // b has read the (empty) settings
    expect(b.jobs.sets).toEqual([]);

    expect((await a.req("PUT", `${S}/jobs/queue/settings`, { body: { concurrency: 9, paused: false } })).status).toBe(200);
    clock.advance(10_000);
    await b.req("GET", S);
    expect(b.jobs.sets).toEqual([]); // within the 30 s TTL
    clock.advance(21_000);
    await b.req("GET", S);
    expect(b.jobs.sets).toEqual([{ concurrency: 9, paused: false }]);
    clock.advance(31_000);
    await b.req("GET", S);
    expect(b.jobs.sets.length).toBe(1); // unchanged values are not applied again

    const c = await systemSetup({ database, clock });
    await c.req("GET", "/nothing-here");
    expect(c.jobs.sets).toEqual([{ concurrency: 9, paused: false }]);
  });

  test("a stored value that no longer matches the schema is skipped, not applied", async () => {
    const database = sqlite();
    const a = await systemSetup({ database });
    await a.req("GET", S);
    await database.prepare(`INSERT INTO admin_system_settings (plugin, section, value, updated_at, updated_by) VALUES ('jobs','queue','{"concurrency":"lots"}',1,'x')`).run();
    const b = await systemSetup({ database });
    await b.req("GET", S);
    expect(b.jobs.sets).toEqual([]);
  });

  test("the TTL is configurable", async () => {
    const database = sqlite();
    const clock = fakeClock();
    const a = await systemSetup({ database, clock });
    const b = await systemSetup({ database, clock, admin: { systemSettingsTtlMs: 1000 } });
    await b.req("GET", S);
    await a.req("PUT", `${S}/jobs/queue/settings`, { body: { concurrency: 2, paused: false } });
    clock.advance(1001);
    await b.req("GET", S);
    expect(b.jobs.sets).toEqual([{ concurrency: 2, paused: false }]);
  });

  test("adminMigrations creates the settings table", () => {
    expect(adminMigrations([]).map((m) => m.id)).toEqual(["admin_system_001_settings"]);
  });
});

describe("system permissions with @miujs/access", () => {
  test("system:read reads everything but runs nothing", async () => {
    const h = await systemSetup({ access: true });
    expect((await h.req("GET", S, { user: "view" })).status).toBe(200);
    expect((await h.req("GET", `${S}/jobs/queue`, { user: "view" })).body.actions.find((a: any) => a.name === "ping").allowed).toBe(false);
    const r = await h.req("POST", `${S}/jobs/queue/actions/ping`, { user: "view", body: {} });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("system.jobs:ping");
    expect((await h.req("PUT", `${S}/jobs/queue/settings`, { user: "view", body: { concurrency: 2, paused: false } })).status).toBe(403);
    expect(h.jobs.runs).toEqual([]);
    expect(h.jobs.sets).toEqual([]);
  });

  test("per-plugin grants: system.jobs:read + system.jobs:ping", async () => {
    const h = await systemSetup({ access: true });
    const o = await h.req("GET", S, { user: "jo" });
    expect(o.status).toBe(200);
    expect(o.body.plugins.map((p: any) => p.name)).toEqual(["jobs"]);
    expect((await h.req("GET", `${S}/mailer/outbox`, { user: "jo" })).status).toBe(403);
    expect((await h.req("POST", `${S}/jobs/queue/actions/ping`, { user: "jo", body: {} })).status).toBe(200);
    expect((await h.req("POST", `${S}/jobs/queue/actions/purge`, { user: "jo", body: { olderThanDays: 3 } })).status).toBe(403);
    expect((await h.req("GET", `${S}/jobs/queue/lists/jobs`, { user: "jo" })).status).toBe(200);
  });

  test("system:* (the recommended operator role) does everything", async () => {
    const h = await systemSetup({ access: true });
    expect((await h.req("POST", `${S}/jobs/queue/actions/purge`, { user: "op", body: { olderThanDays: 3 } })).status).toBe(200);
    expect((await h.req("PUT", `${S}/jobs/queue/settings`, { user: "op", body: { concurrency: 2, paused: false } })).status).toBe(200);
  });

  test("an org role never grants system access; system routes refuse an active org", async () => {
    const h = await systemSetup({ access: true });
    // ann owns org A (role owner: "*") but has no global role.
    expect((await h.req("GET", S, { user: "ann" })).status).toBe(403);
    const r = await h.req("GET", S, { user: "ann", headers: { "x-org-id": h.orgA! } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MIU_E_ADMIN_SYSTEM_ORG_SCOPED");
    expect((await h.req("POST", `${S}/jobs/queue/actions/ping`, { user: "ann", headers: { "x-org-id": h.orgA! }, body: {} })).status).toBe(400);
    expect(h.jobs.runs).toEqual([]);
  });

  test("the admin role alone is not enough when access is installed", async () => {
    const h = await systemSetup({ access: true });
    expect((await h.req("GET", S, { user: "root" })).status).toBe(403);
  });
});

describe("system actions as MCP tools", () => {
  test("listed as system_<plugin>_<action> with destructiveHint from danger", async () => {
    const h = await systemSetup();
    const tools = (await h.mcp("tools/list")).result.tools as any[];
    const purge = tools.find((x) => x.name === "system_jobs_purge");
    expect(purge.annotations.destructiveHint).toBe(true);
    expect(purge.annotations.readOnlyHint).toBe(false);
    expect(purge.inputSchema.properties.olderThanDays.type).toBe("integer");
    expect(purge.description).toContain("system.jobs:purge");
    expect(tools.find((x) => x.name === "system_jobs_ping").annotations.destructiveHint).toBe(false);
    const retry = tools.find((x) => x.name === "system_jobs_retry");
    expect(retry.inputSchema.required).toContain("id");
    expect(tools.find((x) => x.name === "system_mailer_flush")).toBeTruthy();
    // Only actions become tools; the system read routes stay off MCP.
    expect(tools.some((x) => x.name.includes("admin_system"))).toBe(false);
    expect(tools.filter((x) => /^system_(jobs|mailer)_/.test(x.name)).map((x) => x.name).sort()).toEqual(
      ["system_jobs_boom", "system_jobs_html", "system_jobs_ping", "system_jobs_purge", "system_jobs_remove", "system_jobs_retry", "system_mailer_flush"],
    );
  });

  test("calls are permission-checked, validated and audited like the API", async () => {
    const h = await systemSetup();
    const denied = await h.mcp("tools/call", { name: "system_jobs_purge", arguments: { olderThanDays: 2 } }, "bob");
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("MIU_E_ADMIN_SYSTEM_FORBIDDEN");
    const invalid = await h.mcp("tools/call", { name: "system_jobs_purge", arguments: { olderThanDays: "x" } });
    expect(invalid.result.isError).toBe(true);
    const ok = await h.mcp("tools/call", { name: "system_jobs_purge", arguments: { olderThanDays: 2 } });
    expect(ok.result.isError).toBe(false);
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ ok: true, result: { purged: 2 } });
    const row = await h.mcp("tools/call", { name: "system_jobs_retry", arguments: { id: "job4" } });
    expect(JSON.parse(row.result.content[0].text)).toEqual({ ok: true, result: { retried: "job4" } });
    expect(h.jobs.runs.map((r) => r.action)).toEqual(["purge", "retry"]);
    expect((await h.auditStore.query({ resource: "system.jobs" })).items.length).toBe(2);
  });

  test("with access, MCP calls need the same permission", async () => {
    const h = await systemSetup({ access: true });
    expect((await h.mcp("tools/call", { name: "system_jobs_ping", arguments: {} }, "view")).result.isError).toBe(true);
    expect((await h.mcp("tools/call", { name: "system_jobs_ping", arguments: {} }, "jo")).result.isError).toBe(false);
  });

  test("three read-only tools: system_overview, system_status, system_list", async () => {
    const h = await systemSetup();
    const tools = (await h.mcp("tools/list")).result.tools as any[];
    for (const n of ["system_overview", "system_status", "system_list"]) {
      const tool = tools.find((x) => x.name === n);
      expect([n, tool?.annotations.readOnlyHint, tool?.annotations.destructiveHint]).toEqual([n, true, false]);
    }
    expect(tools.find((x) => x.name === "system_status").inputSchema.required).toEqual(["plugin", "section"]);
    expect(tools.find((x) => x.name === "system_list").inputSchema.required).toEqual(["plugin", "section", "list"]);
    expect(tools.filter((x) => x.name.startsWith("admin_system")).length).toBe(0);

    const call = async (name: string, args: unknown, user = "root") => {
      const r = (await h.mcp("tools/call", { name, arguments: args }, user)).result;
      return { isError: r.isError, body: JSON.parse(r.content[0].text) };
    };
    const ov = await call("system_overview", {});
    expect(ov.body.plugins.map((p: any) => p.name)).toContain("jobs");
    const st = await call("system_status", { plugin: "jobs", section: "queue" });
    expect(st.body.status.stats[0].label).toBe("Pending");
    const ls = await call("system_list", { plugin: "jobs", section: "queue", list: "jobs", limit: 500, search: "Job", filters: JSON.stringify({ state: "failed" }) });
    expect(ls.body.rows.map((r: any) => r.id)).toEqual(["job1", "job5"]);
    expect(h.jobs.queries.at(-1)).toEqual({ limit: 100, search: "Job", filters: { state: "failed" } });
    expect((await call("system_status", { plugin: "jobs", section: "nope" })).body.error.code).toBe("MIU_E_ADMIN_SYSTEM_SECTION_UNKNOWN");
    for (const [n, a] of [["system_overview", {}], ["system_status", { plugin: "jobs", section: "queue" }], ["system_list", { plugin: "jobs", section: "queue", list: "jobs" }]] as const) {
      const r = await call(n, a, "bob");
      expect([n, r.isError, r.body.error.code]).toEqual([n, true, "MIU_E_ADMIN_SYSTEM_FORBIDDEN"]);
    }
  });

  test("read tools use per-plugin read permissions with access", async () => {
    const h = await systemSetup({ access: true });
    const call = async (name: string, args: unknown, user: string) => (await h.mcp("tools/call", { name, arguments: args }, user)).result;
    expect((await call("system_status", { plugin: "jobs", section: "queue" }, "jo")).isError).toBe(false);
    expect((await call("system_status", { plugin: "mailer", section: "outbox" }, "jo")).isError).toBe(true);
    expect((await call("system_list", { plugin: "jobs", section: "queue", list: "jobs" }, "view")).isError).toBe(false);
    const ov = JSON.parse((await call("system_overview", {}, "jo")).content[0].text);
    expect(ov.plugins.map((p: any) => p.name)).toEqual(["jobs"]);
  });

  test("systemMcp: false keeps actions off MCP", async () => {
    const h = await systemSetup({ admin: { systemMcp: false } });
    const tools = (await h.mcp("tools/list")).result.tools as any[];
    expect(tools.some((x) => x.name.startsWith("system_"))).toBe(false);
    expect((await h.req("POST", `${S}/jobs/queue/actions/ping`, { body: {} })).status).toBe(200);
  });

  test("tool names stay unique when two sections share an action name", async () => {
    const twin = definePlugin({
      name: "twin",
      manage: (): ManageSection[] => [
        { id: "a", title: "A", actions: [{ name: "go", title: "Go", run: () => "a" }] },
        { id: "b", title: "B", actions: [{ name: "go", title: "Go", input: t.object({ n: t.integer() }), run: () => "b" }] },
      ],
    });
    const h = await systemSetup({ plugins: [twin] });
    const names = ((await h.mcp("tools/list")).result.tools as any[]).map((x) => x.name);
    expect(names).toContain("system_twin_go");
    expect(names).toContain("system_twin_b_go");
    const r = await h.mcp("tools/call", { name: "system_twin_b_go", arguments: { n: 1 } });
    expect(JSON.parse(r.result.content[0].text).result).toBe("b");
  });
});

describe("names and ids with ':' (e.g. leaderboard:<id>, room type:id)", () => {
  const seen: unknown[] = [];
  const board = definePlugin({
    name: "leaderboard:wins",
    manage: (): ManageSection[] => [
      {
        id: "main",
        title: "Main",
        lists: [
          {
            name: "rooms",
            title: "Rooms",
            idKey: "id",
            columns: [{ key: "id", label: "Id" }],
            list: () => ({ rows: [{ id: "chat:42" }] }),
            rowActions: [{ name: "close", title: "Close", input: t.object({ reason: t.optional(t.string()) }), run: (i) => void seen.push(i) }],
          },
        ],
        actions: [{ name: "reset", title: "Reset", danger: true, run: () => void seen.push("reset") }],
      },
    ],
  });

  test("plugin path segments and row ids are URL-decoded; permission resource maps ':' to '_'", async () => {
    seen.length = 0;
    const h = await systemSetup({ plugins: [board] });
    const base = `${S}/${encodeURIComponent("leaderboard:wins")}/main`;
    expect((await h.req("GET", base)).body.actions[0].permission).toBe("system.leaderboard_wins:reset");
    expect((await h.req("POST", `${base}/lists/rooms/${encodeURIComponent("chat:42")}/actions/close`, { body: { reason: "x" } })).status).toBe(200);
    expect((await h.req("POST", `${base}/actions/reset`, { body: {} })).status).toBe(200);
    expect(seen).toEqual([{ reason: "x", id: "chat:42" }, "reset"]);
  });

  test("such actions are MCP tools too", async () => {
    seen.length = 0;
    const h = await systemSetup({ plugins: [board] });
    const tools = ((await h.mcp("tools/list")).result.tools as any[]).map((x) => x.name);
    expect(tools).toContain("system_leaderboard_wins_reset");
    expect(tools).toContain("system_leaderboard_wins_close");
    const r = await h.mcp("tools/call", { name: "system_leaderboard_wins_close", arguments: { id: "chat:7" } });
    expect(r.result.isError).toBe(false);
    expect((await h.mcp("tools/call", { name: "system_leaderboard_wins_reset", arguments: {} })).result.isError).toBe(false);
    expect(seen).toEqual([{ id: "chat:7" }, "reset"]);
  });

  test("with access, per-plugin grants use the mapped resource", async () => {
    const h = await systemSetup({ plugins: [board], access: true });
    // jo has system.jobs:* grants only: no access to the leaderboard.
    expect((await h.req("GET", `${S}/${encodeURIComponent("leaderboard:wins")}/main`, { user: "jo" })).status).toBe(403);
    expect((await h.req("GET", `${S}/${encodeURIComponent("leaderboard:wins")}/main`, { user: "view" })).status).toBe(200);
  });
});

describe("built-in app section", () => {
  test("uptime, runtime, routes, MCP tool count, plugins and recent errors", async () => {
    const clock = fakeClock();
    const h = await systemSetup({ clock });
    await h.req("GET", "/api/_admin/system/jobs/nope"); // a 404 MiuError
    clock.advance(65_000);
    const r = await h.req("GET", `${S}/app/overview`);
    expect(r.status).toBe(200);
    const stat = (label: string) => r.body.status.stats.find((s: any) => s.label === label)?.value;
    expect(stat("Uptime")).toBe(65_000);
    expect(stat("Runtime")).toBe("bun");
    expect(stat("MCP tools")).toBeGreaterThanOrEqual(7);
    expect(stat("Errors")).toBe(1);
    expect(typeof stat("Memory (heap)")).toBe("number");
    const table = (title: string) => r.body.status.tables.find((x: any) => x.title === title);
    const routes = table("Routes").rows;
    expect(routes.find((x: any) => x.path === "/api/_admin/system/jobs/queue/actions/purge")).toMatchObject({ method: "POST", auth: "required", mcp: true });
    expect(routes.find((x: any) => x.path === "/api/_admin/system")).toMatchObject({ name: "system_overview", mcp: true });
    expect(routes.find((x: any) => x.path === "/api/_admin/system/:plugin")).toMatchObject({ mcp: false });
    expect(table("Plugins").rows.map((x: any) => x.name)).toContain("jobs");
    expect(table("Recent errors").rows[0]).toMatchObject({ code: "MIU_E_ADMIN_SYSTEM_SECTION_UNKNOWN", count: 1 });
  });

  test("the error counter is bounded", async () => {
    const thrower = definePlugin({
      name: "thrower",
      manage: (): ManageSection[] => [
        {
          id: "s",
          title: "S",
          actions: [{ name: "fail", title: "Fail", input: t.object({ n: t.integer() }), run: (i: { n: number }) => { throw errors.custom({ code: `MIU_E_T_${i.n}`, status: 400, message: "x", fix: "y" }); } }],
        },
      ],
    });
    const h = await systemSetup({ plugins: [thrower] });
    for (let i = 0; i < 80; i++) await h.req("POST", `${S}/thrower/s/actions/fail`, { body: { n: i } });
    const r = await h.req("GET", `${S}/app/overview`);
    expect(r.body.status.stats.find((s: any) => s.label === "Errors").value).toBe(80);
    const rows = r.body.status.tables.find((x: any) => x.title === "Recent errors").rows;
    expect(rows.length).toBe(50);
    expect(rows[0].code).toBe("MIU_E_T_79"); // most recent first
  });

  test("the app plugin's own name cannot shadow the built-in section", async () => {
    const fake = jobsPlugin("app").plugin;
    const h = await systemSetup({ plugins: [fake] });
    const r = await h.req("GET", S);
    expect(r.body.plugins.filter((p: any) => p.name === "app").length).toBe(1);
    expect(r.body.plugins[0].builtin).toBe(true);
  });
});
