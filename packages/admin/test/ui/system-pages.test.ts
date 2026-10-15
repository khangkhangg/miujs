// The System screens of adminUI(): overview cards, plugin pages with section tabs, lists, settings
// forms and actions. Everything goes through the System API, so its permissions apply.
import { describe, expect, test } from "bun:test";
import { definePlugin, t, type ManageSection } from "miujs";
import { systemSetup, XSS } from "../system-fixtures.ts";
import { expectNoXss } from "./harness.ts";

const P = "/admin/system";

describe("System nav and overview", () => {
  test("admins see a System entry in the nav and one card per plugin with its status stats", async () => {
    const h = await systemSetup({ ui: true });
    const home = await h.req("GET", "/admin");
    expect(home.status).toBe(200);
    expect(home.text).toContain(`href="${P}"`);
    const r = await h.req("GET", P);
    expect(r.status).toBe(200);
    expect(r.text).toContain("<h1>System</h1>");
    expect(r.text).toContain(`href="${P}/jobs/queue"`);
    expect(r.text).toContain(`href="${P}/mailer/outbox"`);
    expect(r.text).toContain(`href="${P}/app/overview"`);
    expect(r.text).toMatch(/Pending<\/dt><dd[^>]*>3<\/dd>/);
    expect(r.text).toMatch(/Queued<\/dt><dd[^>]*>5<\/dd>/);
    expect(r.text).toContain('aria-current="page"');
    expectNoXss(r.text);
  });

  test("users without System access get no nav entry and a 403 page; signed-out users go to login", async () => {
    const h = await systemSetup({ ui: true });
    const home = await h.req("GET", "/admin", { user: "bob" });
    expect(home.text).not.toContain(`href="${P}"`);
    const r = await h.req("GET", P, { user: "bob" });
    expect(r.status).toBe(403);
    expect(r.text).toContain("admin");
    expect((await h.req("GET", `${P}/jobs/queue`, { user: "bob" })).status).toBe(403);
    const anon = await h.req("GET", P, { user: null });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/admin/login");
  });

  test("with access, a viewer sees pages but no action buttons or settings form", async () => {
    const h = await systemSetup({ ui: true, access: true });
    const r = await h.req("GET", `${P}/jobs/queue`, { user: "view" });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(`action="${P}/jobs/queue/actions/purge"`);
    expect(r.text).not.toContain(`action="${P}/jobs/queue/settings"`);
    expect(r.text).toContain("concurrency");
    expect(r.text).toContain("job1");
    expect(r.text).not.toContain(`action="${P}/jobs/queue/lists/jobs/job1/actions/retry"`);
    const jo = await h.req("GET", `${P}/jobs/queue`, { user: "jo" });
    expect(jo.text).toContain(`action="${P}/jobs/queue/actions/ping"`);
    expect(jo.text).not.toContain(`action="${P}/jobs/queue/actions/purge"`);
    const ov = await h.req("GET", P, { user: "jo" });
    expect(ov.text).toContain(`href="${P}/jobs/queue"`);
    expect(ov.text).not.toContain(`href="${P}/mailer/outbox"`);
  });
});

