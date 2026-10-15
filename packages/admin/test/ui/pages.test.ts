import { beforeEach, describe, expect, test } from "bun:test";
import { secureHeaders } from "@miujs/web";
import { buildAssets, clientScript } from "../../src/ui/assets.ts";
import { uiResources } from "./fixtures.ts";
import { XSS, expectNoXss, uiSetup, type UiHarness } from "./harness.ts";

let h: UiHarness;
beforeEach(async () => {
  h = await uiSetup(uiResources());
});

const create = async (body: Record<string, unknown>, user = "ann") => {
  const r = await h.req("POST", "/api/contacts", { body, user });
  if (r.status !== 201) throw new Error(r.text);
  return r.body;
};

const assetNames = (html: string) => ({ css: /href="\/admin\/assets\/(admin\.[0-9a-f]{16}\.css)"/.exec(html)?.[1], js: /src="\/admin\/assets\/(admin\.[0-9a-f]{16}\.js)"/.exec(html)?.[1] });

describe("assets", () => {
  test("CSS and JS are served under content-hashed names with immutable caching", async () => {
    const page = await h.req("GET", "/admin");
    const { css, js } = assetNames(page.text);
    expect(css).toBeTruthy();
    expect(js).toBeTruthy();
    const a = await h.req("GET", `/admin/assets/${css}`, { user: null, org: null });
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toContain("text/css");
    expect(a.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const b = await h.req("GET", `/admin/assets/${js}`, { user: null, org: null });
    expect(b.headers.get("content-type")).toContain("javascript");
    expect(b.text).toBe(buildAssets().js.body);
    expect((await h.req("GET", "/admin/assets/admin.0000000000000000.js")).status).toBe(404);
  });

  test("the script is plain JS that parses, and never writes HTML strings into the DOM", () => {
    const js = clientScript();
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(js)).not.toThrow();
    expect(js).not.toMatch(/\binnerHTML\s*=(?!=)|outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });

  test("the script boots on a page without any widgets", () => {
    const fakeDoc = { body: { getAttribute: () => "" }, querySelector: () => null, querySelectorAll: () => [] };
    // Test-only: run the shipped script against a stub DOM to catch references outside the modules.
    expect(() => new Function("document", "window", clientScript())(fakeDoc, {})).not.toThrow();
  });

  test("mobile layout: grid columns can shrink, and scroll containers hold their absolutely positioned sr-only text", () => {
    // Both were found at 375px in a real browser: without them the kanban widened the page to 1280px.
    const css = buildAssets().css.body;
    expect(css).toContain("@media (max-width:760px){\n.shell{grid-template-columns:minmax(0,1fr)}");
    for (const sel of [".table-wrap", ".board", ".tabs"]) expect(css).toMatch(new RegExp(`\\n\\${sel}\\{position:relative;`));
    expect(css).toContain(".sr-only{position:absolute");
  });

  test("the hash changes with the accent color", () => {
    expect(buildAssets("#ff0000").css.name).not.toBe(buildAssets().css.name);
  });
});

describe("sign-in", () => {
  test("signed-out pages redirect to the login page with a return path", async () => {
    const r = await h.req("GET", "/admin/r/contacts?view=pipeline", { user: null, org: null });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/login?next=%2Fadmin%2Fr%2Fcontacts%3Fview%3Dpipeline");
  });

  test("the built-in login form posts to the admin login route with labelled inputs", async () => {
    const r = await h.req("GET", "/admin/login?next=%2Fadmin%2Fr%2Fcontacts", { user: null, org: null });
    expect(r.status).toBe(200);
    expect(r.text).toContain('<form method="post" action="/admin/login"');
    expect(r.text).toContain('<label for="login-email">');
    expect(r.text).toContain('type="password"');
    expect(r.text).toContain('name="next" value="/admin/r/contacts"');
  });

  test("next is only ever a local path", async () => {
    const r = await h.req("GET", "/admin/login?next=https%3A%2F%2Fevil.example%2F", { user: null, org: null });
    expect(r.text).toContain('name="next" value="/admin"');
    const r2 = await h.req("GET", "/admin/login?next=%2F%2Fevil.example", { user: null, org: null });
    expect(r2.text).toContain('name="next" value="/admin"');
  });

  test("loginUrl sends people to your own login page", async () => {
    const x = await uiSetup(uiResources(), { ui: { loginUrl: "/signin" } });
    const r = await x.req("GET", "/admin", { user: null, org: null });
    expect(r.headers.get("location")).toBe("/signin?next=%2Fadmin");
  });
});

describe("layout and navigation", () => {
  test("a full document with viewport meta, skip link, labelled nav and the title", async () => {
    const r = await h.req("GET", "/admin");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.text.startsWith("<!doctype html>")).toBe(true);
    expect(r.text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(r.text).toContain('<a class="skip" href="#main">Skip to content</a>');
    expect(r.text).toContain('<nav class="side" aria-label="Admin">');
    expect(r.text).toContain("<title>Test Admin</title>");
    expect(r.text).toContain('<a href="/admin/r/contacts">Contacts</a>');
  });

  test("navigation lists only resources the user can read", async () => {
    const r = await h.req("GET", "/admin", { user: "nora" });
    expect(r.text).toContain('href="/admin/r/contacts"');
    expect(r.text).not.toContain('href="/admin/r/companies"');
    expect((await h.req("GET", "/admin/r/companies", { user: "nora" })).status).toBe(403);
  });

  test("the current page is marked with aria-current", async () => {
    const r = await h.req("GET", "/admin/r/contacts");
    expect(r.text).toContain('<a href="/admin/r/contacts" aria-current="page">Contacts</a>');
  });

  test("the resources option limits the navigation", async () => {
    const x = await uiSetup(uiResources(), { ui: { resources: ["contacts"] } });
    const r = await x.req("GET", "/admin");
    expect(r.text).not.toContain('href="/admin/r/companies"');
    expect((await x.req("GET", "/admin/r/companies")).status).toBe(404);
  });
});

describe("org switcher", () => {
  test("lists the user's orgs (escaped) with the active one selected", async () => {
    const r = await h.req("GET", "/admin");
    expect(r.text).toContain('<form method="post" action="/admin/org"');
    expect(r.text).toContain(`<option value="${h.orgA}" selected>Org A</option>`);
    expect(r.text).toContain(`<option value="${h.orgB}">Org &lt;B&gt;</option>`);
    expect(r.text).toContain(`data-org="${h.orgA}"`);
  });

  test("switching sets a cookie; later page loads without a header use that org", async () => {
    await create({ name: "In A" });
    const inB = await h.req("POST", "/api/contacts", { body: { name: "In B" }, org: h.orgB });
    expect(inB.status).toBe(201);
    const sw = await h.req("POST", "/admin/org", { form: { orgId: h.orgB, next: "/admin/r/contacts" }, org: null });
    expect(sw.status).toBe(303);
    expect(sw.headers.get("location")).toBe("/admin/r/contacts");
    const cookie = sw.headers.get("set-cookie")!;
    expect(cookie).toContain(`miu_admin_org=${h.orgB}`);
    expect(cookie).toContain("HttpOnly");
    const page = await h.req("GET", "/admin/r/contacts", { org: null, headers: { cookie: cookie.split(";")[0] } });
    expect(page.status).toBe(200);
    expect(page.text).toContain("In B");
    expect(page.text).not.toContain("In A");
  });

  test("switching to an org you do not belong to is refused", async () => {
    const zedOrg = (await h.req("POST", "/orgs", { body: { name: "Z" }, user: "zed", org: null })).body.org.id;
    const sw = await h.req("POST", "/admin/org", { form: { orgId: zedOrg }, org: null });
    expect(sw.status).toBe(403);
    expect(sw.headers.get("set-cookie")).toBeNull();
  });

  test("with no org chosen yet, the first one is used (and remembered)", async () => {
    await create({ name: "Default org", }, "bob");
    const page = await h.req("GET", "/admin/r/contacts", { org: null, user: "bob" });
    expect(page.headers.get("set-cookie")).toContain(`miu_admin_org=${h.orgA}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Default org");
  });
});

describe("list page", () => {
  test("rows are escaped; the title links to the record; columns are sortable", async () => {
    const c = await create({ name: XSS, stage: "lost", value: 1250, tags: ["<b>t</b>"] });
    const r = await h.req("GET", "/admin/r/contacts");
    expect(r.status).toBe(200);
    expectNoXss(r.text);
    expect(r.text).toContain(`<a href="/admin/r/contacts/${c.id}">&quot;&gt;&lt;script&gt;`);
    expect(r.text).toContain("$12.50");
    expect(r.text).toContain('<th scope="col" aria-sort="none"><a href="/admin/r/contacts?sort=name">Name</a></th>');
    const sorted = await h.req("GET", "/admin/r/contacts?sort=name");
    expect(sorted.text).toContain('<th scope="col" aria-sort="ascending"><a href="/admin/r/contacts?sort=-name">Name</a></th>');
  });

  test("filter, search, views, export and import controls", async () => {
    const r = await h.req("GET", "/admin/r/contacts");
    expect(r.text).toContain('<form method="get" action="/admin/r/contacts" class="panel filters" data-filter-builder');
    expect(r.text).toContain('<label for="list-q">Search</label>');
    expect(r.text).toContain('<a href="/admin/r/contacts?view=pipeline">Pipeline</a>');
    expect(r.text).toContain("Leads &quot;&gt;&lt;script&gt;");
    expect(r.text).toContain('href="/admin/r/contacts/export.csv"');
    expect(r.text).toContain('href="/admin/r/contacts/import"');
    expect(r.text).toContain('href="/admin/r/contacts/new"');
    expectNoXss(r.text);
  });

  test("the filter JSON in the URL filters rows and pre-fills the builder", async () => {
    await create({ name: "Lead Ann", stage: "lead" });
    await create({ name: "Cust Bob", stage: "customer" });
    const r = await h.req("GET", `/admin/r/contacts?filter=${encodeURIComponent(JSON.stringify({ stage: { eq: "customer" } }))}`);
    expect(r.text).toContain("Cust Bob");
    expect(r.text).not.toContain("Lead Ann");
    expect(r.text).toContain('name="filter" value="{&quot;stage&quot;:{&quot;eq&quot;:&quot;customer&quot;}}"');
    expect(r.text).toContain('href="/admin/r/contacts/export.csv?filter=%7B%22stage%22%3A%7B%22eq%22%3A%22customer%22%7D%7D"');
  });

  test("builder rows posted without JavaScript (ff/fo/fv) become the same filter", async () => {
    await create({ name: "Rich", value: 500000 });
    await create({ name: "Poor", value: 100 });
    const r = await h.req("GET", "/admin/r/contacts?ff=value&fo=gte&fv=1000&ff=name&fo=contains&fv=");
    expect(r.text).toContain("Rich");
    expect(r.text).not.toContain("Poor");
    expect(r.text).toContain('name="filter" value="{&quot;value&quot;:{&quot;gte&quot;:100000}}"');
  });

  test("an invalid filter shows the API's error on the page", async () => {
    const r = await h.req("GET", "/admin/r/contacts?filter=%7Bbad");
    expect(r.status).toBe(400);
    expect(r.text).toContain('<div class="alert" role="alert">');
    expect(r.text).toContain("Invalid filter");
  });

  test("search and cursor pagination", async () => {
    for (let i = 0; i < 3; i++) await create({ name: `Person ${i}` });
    const r = await h.req("GET", "/admin/r/contacts?limit=2&sort=name");
    expect(r.text).toContain("Person 0");
    expect(r.text).not.toContain("Person 2");
    const next = /href="(\/admin\/r\/contacts\?[^"]*cursor=[^"]+)"/.exec(r.text)![1].replace(/&amp;/g, "&");
    const p2 = await h.req("GET", next);
    expect(p2.text).toContain("Person 2");
    const q = await h.req("GET", "/admin/r/contacts?q=Person%201");
    expect(q.text).toContain("Person 1");
    expect(q.text).not.toContain("Person 0");
  });

  test("bulk controls follow permissions", async () => {
    await create({ name: "A" });
    const owner = await h.req("GET", "/admin/r/contacts");
    expect(owner.text).toContain('<form method="post" action="/admin/r/contacts/bulk"');
    expect(owner.text).toContain('data-select-all');
    expect(owner.text).toContain('value="delete"');
    expect(owner.text).toContain('value="action:markLost"');
    const viewer = await h.req("GET", "/admin/r/contacts", { user: "vic" });
    expect(viewer.text).not.toContain('value="delete"');
    expect(viewer.text).not.toContain("/admin/r/contacts/new");
    expect(viewer.text).not.toContain("/admin/r/contacts/import");
    expect(viewer.text).not.toContain("export.csv");
  });
});

describe("bulk actions", () => {
  test("delete asks for confirmation, then deletes", async () => {
    const a = await create({ name: "A" });
    const b = await create({ name: "B" });
    const ask = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "delete", ids: [a.id, b.id] } });
    expect(ask.status).toBe(200);
    expect(ask.text).toContain("Delete 2 contacts?");
    expect(ask.text).toContain(`<input type="hidden" name="ids" value="${a.id}">`);
    expect((await h.req("GET", `/api/contacts/${a.id}`)).status).toBe(200);
    const done = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "delete", ids: [a.id, b.id], confirmed: "1" } });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/r/contacts?done=delete&count=2");
    expect((await h.req("GET", `/api/contacts/${a.id}`)).status).toBe(404);
  });

  test("record actions and setting a select field", async () => {
    const a = await create({ name: "A", stage: "lead" });
    const ping = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "action:ping", ids: [a.id] } });
    expect(ping.status).toBe(303);
    const set = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "set:stage:customer", ids: [a.id] } });
    expect(set.status).toBe(303);
    expect((await h.req("GET", `/api/contacts/${a.id}`)).body.stage).toBe("customer");
    const lost = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "action:markLost", ids: [a.id] } });
    expect(lost.text).toContain("Mark the selected contacts as lost?");
  });

  test("the server enforces permissions even if the form is forged", async () => {
    const a = await create({ name: "A" });
    const r = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "delete", ids: [a.id], confirmed: "1" }, user: "vic" });
    expect(r.status).toBe(403);
    expect(r.text).toContain('role="alert"');
    expect((await h.req("GET", `/api/contacts/${a.id}`)).status).toBe(200);
  });

  test("the done notice is built from known labels, never echoed", async () => {
    const r = await h.req("GET", `/admin/r/contacts?done=${encodeURIComponent(XSS)}&count=1`);
    expectNoXss(r.text);
    expect(r.text).not.toContain('role="status"');
    const ok = await h.req("GET", "/admin/r/contacts?done=delete&count=3");
    expect(ok.text).toContain('<div class="alert ok" role="status">Deleted 3 contacts.</div>');
  });
});

describe("kanban view", () => {
  test("columns come from the select options (plus no value); cards are focusable", async () => {
    const a = await create({ name: "Ann", stage: "customer" });
    const r = await h.req("GET", "/admin/r/contacts?view=pipeline");
    expectNoXss(r.text);
    expect(r.text).toContain('data-board data-field="stage" data-path="/api/contacts"');
    for (const col of ["lead", "customer", "lost", ""]) expect(r.text).toContain(`data-col="${col}"`);
    expect(r.text).toContain('data-label="Lost &quot;&gt;&lt;script&gt;');
    expect(r.text).toContain(`<li class="card" tabindex="0" draggable="true" data-id="${a.id}" data-title="Ann"`);
    expect(r.text).toContain("Use the arrow keys");
    expect(r.text).toContain('aria-live="polite"');
    expect(r.text).toMatch(/data-col="customer"[^]*?Ann[^]*?data-col="lost"/);
  });

  test("each card also has a no-JS move form", async () => {
    const a = await create({ name: "Ann", stage: "lead" });
    const r = await h.req("GET", "/admin/r/contacts?view=pipeline");
    expect(r.text).toContain(`<form method="post" action="/admin/r/contacts/bulk" class="move">`);
    const moved = await h.req("POST", "/admin/r/contacts/bulk", { form: { op: "set:stage:lost", ids: [a.id], back: "/admin/r/contacts?view=pipeline" } });
    expect(moved.headers.get("location")).toBe("/admin/r/contacts?view=pipeline");
  });
});

describe("calendar view", () => {
  test("a month grid with records on their dates, and prev/next links", async () => {
    await create({ name: "Birthday Ann", birthday: "2026-03-14" });
    await create({ name: "April Bob", birthday: "2026-04-02" });
    const r = await h.req("GET", "/admin/r/contacts?view=birthdays&month=2026-03");
    expect(r.text).toContain("<caption>March 2026</caption>");
    expect(r.text).toMatch(/<td[^>]*data-date="2026-03-14"[^]*?Birthday Ann/);
    expect(r.text).not.toContain("April Bob");
    expect(r.text).toContain('href="/admin/r/contacts?view=birthdays&amp;month=2026-02"');
    expect(r.text).toContain('href="/admin/r/contacts?view=birthdays&amp;month=2026-04"');
    expect(r.text).toContain('<th scope="col">Mon</th>');
  });
});

describe("record page", () => {
  test("a form generated from the fields, escaped, with actions and delete", async () => {
    const c = await create({ name: XSS, notes: `<p>Hi <b>there</b></p>`, stage: "lost", meta: { a: 1 } });
    const r = await h.req("GET", `/admin/r/contacts/${c.id}`);
    expect(r.status).toBe(200);
    expectNoXss(r.text);
    expect(r.text).toContain(`<form method="post" action="/admin/r/contacts/${c.id}"`);
    expect(r.text).toContain('id="f-name" name="name" value="&quot;&gt;&lt;script&gt;');
    expect(r.text).toContain("<p>Hi <b>there</b></p>");
    expect(r.text).toContain(`action="/admin/r/contacts/${c.id}/action/markLost"`);
    expect(r.text).toContain(`action="/admin/r/contacts/${c.id}/delete"`);
    expect(r.text).toContain("Bio &quot;&gt;&lt;script&gt;");
    expect(r.text).not.toContain('name="secret"');
  });

  test("relation titles are shown and the user picker lists org members", async () => {
    const co = await h.req("POST", "/api/companies", { body: { name: "Acme <Inc>" } });
    const c = await create({ name: "Ann", company: co.body.id, owner: "bob" });
    const r = await h.req("GET", `/admin/r/contacts/${c.id}`);
    expect(r.text).toContain(`<a href="/admin/r/companies/${co.body.id}">Acme &lt;Inc&gt;</a>`);
    expect(r.text).toMatch(/<option value="bob" selected>bob@example.com|<option value="bob" selected>bob/);
  });

  test("missing records are a 404 page", async () => {
    const r = await h.req("GET", "/admin/r/contacts/nope");
    expect(r.status).toBe(404);
    expect(r.text).toContain('role="alert"');
  });

  test("read-only for users who cannot update", async () => {
    const c = await create({ name: "Ann" });
    const r = await h.req("GET", `/admin/r/contacts/${c.id}`, { user: "vic" });
    expect(r.text).not.toContain(">Save<");
    expect(r.text).toContain("<fieldset disabled>");
  });

  test("timeline panel only where a timeline route exists", async () => {
    const c = await create({ name: "Ann" });
    expect((await h.req("GET", `/admin/r/contacts/${c.id}`)).text).not.toContain("Timeline");
  });
});

describe("create and update through forms", () => {
  test("create redirects to the new record", async () => {
    const r = await h.req("POST", "/admin/r/contacts/new", { form: { name: "Form Ann", value: "10.5", tags: "a, b", _bool: "vip", vip: "true" } });
    expect(r.status).toBe(303);
    const id = /\/admin\/r\/contacts\/([^?]+)\?done=created/.exec(r.headers.get("location")!)![1];
    expect((await h.req("GET", `/api/contacts/${id}`)).body).toMatchObject({ name: "Form Ann", value: 1050, tags: ["a", "b"], vip: true });
  });

  test("validation errors are shown next to their fields, with the values kept", async () => {
    const r = await h.req("POST", "/admin/r/contacts/new", { form: { name: "", email: "not-an-email", score: "500", bio: XSS } });
    expect(r.status).toBe(400);
    expectNoXss(r.text);
    expect(r.text).toContain('<div class="alert" role="alert"');
    expect(r.text).toMatch(/id="f-email" name="email" value="not-an-email"[^>]*aria-invalid="true" aria-describedby="f-email-err"/);
    expect(r.text).toContain('<p class="field-error" id="f-score-err">');
    expect(r.text).toContain('<p class="field-error" id="f-name-err">');
  });

  test("client-side conversion errors are shown without calling the API", async () => {
    const r = await h.req("POST", "/admin/r/contacts/new", { form: { name: "A", value: "12.345" } });
    expect(r.status).toBe(400);
    expect(r.text).toContain('<p class="field-error" id="f-value-err">has more than 2 decimal places</p>');
  });

  test("unique conflicts map to the field", async () => {
    await create({ name: "A", email: "dup@x.io" });
    const r = await h.req("POST", "/admin/r/contacts/new", { form: { name: "B", email: "dup@x.io" } });
    expect(r.status).toBe(409);
    expect(r.text).toContain('<p class="field-error" id="f-email-err">');
  });

  test("update sends only changed fields", async () => {
    const c = await create({ name: "Ann", stage: "lead", tags: ["x"] });
    const r = await h.req("POST", `/admin/r/contacts/${c.id}`, { form: { name: "Ann", stage: "customer", tags: "x", _bool: "vip", _multi: "channels" } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/admin/r/contacts/${c.id}?done=saved`);
    await h.settle();
    const audit = await h.req("GET", `/api/contacts/${c.id}`);
    expect(audit.body.stage).toBe("customer");
  });

  test("forms post same-origin; a cross-site post is blocked by the session CSRF check", async () => {
    const { session } = await import("@miujs/session");
    const x = await uiSetup(uiResources(), { before: [session({ secret: "x".repeat(40) })] });
    const c = await x.req("POST", "/api/contacts", { body: { name: "A" } });
    // Give the request a session cookie so the CSRF check applies.
    const login = await x.req("POST", "/admin/org", { form: { orgId: x.orgA } });
    const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
    const r = await x.req("POST", `/admin/r/contacts/${c.body.id}/delete`, { form: { confirmed: "1" }, headers: { origin: "https://evil.example", cookie } });
    expect(r.status).toBe(403);
    expect((await x.req("GET", `/api/contacts/${c.body.id}`)).status).toBe(200);
  });

  test("delete and actions from the record page", async () => {
    const c = await create({ name: "Ann", stage: "lead" });
    const ask = await h.req("POST", `/admin/r/contacts/${c.id}/action/markLost`, { form: {} });
    expect(ask.text).toContain("Mark the selected contacts as lost?");
    const ran = await h.req("POST", `/admin/r/contacts/${c.id}/action/markLost`, { form: { confirmed: "1" } });
    expect(ran.status).toBe(303);
    expect((await h.req("GET", `/api/contacts/${c.id}`)).body.stage).toBe("lost");
    const del = await h.req("POST", `/admin/r/contacts/${c.id}/delete`, { form: { confirmed: "1" } });
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe("/admin/r/contacts?done=delete&count=1");
  });

  test("new record form uses defaults", async () => {
    const r = await h.req("GET", "/admin/r/contacts/new");
    expect(r.text).toContain('<option value="lead" selected>Lead</option>');
  });
});

describe("import wizard", () => {
  test("upload → map → dry-run → commit page, wired to the import endpoint", async () => {
    const r = await h.req("GET", "/admin/r/contacts/import");
    expect(r.status).toBe(200);
    expect(r.text).toContain('data-import data-url="/api/contacts/import"');
    expect(r.text).toContain('<label for="import-file">');
    expect(r.text).toContain('accept=".csv,text/csv"');
    expectNoXss(r.text);
    expect((await h.req("GET", "/admin/r/contacts/import", { user: "vic" })).status).toBe(403);
  });
});

describe("CSP compatibility", () => {
  test("no inline scripts or styles; the script carries the request nonce", async () => {
    const x = await uiSetup(uiResources(), { before: [secureHeaders({ csp: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"] } })] });
    await x.req("POST", "/api/contacts", { body: { name: "A", stage: "lead" } });
    for (const path of ["/admin", "/admin/r/contacts", "/admin/r/contacts?view=pipeline", "/admin/r/contacts?view=birthdays", "/admin/r/contacts/new", "/admin/workflows/new"]) {
      const r = await x.req("GET", path);
      expect(r.status).toBe(200);
      const csp = r.headers.get("content-security-policy")!;
      const nonce = /'nonce-([^']+)'/.exec(csp)![1];
      const scripts = [...r.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length).toBe(1);
      expect(scripts[0]).toContain(`nonce="${nonce}"`);
      expect(scripts[0]).toMatch(/src="\/admin\/assets\/admin\.[0-9a-f]+\.js"/);
      expect(r.text).not.toMatch(/<style\b|\sstyle="/);
      expectNoXss(r.text);
    }
  });
});
