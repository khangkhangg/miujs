import { describe, expect, test } from "bun:test";
import { miu, route, t, type Plugin } from "miujs";
import { sqlite } from "@miujs/db";
import { access, accessStore, defineRoles, policy, tenantScope, type AccessOptions } from "../src/index.ts";
import { session } from "../../session/src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";
import { USERS, testAuth } from "./helpers.ts";

const BASE = "http://localhost";
const roles = defineRoles({
  owner: ["*"],
  admin: ["contacts:*", "deals:*", "members:*"],
  member: ["contacts:read", "contacts:create"],
  editor: ["contacts:read", "contacts:update"],
});
const policies = [policy("contacts", { update: ({ user, record, can }) => record.ownerId === user.id || can("contacts:manage") })];

async function setup(opts: Partial<AccessOptions> = {}, extra: Plugin[] = []) {
  const database = sqlite();
  const store = accessStore(database);
  const A = await store.createOrg({ name: "Acme", ownerId: "alice", ownerEmail: "alice@example.com" });
  const B = await store.createOrg({ name: "Beta", ownerId: "bob", ownerEmail: "bob@example.com" });
  await store.addMember(A.id, "carol", "editor", "carol@example.com");
  await database.exec("CREATE TABLE contacts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT, owner_id TEXT)");
  await database.prepare("INSERT INTO contacts VALUES (?, ?, ?, ?)").bind("c1", A.id, "Acme lead", "carol").run();
  await database.prepare("INSERT INTO contacts VALUES (?, ?, ?, ?)").bind("c2", B.id, "Beta secret", "bob").run();

  const listContacts = async (c: any) => {
    const { results } = await database.prepare("SELECT id, name FROM contacts WHERE org_id = ?").bind(tenantScope(c)).all();
    return { contacts: results };
  };
  const app = miu({
    logLevel: "silent",
    plugins: [...extra, testAuth(USERS), access({ roles, policies, database, ...opts })],
    routes: [
      route.get("/me/org", { auth: "optional", handler: (c) => ({ org: c.org, canRead: c.can("contacts:read") }) }),
      route.get("/contacts", {
        auth: "required",
        handler: async (c) => {
          c.authorize("contacts:read");
          return listContacts(c);
        },
      }),
      route.get("/orgs/:orgId/contacts", {
        auth: "required",
        params: t.object({ orgId: t.string() }),
        handler: async (c) => {
          c.authorize("contacts:read");
          return listContacts(c);
        },
      }),
      route.post("/contacts/:id", {
        auth: "required",
        params: t.object({ id: t.string() }),
        handler: async (c) => {
          const row = await database.prepare("SELECT id, owner_id AS ownerId FROM contacts WHERE id = ? AND org_id = ?").bind(c.params.id, tenantScope(c)).first();
          if (!row) return new Response("nope", { status: 404 });
          c.authorize("contacts:update", row);
          return { updated: c.params.id };
        },
      }),
      route.get("/public", { handler: (c) => ({ org: c.org ?? null, can: c.can("contacts:read") }) }),
      route.get("/scope", { auth: "required", handler: (c) => ({ scope: tenantScope(c) }) }),
    ],
  });
  return { app, database, store, A, B };
}

const get = (app: any, path: string, headers: Record<string, string> = {}): Promise<Response> => app.fetch(new Request(BASE + path, { headers }));
const post = (app: any, path: string, headers: Record<string, string> = {}): Promise<Response> => app.fetch(new Request(BASE + path, { method: "POST", headers }));

