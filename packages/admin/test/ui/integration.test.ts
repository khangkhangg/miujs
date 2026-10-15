import { describe, expect, test } from "bun:test";
// @miujs/files is a dev dependency only: the UI uses ctx.files when an app installs it.
import { files } from "@miujs/files";
import { field, resource } from "../../src/index.ts";
import { crm } from "../../src/crm.ts";
import { uiResources } from "./fixtures.ts";
import { XSS, expectNoXss, uiSetup } from "./harness.ts";

describe("with crm()", () => {
  const setup = () => uiSetup([], { adminPlugin: (database) => crm({ database }) });

  test("record pages of companies/contacts/deals show the timeline (activities + changes), escaped", async () => {
    const h = await setup();
    const c = await h.req("POST", "/api/contacts", { body: { name: "Ann", stage: "lead" } });
    await h.req("PATCH", `/api/contacts/${c.body.id}`, { body: { stage: "qualified" } });
    await h.req("POST", "/api/activities", { body: { type: "call", subject: XSS, body: `<p>Said <b>hi</b><script>alert(1)</script></p>`, subjectType: "contacts", subjectId: c.body.id } });
    const r = await h.req("GET", `/admin/r/contacts/${c.body.id}`);
    expect(r.status).toBe(200);
    expectNoXss(r.text);
    expect(r.text).toContain('<h2 id="timeline-h">Timeline</h2>');
    expect(r.text).toContain("Said <b>hi</b>");
    expect(r.text).toContain("&quot;&gt;&lt;script&gt;");
    expect(r.text).toContain(`/admin/r/activities/new?subjectType=contacts&amp;subjectId=${c.body.id}`);
  });

  test("deal pipeline kanban columns follow the deal stages", async () => {
    const h = await setup();
    await h.req("POST", "/api/deals", { body: { title: "Big deal", stage: "proposal", amount: 1234500 } });
    const r = await h.req("GET", "/admin/r/deals?view=pipeline");
    for (const s of ["lead", "qualified", "proposal", "negotiation", "won", "lost"]) expect(r.text).toContain(`data-col="${s}"`);
    expect(r.text).toContain("$12,345.00");
    expect(r.text).toContain('<span class="badge c-green">Won</span>');
  });

  test("crm() workflow actions are offered in the builder and accepted on save", async () => {
    const h = await setup();
    const page = await h.req("GET", "/admin/workflows/new");
    expect(page.text).toContain("&quot;name&quot;:&quot;crm.create_task&quot;");
    const saved = await h.req("POST", "/admin/api/workflows", {
      body: { spec: { name: "follow-up", trigger: { type: "event", event: "contacts.created" }, steps: [{ id: "t", type: "action", action: "crm.create_task", params: { orgId: "{{ data.orgId }}", title: "Call {{ data.record.name }}" } }] } },
    });
    expect(saved.status).toBe(200);
    await h.req("POST", "/admin/api/workflows/follow-up/publish", { body: { version: 1 } });
    await h.req("POST", "/api/contacts", { body: { name: "Zoe" } });
    await h.settle();
    const tasks = await h.req("GET", "/api/tasks");
    expect(tasks.body.items.map((x: any) => x.title)).toContain("Call Zoe");
  });
});

describe("file fields with @miujs/files", () => {
  test("uploads go through ctx.files and the record keeps the key; the page links a signed URL", async () => {
    const docs = resource("docs", { fields: { title: field.text({ required: true }), attachment: field.file() }, tenant: "org" });
    const h = await uiSetup([docs], { plugins: [files({ secret: "f".repeat(40) })] });
    const form = await h.req("GET", "/admin/r/docs/new");
    expect(form.text).toContain('enctype="multipart/form-data"');
    expect(form.text).toContain('type="file" id="f-attachment" name="attachment"');
    const fd = new FormData();
    fd.set("title", "Contract");
    fd.set("attachment", new File(["hello"], "../evil name.txt", { type: "text/plain" }));
    const res = await h.req("POST", "/admin/r/docs/new", { raw: fd });
    expect(res.status).toBe(303);
    const id = /\/admin\/r\/docs\/([^?]+)/.exec(res.headers.get("location")!)![1];
    const rec = (await h.req("GET", `/api/docs/${id}`)).body;
    expect(rec.attachment).toMatch(/^admin\/docs\/[0-9a-f-]+\/evil_name\.txt$/);
    const page = await h.req("GET", `/admin/r/docs/${id}`);
    expect(page.text).toMatch(/Current: <a href="[^"]+">admin\/docs\//);
  });
});

describe("CSV export through the UI", () => {
  test("the export link works from a browser (org from the UI cookie) with the current filter", async () => {
    const h = await uiSetup(uiResources());
    await h.req("POST", "/api/contacts", { body: { name: "Lead", stage: "lead" } });
    await h.req("POST", "/api/contacts", { body: { name: "Cust", stage: "customer" } });
    const r = await h.req("GET", `/admin/r/contacts/export.csv?filter=${encodeURIComponent('{"stage":{"eq":"lead"}}')}`, { org: null, headers: { cookie: `miu_admin_org=${h.orgA}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.text).toContain("Lead");
    expect(r.text).not.toContain("Cust");
  });

  test("viewers without export permission get the API's 403", async () => {
    const h = await uiSetup(uiResources());
    const r = await h.req("GET", "/admin/r/contacts/export.csv", { user: "vic" });
    expect(r.status).toBe(403);
  });
});
