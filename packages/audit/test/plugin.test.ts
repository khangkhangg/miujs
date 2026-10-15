import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, t, type AuthUser, type Plugin } from "miujs";
import { d1, sqlite } from "@miujs/db";
import { audit, dbAuditStore, memoryAuditStore, REDACTED, verifyChain, type AuditOptions, type AuditStore } from "../src/index.ts";
import { access, accessStore, defineRoles } from "../../access/src/index.ts";
import { auth, memoryUserStore } from "../../auth/src/index.ts";
import { session } from "../../session/src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";

const BASE = "http://localhost";

const USERS: Record<string, AuthUser> = {
  alice: { id: "alice", email: "alice@example.com", roles: ["admin"] },
  bob: { id: "bob", email: "bob@example.com", roles: [] },
};
const testAuth = definePlugin({
  name: "test-auth",
  onRequest(ctx) {
    const id = ctx.headers.get("x-user");
    if (id && Object.prototype.hasOwnProperty.call(USERS, id)) ctx.user = USERS[id];
  },
});
/** Sets ctx.org like @miujs/access would, from `x-test-org`. */
const fakeOrg = definePlugin({
  name: "fake-org",
  onRequest(ctx) {
    const org = ctx.headers.get("x-test-org");
    (ctx as any).org = org ? { id: org, role: "admin" } : null;
  },
});

function makeApp(opts: Partial<AuditOptions> = {}, plugins: Plugin[] = [testAuth, fakeOrg]) {
  const store = opts.store ?? memoryAuditStore();
  const app = miu({
    logLevel: "silent",
    mcp: true,
    plugins: [...plugins, audit({ ...opts, store })],
    routes: [
      route.post("/contacts/:id", {
        params: t.object({ id: t.string() }),
        body: t.object({ before: t.optional(t.any()), after: t.optional(t.any()), metadata: t.optional(t.any()) }),
        handler: async (c) => {
          const rec = await c.audit.log({ action: "update", resource: "contacts", resourceId: c.params.id, ...c.body });
          return { seq: rec.seq };
        },
      }),
      route.post("/bad", { handler: async (c) => void (await c.audit.log({ action: "", resource: "x" })) }),
      route.get("/mine", { auth: "required", handler: (c) => c.audit.query({ actor: c.user.id, limit: 10 }) }),
    ],
  });
  return { app, store };
}

