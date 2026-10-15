// examples/crm on workerd: D1 for users, orgs, CRM records, audit and workflow runs; the admin UI
// (server-rendered, CSP); the queue-based workflow engine on Cloudflare Queues; and the admin
// System area API with runtime settings saved in D1 (admin_system_settings).

import { Client, check, eq, explorer, scenario, waitFor, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

export const app: AppSpec = {
  name: "crm",
  dir: "examples/crm",
  vars: { SESSION_SECRET: "workerd-harness-crm-session-secret-0123456789", AUDIT_HMAC_KEY: "workerd-harness-audit-hmac-key-0123456789abcdef" },
};

async function d1(dev: Dev, sql: string, params: unknown[] = []): Promise<any[][]> {
  const dbs = await explorer(dev, "/d1/database");
  const id = dbs.result?.[0]?.uuid;
  check(id, `no D1 database: ${JSON.stringify(dbs).slice(0, 200)}`);
  const r = await explorer(dev, `/d1/database/${id}/raw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, params }) });
  check(r.success, `D1 query failed: ${JSON.stringify(r).slice(0, 400)}`);
  return r.result[0].results.rows;
}

export async function run(dev: Dev, _ctx: SuiteContext) {
  const S = (name: string, fn: () => Promise<string | void>) => scenario("crm", name, fn);
  const owner = new Client(dev.url);
  let orgId = "";

  await S("register the owner, admin login form (303), session cookie", async () => {
    const reg = await new Client(dev.url).post("/auth/register", { email: "owner@example.com", password: "correct horse battery" });
    check(reg.status === 201, `register ${reg.status}: ${reg.text.slice(0, 300)}`);
    const gate = await owner.get("/admin/r/contacts");
    eq([gate.status, gate.headers.get("location")], [303, "/admin/login?next=%2Fadmin%2Fr%2Fcontacts"], "gate");
    const login = await owner.req("POST", "/admin/login", { form: { email: "owner@example.com", password: "correct horse battery", next: "/admin/r/contacts" } });
    eq([login.status, login.headers.get("location")], [303, "/admin/r/contacts"], "login");
  });

  await S("org + contact through the API (D1), escaped on the server-rendered list with CSP", async () => {
    const org = await owner.post("/orgs", { name: "Acme" });
    eq(org.status, 201, "create org");
    orgId = org.json.org.id;
    const created = await owner.post("/api/contacts", { name: "Grace <Hopper>", email: "grace@example.com", stage: "customer" }, { headers: { "x-org-id": orgId } });
    check(created.status === 201, `create contact ${created.status}: ${created.text.slice(0, 300)}`);
    const list = await owner.get("/admin/r/contacts");
    eq(list.status, 200, "list page");
    check(list.text.includes(`<a href="/admin/r/contacts/${created.json.id}">Grace &lt;Hopper&gt;</a>`) && !list.text.includes("Grace <Hopper>"), "escaping");
    check(list.headers.get("content-security-policy")?.includes("script-src 'self'"), "CSP header");
  });

  await S("audit trail rows land in D1", async () => {
    const rows = await d1(dev, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%audit%'");
    check(rows.length > 0, "no audit table");
    const n = await d1(dev, `SELECT COUNT(*) FROM ${rows[0][0]}`);
    check(Number(n[0][0]) > 0, "no audit rows");
    return `${n[0][0]} rows in ${rows[0][0]}`;
  });

  await S("workflow: a new lead creates a follow-up task (queue-based engine on Cloudflare Queues)", async () => {
    const lead = await owner.post("/api/contacts", { name: "Peter Gibbons", email: "peter@initech.example", stage: "lead" }, { headers: { "x-org-id": orgId } });
    check(lead.status === 201, `create lead ${lead.status}: ${lead.text.slice(0, 300)}`);
    const t0 = performance.now();
    const tasks = await waitFor(
      async () => {
        const r = await owner.get("/api/tasks", { headers: { "x-org-id": orgId } });
        const rows = r.json?.data ?? r.json?.items ?? r.json?.rows ?? [];
        return rows.length ? rows : null;
      },
      20_000,
      "a follow-up task from the workflow",
      250,
    );
    const runs = await d1(dev, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%workflow%'");
    return `task "${tasks[0].title}" after ${Math.round(performance.now() - t0)} ms; tables: ${runs.map((r) => r[0]).join(", ")}`;
  });

  await S("admin System area: refused without a global role, then overview + settings saved in D1", async () => {
    const denied = await owner.get("/api/_admin/system");
    check(denied.status === 403, `expected 403 before promotion, got ${denied.status}`);
    // Like seed.ts: the owner also operates the app (global role). Done through local D1.
    const me = (await owner.get("/auth/me")).json.user;
    await d1(dev, "UPDATE users SET roles = ? WHERE id = ?", [JSON.stringify(["operator"]), me.id]);
    const overview = await owner.get("/api/_admin/system");
    check(overview.status === 200, `overview ${overview.status}: ${overview.text.slice(0, 300)}`);
    const plugins = (overview.json.plugins ?? []).map((p: { name: string }) => p.name);
    check(plugins.includes("session") && plugins.includes("workflows"), `plugins: ${plugins}`);
    const orgScoped = await owner.get("/api/_admin/system", { headers: { "x-org-id": orgId } });
    eq(orgScoped.json?.error?.code, "MIU_E_ADMIN_SYSTEM_ORG_SCOPED", "org-scoped System request");
    const session = await owner.get("/api/_admin/system/session");
    const section = (session.json.sections ?? []).find((s: any) => s.settings || s.hasSettings) ?? session.json.sections?.[0];
    check(section?.id, `session sections: ${session.text.slice(0, 300)}`);
    const before = await owner.get(`/api/_admin/system/session/${section.id}/settings`);
    check(before.status === 200, `settings ${before.status}: ${before.text.slice(0, 300)}`);
    const put = await owner.req("PUT", `/api/_admin/system/session/${section.id}/settings`, { json: { maxAge: 7200 } });
    check(put.status === 200, `PUT settings ${put.status}: ${put.text.slice(0, 300)}`);
    const rows = await d1(dev, "SELECT plugin, section, value FROM admin_system_settings");
    check(rows.some((r) => r[0] === "session" && String(r[2]).includes("7200")), `admin_system_settings: ${JSON.stringify(rows)}`);
    const after = await owner.get(`/api/_admin/system/session/${section.id}/settings`);
    check(JSON.stringify(after.json).includes("7200"), `settings after: ${after.text.slice(0, 200)}`);
    return `plugins: ${plugins.join(", ")}`;
  });

  await S("admin System area: a settings row written straight to D1 reaches the isolate within the TTL", async () => {
    await d1(dev, "UPDATE admin_system_settings SET value = ?, updated_at = ? WHERE plugin = 'session'", [JSON.stringify({ maxAge: 3600 }), String(Date.now())]);
    const session = await owner.get("/api/_admin/system/session");
    const section = session.json.sections?.[0];
    // Default systemSettingsTtlMs is 30 s; wait it out.
    await waitFor(
      async () => JSON.stringify((await owner.get(`/api/_admin/system/session/${section.id}/settings`)).json).includes("3600"),
      45_000,
      "the stored value to be applied",
      1000,
    );
  });
}
