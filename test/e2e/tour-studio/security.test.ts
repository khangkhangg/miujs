/**
 * Journey 3 — security: ownership, CSRF (tour API, admin API, /mcp, HTML forms), admin access, login rate
 * limiting, session fixation, logout, production error responses, secure headers. Real server (Bun, production).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, Client, adminClient, creator, startServer, unique, type Server } from "./helpers.ts";

let server: Server;
let base = "";
beforeAll(async () => {
  server = await startServer({ env: { AUTH_RATE_LIMIT: "5" } });
  base = server.url;
}, 60_000);
afterAll(() => server?.stop());

/** What a hostile page on another site can make a browser send: a simple form post, cookies attached. */
const crossSite = (c: Client, path: string, body = "title=pwned", type = "application/x-www-form-urlencoded") =>
  c.fetch(path, { method: "POST", headers: { "content-type": type, "sec-fetch-site": "cross-site", origin: "https://evil.example" }, body });

describe("security", () => {
  test("another user's tour: 403 on read, write and delete; invisible in their list", async () => {
    const alice = await creator(base, "Alice");
    const bob = await creator(base, "Bob");
    const tour = (await (await alice.client.json("POST", "/api/tours", { title: "Alice's flat" })).json()) as { id: string };
    for (const [method, path, body] of [
      ["GET", `/api/tours/${tour.id}`],
      ["PATCH", `/api/tours/${tour.id}`, { title: "Bob's now" }],
      ["POST", `/api/tours/${tour.id}/publish`],
      ["DELETE", `/api/tours/${tour.id}`],
    ] as const) {
      const res = await bob.client.json(method, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("not_owner");
    }
    const list = (await (await bob.client.json("GET", "/api/tours")).json()) as { total: number };
    expect(list.total).toBe(0);
    expect((await alice.client.json("GET", `/api/tours/${tour.id}`)).status).toBe(200);
    // Bob's editor page for Alice's tour is refused too.
    expect((await bob.client.get(`/editor/${tour.id}`, { accept: "text/html" })).status).toBe(403);
  });

  test("CSRF: cross-site form posts carrying the session cookie are rejected everywhere", async () => {
    const { client } = await creator(base, "Victim");
    // tour API (cookie + form type + Sec-Fetch-Site: cross-site)
    const tourRes = await crossSite(client, "/api/tours");
    expect(tourRes.status).toBe(403);
    expect(((await tourRes.json()) as { code: string }).code).toBe("csrf");
    // tour API, same-origin but a simple form post (no JSON / X-Requested-With) — e.g. an old browser without Sec-Fetch-*
    const legacy = await client.fetch("/api/tours", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "title=pwned" });
    expect(legacy.status).toBe(403);
    // /mcp: text/plain (a "simple" content type a page can send without preflight) and cross-site JSON
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tour_create", arguments: { title: "pwned" } } });
    expect((await crossSite(client, "/mcp", rpc, "text/plain")).status).toBe(415);
    expect((await crossSite(client, "/mcp", rpc, "application/json")).status).toBe(403);
    // HTML form endpoints
    expect((await crossSite(client, "/account/keys", "name=evil")).status).toBe(403);
    expect((await crossSite(client, "/logout", "")).status).toBe(403);
    // nothing was created
    expect(((await (await client.json("GET", "/api/tours")).json()) as { total: number }).total).toBe(0);
    expect((await client.json("GET", "/api/me")).status).toBe(200); // still logged in

    // admin API: cross-site, and same-site without the CSRF token
    const admin = await adminClient(base);
    const tours = (await (await admin.json("GET", "/admin/api/tours?limit=1")).json()) as { items: { id: string }[] };
    const id = tours.items[0]!.id;
    const adminCross = await admin.fetch(`/admin/api/tours/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", origin: "https://evil.example" }, body: JSON.stringify({ title: "pwned" }) });
    expect(adminCross.status).toBe(403);
    expect(((await adminCross.json()) as { code: string }).code).toBe("csrf_failed");
    const noToken = await admin.json("PATCH", `/admin/api/tours/${id}`, { title: "pwned" });
    expect(noToken.status).toBe(403);
    expect(((await (await admin.json("GET", `/admin/api/tours/${id}`)).json()) as { title: string }).title).not.toBe("pwned");
  });

  test("login CSRF: a cross-site login form is refused", async () => {
    const c = new Client(base);
    c.headers["x-forwarded-for"] = unique().ip;
    const res = await c.fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, body: `email=${ADMIN_EMAIL}&password=${ADMIN_PASSWORD}` });
    expect(res.status).toBe(403);
    expect(c.cookies.size).toBe(0);
  });

  test("non-admins cannot use /admin: redirect when signed out, 403 when signed in", async () => {
    const anon = await fetch(`${base}/admin`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login?next=%2Fadmin");
    expect((await fetch(`${base}/admin/api/users`)).status).toBe(401);

    const { client } = await creator(base, "Not an admin");
    const meta = await client.json("GET", "/admin/api/_meta");
    expect(meta.status).toBe(403);
    const users = await client.json("GET", "/admin/api/users");
    expect(users.status).toBe(403);
    // The landing page does not offer an Admin link to creators.
    expect(await (await client.get("/")).text()).not.toContain(`href="/admin"`);
    // Admin tools over MCP are refused for a creator's API key as well.
    const key = (await (await client.json("POST", "/api/keys", { name: "bot" })).json()) as { key: string };
    const rpc = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "admin_list_users", arguments: {} } }),
    });
    const out = (await rpc.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toContain("403");
  });

  test("login rate limit: 429 with Retry-After and RateLimit headers", async () => {
    const c = new Client(base);
    const u = unique("brute");
    c.headers["x-forwarded-for"] = u.ip;
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 7; i++) {
      last = await c.json("POST", "/login", { email: ADMIN_EMAIL, password: `guess-${i}` });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(last!.headers.get("ratelimit-limit")).toBe("5");
    expect(last!.headers.get("ratelimit-remaining")).toBe("0");
    expect(((await last!.json()) as { code: string }).code).toBe("rate_limited");
    // Even the right password is refused while limited.
    expect((await c.json("POST", "/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status).toBe(429);
    // A different client (IP) is unaffected.
    const other = new Client(base);
    other.headers["x-forwarded-for"] = unique().ip;
    expect((await other.json("POST", "/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status).toBe(200);
  });

  test("session fixation: a pre-login session id is replaced on login and is useless afterwards", async () => {
    const c = new Client(base);
    c.headers["x-forwarded-for"] = unique().ip;
    // Get a session before logging in (a failed form login stores nothing, so use the signup error path + a flash-free page)
    const me = unique("fix");
    await c.json("POST", "/signup", { name: "Fixie", email: me.email, password: "password-123" });
    const first = c.cookies.get("miu.sid")!;
    expect(first).toBeTruthy();
    await c.json("POST", "/logout");
    // An attacker plants a valid (anonymous) session cookie: reuse the logged-out one, then the victim logs in with it.
    c.cookies.set("miu.sid", first);
    const res = await c.json("POST", "/login", { email: me.email, password: "password-123" });
    expect(res.status).toBe(200);
    const second = c.cookies.get("miu.sid")!;
    expect(second).not.toBe(first);
    expect(second.split(".")[0]).not.toBe(first.split(".")[0]);
    // The planted id does not carry the login.
    const attacker = new Client(base);
    attacker.cookies.set("miu.sid", first);
    expect((await attacker.json("GET", "/api/me")).status).toBe(401);
  });

  test("logout invalidates the session server-side (a stolen copy of the cookie stops working)", async () => {
    const { client } = await creator(base, "Leaky");
    const stolen = client.cookies.get("miu.sid")!;
    const thief = new Client(base);
    thief.cookies.set("miu.sid", stolen);
    expect((await thief.json("GET", "/api/me")).status).toBe(200);
    const out = await client.json("POST", "/logout");
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((x) => x.startsWith("miu.sid=;") && x.includes("Max-Age=0"))).toBe(true);
    expect((await thief.json("GET", "/api/me")).status).toBe(401);
  });

  test("production errors never leak stack traces or internals", async () => {
    const { client } = await creator(base, "Erin");
    const cases: Response[] = [
      await client.fetch("/api/tours", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "x" }, body: "{not json" }),
      await client.json("POST", "/api/tours", { title: "" }),
      await client.json("POST", "/api/tours/../../etc/publish"),
      await client.fetch("/api/tours", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "x-requested-with": "x" }, body: "garbage" }),
      await client.json("POST", "/api/tours/xyz/scenes/import", { title: "x", panoramaBase64: "!!!" }),
      await fetch(`${base}/t/%E0%A4%A`),
      await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "[" }),
      await fetch(`${base}/admin/api/tours?filter=%7Bbad`),
    ];
    for (const res of cases) {
      const text = await res.text();
      expect(res.status).toBeLessThan(500);
      expect(text).not.toMatch(/\bat .*\.(ts|js):\d+|node_modules|\/home\/|stack/);
    }
    expect(server.output()).not.toContain("Unhandled error");
  });

  test("secure headers on pages, APIs and errors", async () => {
    for (const path of ["/", "/api/public/tours/demo-house", "/nope", "/t/demo-house", "/login"]) {
      const res = await fetch(base + path);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBeTruthy();
      expect(res.headers.get("x-frame-options") ?? res.headers.get("content-security-policy")).toBeTruthy();
      expect(res.headers.get("x-request-id")).toMatch(/^[\w-]+$/);
      expect(res.headers.get("server-timing")).toBeNull();
      expect(res.headers.get("x-powered-by")).toBeNull();
    }
    const login = await fetch(`${base}/login`);
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const adminPage = await (await adminClient(base)).get("/admin", { accept: "text/html" });
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get("x-frame-options")).toBe("DENY");
    expect(adminPage.headers.get("cache-control")).toBe("no-store");
    // Production: the dev inspector does not exist.
    expect((await fetch(`${base}/__miu`)).status).toBe(404);
    expect((await fetch(`${base}/__miu?token=e2e-inspector-token-0123456789`)).status).toBe(404);
  });

  test("API keys: only from a session, never from another key; a bad key is 401", async () => {
    const { client } = await creator(base, "Kim");
    const res = await client.json("POST", "/api/keys", { name: "agent" });
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    expect(key).toMatch(/^miu_/);
    const agent = new Client(base);
    agent.headers.authorization = `Bearer ${key}`;
    expect(((await (await agent.json("GET", "/api/me")).json()) as { name: string }).name).toBe("Kim");
    expect((await agent.json("POST", "/api/keys", { name: "more" })).status).toBe(403);
    const bad = new Client(base);
    bad.headers.authorization = "Bearer miu_not-a-real-key";
    expect((await bad.json("GET", "/api/me")).status).toBe(401);
    expect((await bad.json("POST", "/api/tours", { title: "x" })).status).toBe(401);
  });
});