const send = (app: any, method: string, path: string, headers: Record<string, string> = {}, body?: unknown, platform: any = { runtime: "bun" }) =>
  app.dispatch(
    new Request(BASE + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
    {},
    platform,
  ) as Promise<Response>;

describe("ctx.audit.log", () => {
  test("records actor, org, ip, user agent, request id and timestamp", async () => {
    const { app, store } = makeApp();
    const before = Date.now();
    const res = await send(
      app,
      "POST",
      "/contacts/c1",
      { "x-user": "alice", "x-test-org": "o1", "user-agent": "agent/1.0", "x-request-id": "req-42", "cf-connecting-ip": "203.0.113.9" },
      { after: { name: "Ann" } },
      { runtime: "workerd" },
    );
    expect(res.status).toBe(200);
    const [r] = (await store.query({})).items;
    expect(r).toMatchObject({ action: "update", resource: "contacts", resourceId: "c1", actor: "alice", org: "o1", ip: "203.0.113.9", userAgent: "agent/1.0", requestId: "req-42" });
    expect(r.ts).toBeGreaterThanOrEqual(before);
    expect(r.ts).toBeLessThanOrEqual(Date.now());
  });

  test("anonymous and org-less events record nulls", async () => {
    const { app, store } = makeApp();
    await send(app, "POST", "/contacts/c1", {}, { after: { a: 1 } });
    const [r] = (await store.query({})).items;
    expect(r.actor).toBeNull();
    expect(r.org).toBeNull();
    expect(r.ip).toBeNull();
  });

  test("stores only the changed fields of before/after", async () => {
    const { app, store } = makeApp();
    await send(app, "POST", "/contacts/c1", { "x-user": "alice" }, { before: { name: "Ann", email: "a@x", phone: "1" }, after: { name: "Ann", email: "b@x", phone: "1" } });
    const [r] = (await store.query({})).items;
    expect(r.changes).toEqual({ email: { before: "a@x", after: "b@x" } });
  });

  test("redacts secrets in changes and metadata by default, but records that they changed", async () => {
    const { app, store } = makeApp();
    await send(
      app,
      "POST",
      "/contacts/c1",
      { "x-user": "alice" },
      { before: { password: "old-pw", name: "A" }, after: { password: "new-pw", name: "B", profile: { ssn: "123-45-6789" } }, metadata: { apiKey: "k-123", note: "ok" } },
    );
    const [r] = (await store.query({})).items;
    expect(r.changes!.password).toBe(REDACTED);
    expect(r.changes!.name).toEqual({ before: "A", after: "B" });
    expect(r.changes!.profile).toEqual({ after: { ssn: REDACTED } });
    expect(r.metadata).toEqual({ apiKey: REDACTED, note: "ok" });
    const raw = JSON.stringify(r);
    for (const secret of ["old-pw", "new-pw", "123-45-6789", "k-123"]) expect(raw).not.toContain(secret);
  });

  test("custom redact keys add to the defaults", async () => {
    const { app, store } = makeApp({ redact: ["diagnosis", /^mrn$/i] });
    await send(app, "POST", "/contacts/c1", {}, { after: { diagnosis: "flu", MRN: "77", token: "t", name: "x" } });
    const [r] = (await store.query({})).items;
    expect(r.changes).toEqual({ diagnosis: REDACTED, MRN: REDACTED, token: REDACTED, name: { after: "x" } });
  });

  test("an invalid entry is a MIU_E_AUDIT_INVALID error with a fix", async () => {
    const { app } = makeApp();
    const res = await send(app, "POST", "/bad");
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error.code).toBe("MIU_E_AUDIT_INVALID");
    expect(error.fix).toBeTruthy();
  });

  test("ctx.audit.query", async () => {
    const { app } = makeApp();
    await send(app, "POST", "/contacts/c1", { "x-user": "alice" }, { after: { a: 1 } });
    await send(app, "POST", "/contacts/c2", { "x-user": "bob" }, { after: { a: 1 } });
    const res = await send(app, "GET", "/mine", { "x-user": "bob" });
    const page = await res.json();
    expect(page.items.map((r: any) => r.resourceId)).toEqual(["c2"]);
    expect(page.nextCursor).toBeNull();
  });

  test("works with the db store and keeps a valid chain", async () => {
    const store = dbAuditStore(sqlite());
    const { app } = makeApp({ store });
    for (let i = 0; i < 3; i++) await send(app, "POST", `/contacts/c${i}`, { "x-user": "alice" }, { after: { i } });
    expect(await verifyChain(store)).toEqual({ ok: true, checked: 3 });
  });
});

