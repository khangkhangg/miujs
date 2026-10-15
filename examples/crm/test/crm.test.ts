import { describe, expect, test } from "bun:test";
import { createApp } from "../app.ts";
import { seed } from "../seed.ts";

const SECRET = "example-crm-secret-that-is-long-enough-0123456789";
const BASE = "http://localhost";

/** A cookie-carrying client on the same origin, like a browser. */
function browser(app: ReturnType<typeof createApp>["app"]) {
  const jar = new Map<string, string>();
  return async (path: string, init: { method?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
    const headers = new Headers({ origin: BASE, ...init.headers });
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body: string | undefined;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers.set("content-type", "application/json");
    } else if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const res = await app.fetch(new Request(BASE + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (/max-age=0/i.test(c) || v === "") jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), v);
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, headers: res.headers };
  };
}

const make = () => createApp({ sessionSecret: SECRET, passwordIterations: 1000, dev: true });

describe("CRM example", () => {
  test("sign in, create a contact through the API, see it on the list page", async () => {
    const { app } = make();
    const signup = browser(app);
    expect((await signup("/auth/register", { json: { email: "owner@example.com", password: "correct horse battery" } })).status).toBe(201);

    const b = browser(app);
    const gate = await b("/admin/r/contacts");
    expect(gate.status).toBe(303);
    expect(gate.headers.get("location")).toBe("/admin/login?next=%2Fadmin%2Fr%2Fcontacts");
    const login = await b("/admin/login", { form: { email: "owner@example.com", password: "correct horse battery", next: "/admin/r/contacts" } });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/admin/r/contacts");

    const org = await b("/orgs", { json: { name: "Acme" } });
    expect(org.status).toBe(201);
    const orgId = org.json.org.id;
    const created = await b("/api/contacts", { json: { name: "Grace <Hopper>", email: "grace@example.com", stage: "lead" }, headers: { "x-org-id": orgId } });
    expect(created.status).toBe(201);

    const list = await b("/admin/r/contacts");
    expect(list.status).toBe(200);
    expect(list.text).toContain(`<a href="/admin/r/contacts/${created.json.id}">Grace &lt;Hopper&gt;</a>`);
    expect(list.text).not.toContain("Grace <Hopper>");
    expect(list.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  test("a bad password re-shows the form", async () => {
    const { app } = make();
    await browser(app)("/auth/register", { json: { email: "a@example.com", password: "correct horse battery" } });
    const r = await browser(app)("/admin/login", { form: { email: "a@example.com", password: "wrong", next: "/admin" } });
    expect(r.status).toBe(401);
    expect(r.text).toContain('role="alert"');
  });

  test("the seed creates users with the three roles, an org and sample records", async () => {
    const { app, database } = make();
    const out = await seed(app, database, { password: "correct horse battery" });
    expect(out.users.map((u) => u.role)).toEqual(["owner", "admin", "sales"]);
    const b = browser(app);
    await b("/admin/login", { form: { email: "sales@example.com", password: "correct horse battery", next: "/admin" } });
    const deals = await b("/admin/r/deals?view=pipeline");
    expect(deals.status).toBe(200);
    expect(deals.text).toContain("data-board");
    expect(deals.text).toContain("Platform rollout");
    // Sales may not delete deals or manage workflows.
    expect(deals.text).not.toContain('value="delete"');
    expect((await b("/admin/workflows/new")).status).toBe(403);
    expect((await b("/admin/workflows")).status).toBe(200);
  });

  test("the seeded owner is a global operator who can open the System area; sales cannot", async () => {
    const { app, database } = make();
    await seed(app, database, { password: "correct horse battery" });
    const owner = browser(app);
    await owner("/admin/login", { form: { email: "owner@example.com", password: "correct horse battery", next: "/admin" } });
    const home = await owner("/admin");
    expect(home.text).toContain('href="/admin/system"');
    const system = await owner("/admin/system");
    expect(system.status).toBe(200);
    expect(system.text).toContain("workflows");
    const sales = browser(app);
    await sales("/admin/login", { form: { email: "sales@example.com", password: "correct horse battery", next: "/admin" } });
    expect((await sales("/admin/system")).status).toBe(403);
  });
});