describe("ctx.org resolution and membership", () => {
  test("no org requested → ctx.org is null", async () => {
    const { app } = await setup();
    const res = await get(app, "/me/org", { "x-user": "alice" });
    expect(await res.json()).toEqual({ org: null, canRead: false });
  });

  test("x-org-id of an org I belong to → { id, role }", async () => {
    const { app, A } = await setup();
    const res = await get(app, "/me/org", { "x-user": "alice", "x-org-id": A.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ org: { id: A.id, role: "owner" }, canRead: true });
  });

  test("x-org-id of another tenant → 403 MIU_E_ACCESS_NOT_MEMBER, never their data", async () => {
    const { app, B } = await setup();
    const res = await get(app, "/contacts", { "x-user": "alice", "x-org-id": B.id });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("MIU_E_ACCESS_NOT_MEMBER");
    expect(JSON.parse(text).error.fix).toBeTruthy();
    expect(text).not.toContain("Beta secret");
  });

  test("an org that does not exist looks the same as one you are not in", async () => {
    const { app, B } = await setup();
    const a = await get(app, "/me/org", { "x-user": "alice", "x-org-id": "nope" });
    const b = await get(app, "/me/org", { "x-user": "alice", "x-org-id": B.id });
    expect(a.status).toBe(403);
    expect((await a.json()).error).toEqual((await b.json()).error);
  });

  test("tenant data is filtered: each member sees only their org's rows", async () => {
    const { app, A, B } = await setup();
    const a = await (await get(app, "/contacts", { "x-user": "alice", "x-org-id": A.id })).json();
    expect(a.contacts).toEqual([{ id: "c1", name: "Acme lead" }]);
    const b = await (await get(app, "/contacts", { "x-user": "bob", "x-org-id": B.id })).json();
    expect(b.contacts).toEqual([{ id: "c2", name: "Beta secret" }]);
  });

  test("cross-tenant record access by id is impossible (scoped lookup → 404)", async () => {
    const { app, A } = await setup();
    const res = await post(app, "/contacts/c2", { "x-user": "alice", "x-org-id": A.id });
    expect(res.status).toBe(404);
  });

  test("signed out + x-org-id: required routes 401; public routes ignore the header", async () => {
    const { app, A } = await setup();
    expect((await get(app, "/contacts", { "x-org-id": A.id })).status).toBe(401);
    const pub = await get(app, "/public", { "x-org-id": A.id });
    expect(pub.status).toBe(200);
    expect(await pub.json()).toEqual({ org: null, can: false });
  });

  test("path :orgId wins over the header, and is membership-checked", async () => {
    const { app, A, B } = await setup();
    const res = await get(app, `/orgs/${B.id}/contacts`, { "x-user": "alice", "x-org-id": A.id });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_ACCESS_NOT_MEMBER");
    const ok = await get(app, `/orgs/${A.id}/contacts`, { "x-user": "alice", "x-org-id": B.id });
    expect(ok.status).toBe(200);
    expect((await ok.json()).contacts).toEqual([{ id: "c1", name: "Acme lead" }]);
  });

  test("orgFrom: 'path' ignores the header entirely", async () => {
    const { app, A } = await setup({ orgFrom: "path" });
    const res = await get(app, "/me/org", { "x-user": "alice", "x-org-id": A.id });
    expect((await res.json()).org).toBeNull();
  });

  test("removing a membership takes effect on the next request (no caching)", async () => {
    const { app, store, A } = await setup();
    expect((await get(app, "/contacts", { "x-user": "carol", "x-org-id": A.id })).status).toBe(200);
    await store.removeMember(A.id, "carol");
    expect((await get(app, "/contacts", { "x-user": "carol", "x-org-id": A.id })).status).toBe(403);
  });

  test("absurd org ids are rejected as non-membership, not errors", async () => {
    const { app, A } = await setup();
    for (const id of ["x".repeat(500), `${A.id}, other`, "' OR 1=1 --", "%", "_"]) {
      const res = await get(app, "/me/org", { "x-user": "alice", "x-org-id": id });
      expect(res.status).toBe(403);
    }
  });

  test("orgFrom: function", async () => {
    const { app, A } = await setup({ orgFrom: (ctx) => ctx.url.searchParams.get("org") });
    const res = await get(app, `/me/org?org=${A.id}`, { "x-user": "alice" });
    expect((await res.json()).org).toEqual({ id: A.id, role: "owner" });
  });

  test("orgFrom: 'session' reads session key orgId", async () => {
    const database = sqlite();
    const store = accessStore(database);
    const A = await store.createOrg({ name: "Acme", ownerId: "alice" });
    const B = await store.createOrg({ name: "Beta", ownerId: "bob" });
    const app = miu({
      logLevel: "silent",
      plugins: [session({ secret: SECRET }), testAuth(USERS), access({ roles, database, orgFrom: "session" })],
      routes: [
        route.post("/switch/:id", { params: t.object({ id: t.string() }), handler: (c) => void c.session.set("orgId", c.params.id) }),
        route.get("/me/org", { auth: "required", handler: (c) => ({ org: c.org }) }),
      ],
    });
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/switch/${A.id}`, { method: "POST", headers: { "x-user": "alice" } })));
    const res = await app.fetch(jar.request(`${BASE}/me/org`, { headers: { "x-user": "alice", "x-org-id": B.id } }));
    expect((await res.json()).org).toEqual({ id: A.id, role: "owner" });
    jar.store(await app.fetch(jar.request(`${BASE}/switch/${B.id}`, { method: "POST", headers: { "x-user": "alice" } })));
    expect((await app.fetch(jar.request(`${BASE}/me/org`, { headers: { "x-user": "alice" } }))).status).toBe(403);
  });

  test("ctx.org cannot be overwritten by a handler", async () => {
    const database = sqlite();
    const store = accessStore(database);
    const A = await store.createOrg({ name: "Acme", ownerId: "alice" });
    const app = miu({
      logLevel: "silent",
      plugins: [testAuth(USERS), access({ roles, database })],
      routes: [
        route.get("/x", {
          auth: "required",
          handler: (c) => {
            try {
              (c.org as any).role = "owner";
            } catch {}
            return { role: c.org?.role ?? null };
          },
        }),
      ],
    });
    await store.addMember(A.id, "bob", "member");
    expect(await (await get(app, "/x", { "x-user": "bob", "x-org-id": A.id })).json()).toEqual({ role: "member" });
  });
});

describe("ctx.can / ctx.authorize", () => {
  test("authorize: 403 MIU_E_FORBIDDEN with a fix naming the missing permission", async () => {
    const database = sqlite();
    const store = accessStore(database);
    const A = await store.createOrg({ name: "Acme", ownerId: "alice" });
    await store.addMember(A.id, "bob", "member");
    const app = miu({
      logLevel: "silent",
      plugins: [testAuth(USERS), access({ roles, database })],
      routes: [
        route.post("/deals", {
          auth: "required",
          handler: (c) => {
            c.authorize("deals:create");
            return "ok";
          },
        }),
      ],
    });
    const res = await post(app, "/deals", { "x-user": "bob", "x-org-id": A.id });
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error.code).toBe("MIU_E_FORBIDDEN");
    expect(error.message).toContain("deals:create");
    expect(error.fix).toContain("deals:create");
    expect(error.fix).toContain("member");
    expect((await post(app, "/deals", { "x-user": "alice", "x-org-id": A.id })).status).toBe(200);
  });

  test("authorize when signed out → 401 (even on a public route)", async () => {
    const app = miu({
      logLevel: "silent",
      plugins: [testAuth(USERS), access({ roles, database: sqlite() })],
      routes: [
        route.get("/x", {
          handler: (c) => {
            c.authorize("contacts:read");
            return "ok";
          },
        }),
      ],
    });
    const res = await get(app, "/x");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("MIU_E_UNAUTHORIZED");
  });

  test("policies: editor may update own record, not someone else's; owner may update any", async () => {
    const { app, database, A } = await setup();
    await database.prepare("INSERT INTO contacts VALUES (?, ?, ?, ?)").bind("c3", A.id, "Other", "alice").run();
    expect((await post(app, "/contacts/c1", { "x-user": "carol", "x-org-id": A.id })).status).toBe(200);
    const denied = await post(app, "/contacts/c3", { "x-user": "carol", "x-org-id": A.id });
    expect(denied.status).toBe(403);
    const { error } = await denied.json();
    expect(error.code).toBe("MIU_E_FORBIDDEN");
    expect(error.message).toContain("contacts:update");
    expect((await post(app, "/contacts/c3", { "x-user": "alice", "x-org-id": A.id })).status).toBe(200);
  });

  test("global user roles apply only when no org is active; the org role wins inside an org", async () => {
    const database = sqlite();
    const store = accessStore(database);
    const A = await store.createOrg({ name: "Acme", ownerId: "alice" });
    await store.addMember(A.id, "root", "member");
    const app = miu({
      logLevel: "silent",
      plugins: [testAuth(USERS), access({ roles, database })],
      routes: [route.get("/del", { auth: "required", handler: (c) => ({ del: c.can("contacts:delete") }) })],
    });
    expect((await (await get(app, "/del", { "x-user": "root" })).json()).del).toBe(true);
    expect((await (await get(app, "/del", { "x-user": "root", "x-org-id": A.id })).json()).del).toBe(false);
  });
});

describe("tenantScope", () => {
  test("returns the active org id", async () => {
    const { app, A } = await setup();
    expect(await (await get(app, "/scope", { "x-user": "alice", "x-org-id": A.id })).json()).toEqual({ scope: A.id });
  });
  test("throws MIU_E_ACCESS_NO_ORG when no org is active", async () => {
    const { app } = await setup();
    const res = await get(app, "/scope", { "x-user": "alice" });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("MIU_E_ACCESS_NO_ORG");
    expect(error.fix).toContain("x-org-id");
  });
  test("throws when the access plugin is missing", () => {
    expect(() => tenantScope({} as any)).toThrow();
  });
});

describe("config", () => {
  test("no database anywhere → MIU_E_ACCESS_DATABASE_MISSING when an org is needed", async () => {
    const app = miu({ logLevel: "silent", plugins: [testAuth(USERS), access({ roles })], routes: [route.get("/x", { handler: (c) => ({ org: c.org }) })] });
    const res = await get(app, "/x", { "x-user": "alice", "x-org-id": "o1" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_ACCESS_DATABASE_MISSING");
    // Without an org request, roles-only use needs no database.
    expect((await get(app, "/x", { "x-user": "alice" })).status).toBe(200);
  });
  test("uses ctx.db from @miujs/db when no database option is given", async () => {
    const database = sqlite();
    const store = accessStore(database);
    const A = await store.createOrg({ name: "Acme", ownerId: "alice" });
    const dbPlugin: Plugin = {
      name: "db",
      onRequest(ctx) {
        (ctx as any).db = database;
      },
    };
    const app = miu({ logLevel: "silent", plugins: [dbPlugin, testAuth(USERS), access({ roles })], routes: [route.get("/x", { handler: (c) => ({ org: c.org }) })] });
    expect((await (await get(app, "/x", { "x-user": "alice", "x-org-id": A.id })).json()).org).toEqual({ id: A.id, role: "owner" });
  });
  test("the owner role must exist", () => {
    expect(() => access({ roles: defineRoles({ admin: ["*"] }) })).toThrow(/owner/);
  });
});