describe("GET /audit", () => {
  async function filled(opts: Partial<AuditOptions> = {}, plugins?: Plugin[]) {
    const s = makeApp(opts, plugins);
    await s.store.append({ ts: 1, action: "a", resource: "contacts", resourceId: "c1", actor: "alice", org: "o1" });
    await s.store.append({ ts: 2, action: "a", resource: "deals", resourceId: "d1", actor: "bob", org: "o2" });
    await s.store.append({ ts: 3, action: "a", resource: "contacts", resourceId: "c2", actor: "bob", org: "o1" });
    return s;
  }

  test("without an access plugin, requires the admin role", async () => {
    const { app } = await filled();
    expect((await send(app, "GET", "/audit")).status).toBe(401);
    const denied = await send(app, "GET", "/audit", { "x-user": "bob" });
    expect(denied.status).toBe(403);
    const { error } = await denied.json();
    expect(error.code).toBe("MIU_E_FORBIDDEN");
    expect(error.fix).toContain("admin");
    const ok = await send(app, "GET", "/audit?resource=contacts&limit=1", { "x-user": "alice" });
    expect(ok.status).toBe(200);
    const page = await ok.json();
    expect(page.items.map((r: any) => r.resourceId)).toEqual(["c2"]);
    const next = await (await send(app, "GET", `/audit?resource=contacts&limit=1&cursor=${page.nextCursor}`, { "x-user": "alice" })).json();
    expect(next.items.map((r: any) => r.resourceId)).toEqual(["c1"]);
  });

  test("filters by actor, resourceId and time; rejects bad input", async () => {
    const { app } = await filled();
    const a = await (await send(app, "GET", "/audit?actor=bob", { "x-user": "alice" })).json();
    expect(a.items.map((r: any) => r.seq)).toEqual([3, 2]);
    const b = await (await send(app, "GET", "/audit?since=2&until=3", { "x-user": "alice" })).json();
    expect(b.items.map((r: any) => r.seq)).toEqual([2]);
    expect((await send(app, "GET", "/audit?limit=0", { "x-user": "alice" })).status).toBe(400);
    expect((await send(app, "GET", "/audit?since=yesterday", { "x-user": "alice" })).status).toBe(400);
  });

  test("an active org restricts results to that org, and asking for another org is refused", async () => {
    const { app } = await filled();
    const res = await (await send(app, "GET", "/audit", { "x-user": "alice", "x-test-org": "o2" })).json();
    expect(res.items.map((r: any) => r.org)).toEqual(["o2"]);
    const other = await send(app, "GET", "/audit?org=o1", { "x-user": "alice", "x-test-org": "o2" });
    expect(other.status).toBe(403);
    expect((await other.json()).error.code).toBe("MIU_E_AUDIT_ORG_MISMATCH");
  });

  test("with ctx.can (structural), the permission decides — not the admin role", async () => {
    const canPlugin = definePlugin({
      name: "can",
      onRequest(ctx) {
        (ctx as any).can = (p: string) => ctx.user?.id === "bob" && p === "audit:read";
      },
    });
    const { app } = await filled({}, [testAuth, canPlugin]);
    expect((await send(app, "GET", "/audit", { "x-user": "bob" })).status).toBe(200);
    const denied = await send(app, "GET", "/audit", { "x-user": "alice" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.fix).toContain("audit:read");
  });

  test("custom permission option", async () => {
    const canPlugin = definePlugin({
      name: "can",
      onRequest(ctx) {
        (ctx as any).can = (p: string) => p === "compliance:view";
      },
    });
    const { app } = await filled({ permission: "compliance:view" }, [testAuth, canPlugin]);
    expect((await send(app, "GET", "/audit", { "x-user": "bob" })).status).toBe(200);
  });

  test("with the real access plugin: org-scoped, permission-checked, cross-tenant refused", async () => {
    const database = sqlite();
    const orgs = accessStore(database);
    const A = await orgs.createOrg({ name: "A", ownerId: "alice" });
    const B = await orgs.createOrg({ name: "B", ownerId: "bob" });
    await orgs.addMember(A.id, "bob", "member");
    const roles = defineRoles({ owner: ["*"], member: ["contacts:read"] });
    const { app, store } = makeApp({}, [testAuth, access({ roles, database, routes: false })]);
    await store.append({ ts: 1, action: "x", resource: "contacts", org: A.id });
    await store.append({ ts: 2, action: "x", resource: "contacts", org: B.id });
    const own = await send(app, "GET", "/audit", { "x-user": "alice", "x-org-id": A.id });
    expect(own.status).toBe(200);
    expect((await own.json()).items.map((r: any) => r.org)).toEqual([A.id]);
    expect((await send(app, "GET", `/audit?org=${B.id}`, { "x-user": "alice", "x-org-id": A.id })).status).toBe(403);
    expect((await send(app, "GET", "/audit", { "x-user": "alice", "x-org-id": B.id })).status).toBe(403);
    expect((await send(app, "GET", "/audit", { "x-user": "bob", "x-org-id": A.id })).status).toBe(403);
    // ctx.org from access is picked up by ctx.audit.log
    await send(app, "POST", "/contacts/c9", { "x-user": "alice", "x-org-id": A.id }, { after: { a: 1 } });
    expect((await store.query({ resourceId: "c9" })).items[0].org).toBe(A.id);
  });

  test("is an MCP tool with a summary; routes: false removes it", async () => {
    const { app } = makeApp();
    await app.ready();
    const info = app.inspect();
    const r = info.routes.find((x: any) => x.name === "audit_query")!;
    expect(r.summary).toBeTruthy();
    expect(r.auth).toBe("required");
    expect(info.mcp!.tools).toContain("audit_query");
    const none = miu({ logLevel: "silent", plugins: [audit({ store: memoryAuditStore(), routes: false })] });
    await none.ready();
    expect(none.inspect().routes.length).toBe(0);
  });
});

describe("auth: true", () => {
  const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };
  function authApp(store: AuditStore, on = true) {
    return miu({
      logLevel: "silent",
      plugins: [session({ secret: SECRET }), auth({ users: memoryUserStore(), password: FAST, rateLimit: false }), audit({ store, auth: on })],
    });
  }
  const post = (jar: Jar, path: string, body?: unknown) =>
    jar.request(`${BASE}${path}`, { method: "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("logs register, failed login, login and logout, never the password", async () => {
    const store = memoryAuditStore();
    const app = authApp(store);
    const jar = new Jar();
    const reg = await app.fetch(post(jar, "/auth/register", { email: "Ann@example.com", password: "correct horse battery" }));
    expect(reg.status).toBe(201);
    jar.store(reg);
    const userId = (await reg.json()).user.id;
    const bad = await app.fetch(post(new Jar(), "/auth/login", { email: "ann@example.com", password: "wrong password!!" }));
    expect(bad.status).toBe(401);
    const good = await app.fetch(post(new Jar(), "/auth/login", { email: "ann@example.com", password: "correct horse battery" }));
    expect(good.status).toBe(200);
    const out = await app.fetch(post(jar, "/auth/logout"));
    expect(out.status).toBe(204);

    const rows = (await store.query({ resource: "auth" })).items.reverse();
    expect(rows.map((r) => [r.action, (r.metadata as any).outcome])).toEqual([
      ["auth.register", "success"],
      ["auth.login", "failure"],
      ["auth.login", "success"],
      ["auth.logout", "success"],
    ]);
    expect(rows[0].actor).toBe(userId);
    expect(rows[1].actor).toBeNull();
    expect(rows[1].metadata).toMatchObject({ status: 401, code: "MIU_E_AUTH_INVALID", email: "ann@example.com" });
    expect(rows[2].actor).toBe(userId);
    expect(rows[2].metadata).not.toHaveProperty("email");
    expect(rows[3].actor).toBe(userId);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("correct horse battery");
    expect(raw).not.toContain("wrong password!!");
  });

  test("validation failures are logged without the body", async () => {
    const store = memoryAuditStore();
    const app = authApp(store);
    await app.fetch(post(new Jar(), "/auth/login", { email: "not-an-email", password: "hunter2hunter2" }));
    const [r] = (await store.query({})).items;
    expect(r.action).toBe("auth.login");
    expect(r.metadata).toMatchObject({ outcome: "failure", status: 400 });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  test("off by default", async () => {
    const store = memoryAuditStore();
    const app = authApp(store, false);
    await app.fetch(post(new Jar(), "/auth/login", { email: "ann@example.com", password: "whatever-pass" }));
    expect((await store.query({})).items.length).toBe(0);
  });

  test("a failing store does not break sign-in", async () => {
    const broken: AuditStore = { ...memoryAuditStore(), kind: "broken", append: async () => { throw new Error("disk full"); } };
    const app = authApp(broken);
    const res = await app.fetch(post(new Jar(), "/auth/register", { email: "x@example.com", password: "correct horse battery" }));
    expect(res.status).toBe(201);
  });
});

describe("hooks", () => {
  test("inspect and cloudflare", async () => {
    const plugin = audit({ store: dbAuditStore(d1("AUDIT")), redact: ["mrn"] });
    expect(plugin.cloudflare!()).toEqual({ d1: ["AUDIT"] });
    expect(plugin.inspect!()).toMatchObject({ store: { store: "db", table: "audit_log" }, auth: false, permission: "audit:read", redact: ["mrn"] });
  });
  test("store is required", () => {
    expect(() => audit({} as any)).toThrow(/store/);
  });
});