describe("System plugin page", () => {
  test("tabs per section, stats, tables, list with search/filters/row actions, settings form and actions; all escaped", async () => {
    const h = await systemSetup({ ui: true });
    const r = await h.req("GET", `${P}/jobs/queue`);
    expect(r.status).toBe(200);
    const html = r.text;
    expectNoXss(html);
    expect(html).toContain('class="tabs"');
    expect(html).toContain("Pending");
    expect(html).toContain("2 KB"); // bytes column
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // list: search box, filter select, rows, row actions
    expect(html).toContain('name="jobs.search"');
    expect(html).toMatch(/<select[^>]*name="jobs\.f\.state"/);
    expect(html).toContain("job6");
    expect(html).toContain(`action="${P}/jobs/queue/lists/jobs/job1/actions/retry"`);
    expect(html).toMatch(new RegExp(`action="${P}/jobs/queue/lists/jobs/job1/actions/remove"[^]*?data-confirm=`));
    // settings form from the schema, current values filled, secret not shown
    expect(html).toContain(`action="${P}/jobs/queue/settings"`);
    expect(html).toMatch(/name="in\.concurrency"[^>]*value="4"/);
    expect(html).toMatch(/type="checkbox"[^>]*name="in\.paused"/);
    expect(html).not.toContain("secret-token");
    // actions: danger asks for confirmation, others do not
    expect(html).toMatch(/action="\/admin\/system\/jobs\/queue\/actions\/purge"[^]*?<button type="submit" class="danger" data-confirm="/);
    expect(html).toMatch(/action="\/admin\/system\/jobs\/queue\/actions\/ping"[^]*?<button type="submit">Ping<\/button>/);
  });

  test("list paging, search and filters go through the API", async () => {
    const h = await systemSetup({ ui: true });
    const p1 = await h.req("GET", `${P}/jobs/queue?jobs.limit=3`);
    expect(p1.text).toContain("job2");
    expect(p1.text).not.toContain(">job3<");
    expect(p1.text).toContain("jobs.cursor=3");
    const p2 = await h.req("GET", `${P}/jobs/queue?jobs.limit=3&jobs.cursor=3`);
    expect(p2.text).toContain("job3");
    expect(p2.text).not.toContain(">job0<");
    await h.req("GET", `${P}/jobs/queue?jobs.search=Job&jobs.f.state=failed`);
    expect(h.jobs.queries.at(-1)).toEqual({ limit: 25, search: "Job", filters: { state: "failed" } });
    const bad = await h.req("GET", `${P}/jobs/queue?jobs.f.state=${encodeURIComponent(XSS)}`);
    expect(bad.status).toBe(200);
    expect(bad.text).toContain("Invalid filters");
    expectNoXss(bad.text);
  });

  test("/system/:plugin opens the first section; a plugin without sections shows inspect()", async () => {
    const h = await systemSetup({ ui: true });
    const r = await h.req("GET", `${P}/jobs`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${P}/jobs/queue`);
    const db = await h.req("GET", `${P}/test-auth`);
    expect(db.status).toBe(200);
    expect(db.text).toContain("no management sections");
    expect((await h.req("GET", `${P}/nope`)).status).toBe(404);
    expect((await h.req("GET", `${P}/jobs/nope`)).status).toBe(404);
  });

  test("the built-in app section renders routes and errors", async () => {
    const h = await systemSetup({ ui: true });
    const r = await h.req("GET", `${P}/app/overview`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Uptime");
    expect(r.text).toContain("/api/_admin/system");
  });
});

describe("System actions and settings from the UI", () => {
  test("a danger action asks for confirmation first, then runs and shows the result", async () => {
    const h = await systemSetup({ ui: true });
    const ask = await h.req("POST", `${P}/jobs/queue/actions/purge`, { form: { "in.olderThanDays": "5" } });
    expect(ask.status).toBe(200);
    expect(ask.text).toContain("Purge old jobs?");
    expect(ask.text).toContain('name="confirmed" value="1"');
    expect(ask.text).toContain('name="in.olderThanDays" value="5"');
    expect(h.jobs.runs).toEqual([]);
    const done = await h.req("POST", `${P}/jobs/queue/actions/purge`, { form: { "in.olderThanDays": "5", confirmed: "1" } });
    expect(done.status).toBe(200);
    expect(h.jobs.runs).toEqual([{ action: "purge", input: { olderThanDays: 5 } }]);
    expect(done.text).toContain('class="alert ok"');
    expect(done.text).toContain("purged");
  });

  test("results and errors are escaped; validation errors are shown", async () => {
    const h = await systemSetup({ ui: true });
    const x = await h.req("POST", `${P}/jobs/queue/actions/html`, { form: {} });
    expect(x.text).toContain("&lt;script&gt;");
    expectNoXss(x.text);
    const bad = await h.req("POST", `${P}/jobs/queue/actions/purge`, { form: { "in.olderThanDays": "0", confirmed: "1" } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('class="alert"');
    const boom = await h.req("POST", `${P}/jobs/queue/actions/boom`, { form: {} });
    expect(boom.status).toBe(409);
    expect(boom.text).toContain("It broke");
  });

  test("row actions: danger confirm, then run with the id", async () => {
    const h = await systemSetup({ ui: true });
    const ask = await h.req("POST", `${P}/jobs/queue/lists/jobs/job2/actions/remove`, { form: { "in.reason": "dup" } });
    expect(ask.text).toContain("Remove?");
    const ok = await h.req("POST", `${P}/jobs/queue/lists/jobs/job2/actions/remove`, { form: { "in.reason": "dup", confirmed: "1" } });
    expect(ok.status).toBe(200);
    expect(h.jobs.runs).toEqual([{ action: "remove", input: { reason: "dup", id: "job2" } }]);
    await h.req("POST", `${P}/jobs/queue/lists/jobs/job4/actions/retry`, { form: {} });
    expect(h.jobs.runs.at(-1)).toEqual({ action: "retry", input: { id: "job4" } });
  });

  test("settings form: coerces values, unchecked boxes are false, keeps the secret, validation errors shown", async () => {
    const h = await systemSetup({ ui: true });
    const ok = await h.req("POST", `${P}/jobs/queue/settings`, { form: { "in.concurrency": "12" } });
    expect(ok.status).toBe(200);
    expect(h.jobs.sets).toEqual([{ concurrency: 12, paused: false, apiToken: "secret-token" }]);
    expect(ok.text).toContain("Settings saved");
    const on = await h.req("POST", `${P}/jobs/queue/settings`, { form: { "in.concurrency": "3", "in.paused": "true", "in.apiToken": "new" } });
    expect(on.status).toBe(200);
    expect(h.jobs.sets.at(-1)).toEqual({ concurrency: 3, paused: true, apiToken: "new" });
    const bad = await h.req("POST", `${P}/jobs/queue/settings`, { form: { "in.concurrency": "999" } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("concurrency");
    expect(h.jobs.sets.length).toBe(2);
  });

  test("nullable and union settings: empty means null, JSON fields take false or a number; ':' in names and ids", async () => {
    let applied: unknown[] = [];
    const tour = definePlugin({
      name: "tour:main",
      manage: (): ManageSection[] => [
        {
          id: "cfg",
          title: "Config",
          settings: {
            schema: t.object({ maxPlayers: t.nullable(t.integer({ min: 1 })), closeAfterResultMs: t.union([t.integer({ min: 0 }), t.literal(false)]) }),
            get: () => ({ maxPlayers: null, closeAfterResultMs: false }),
            set: (v) => void applied.push(v),
          },
          lists: [{ name: "q", title: "Queue", idKey: "id", columns: [{ key: "id", label: "Id" }], list: () => ({ rows: [{ id: "ranked:u1" }] }), rowActions: [{ name: "kick", title: "Kick", run: (i) => void applied.push(i) }] }],
        },
      ],
    });
    const h = await systemSetup({ ui: true, plugins: [tour] });
    const base = `${P}/${encodeURIComponent("tour:main")}/cfg`;
    const pg = await h.req("GET", base);
    expect(pg.status).toBe(200);
    expect(pg.text).toContain(`action="${base}/lists/q/${encodeURIComponent("ranked:u1")}/actions/kick"`);
    expect(pg.text).toContain(">false</textarea>");
    expect((await h.req("POST", `${base}/settings`, { form: { "in.maxPlayers": "", "in.closeAfterResultMs": "false" } })).status).toBe(200);
    expect((await h.req("POST", `${base}/settings`, { form: { "in.maxPlayers": "8", "in.closeAfterResultMs": "5000" } })).status).toBe(200);
    expect((await h.req("POST", `${base}/lists/q/${encodeURIComponent("ranked:u1")}/actions/kick`, { form: {} })).status).toBe(200);
    expect(applied).toEqual([{ maxPlayers: null, closeAfterResultMs: false }, { maxPlayers: 8, closeAfterResultMs: 5000 }, { id: "ranked:u1" }]);
  });

  test("a viewer cannot run actions or save settings through the UI either", async () => {
    const h = await systemSetup({ ui: true, access: true });
    expect((await h.req("POST", `${P}/jobs/queue/actions/ping`, { user: "view", form: {} })).status).toBe(403);
    expect((await h.req("POST", `${P}/jobs/queue/settings`, { user: "view", form: { "in.concurrency": "2" } })).status).toBe(403);
    expect(h.jobs.runs).toEqual([]);
    expect(h.jobs.sets).toEqual([]);
  });
});
