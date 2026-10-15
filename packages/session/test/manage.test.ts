import { describe, expect, test } from "bun:test";
import { miu, route, t, validate } from "miujs";
import { sqlite } from "../../db/src/index.ts";
import { dbSessionStore, kvSessionStore, memorySessionStore, session, type KVLike, type SessionOptions } from "../src/index.ts";
import { Jar, SECRET } from "./helpers.ts";
import { actionOf, checkContract, listOf, manageCtx, run, section, stat } from "./manage-helpers.ts";

const BASE = "http://localhost";

function setup(opts: Partial<SessionOptions> = {}, env: Record<string, unknown> = {}) {
  const plugin = session({ secret: SECRET, ...opts });
  const app = miu({
    logLevel: "silent",
    plugins: [plugin],
    routes: [
      route.post("/login/:user", { params: t.object({ user: t.string() }), handler: (c) => void c.session.set("userId", c.params.user) }),
      route.get("/me", { handler: (c) => ({ user: c.session.get("userId") ?? null }) }),
    ],
  });
  /** Signs `user` in with a fresh browser; returns its jar and raw session id. */
  const login = async (user: string) => {
    const jar = new Jar();
    jar.store(await app.dispatch(jar.request(`${BASE}/login/${user}`, { method: "POST" }), env, { runtime: "bun" }));
    const signed = decodeURIComponent(jar.cookies.get("miu_session")!);
    return { jar, id: signed.slice(0, signed.lastIndexOf(".")) };
  };
  const me = async (jar: Jar) => (await (await app.dispatch(jar.request(`${BASE}/me`), env, { runtime: "bun" })).json()).user;
  const ctx = () => manageCtx(plugin, env);
  return { plugin, app, login, me, ctx };
}

describe("session manage()", () => {
  test("has one valid 'sessions' section", () => {
    const sections = session({ secret: SECRET }).manage!();
    checkContract(sections);
    expect(sections.map((s) => s.id)).toEqual(["sessions"]);
  });

  test("status: memory store counts active sessions; secrets are never shown", async () => {
    const { plugin, login, ctx } = setup({ store: memorySessionStore() });
    await login("alice");
    await login("bob");
    const { stats } = await section(plugin, "sessions").status!(await ctx());
    expect(stat(stats, "Storage")?.value).toBe("memory");
    expect(stat(stats, "Active sessions")?.value).toBe(2);
    expect(stat(stats, "Max age")?.value).toBe("7d");
    expect(stat(stats, "Secret")?.value).toBe("configured");
    expect(stat(stats, "CSRF check")?.value).toBe(true);
    expect(JSON.stringify(stats)).not.toContain(SECRET);
  });

  test("status: cookie sessions are not countable; a random dev secret is flagged", async () => {
    const plugin = session();
    const ctx = await manageCtx(plugin);
    const { stats } = await section(plugin, "sessions").status!(ctx);
    expect(stat(stats, "Storage")?.value).toBe("cookie");
    expect(stat(stats, "Active sessions")?.value).toBeNull();
    expect(stat(stats, "Active sessions")?.hint).toMatch(/not countable/);
    expect(stat(stats, "Secret")?.value).toBe("random (dev)");
    expect(stat(stats, "Secret")?.tone).toBe("warning");
  });

  test("status shows rotation without revealing keys", async () => {
    const plugin = session({ secret: [SECRET, SECRET.replace("0", "1")] });
    const { stats } = await section(plugin, "sessions").status!(await manageCtx(plugin));
    expect(stat(stats, "Secret")?.value).toBe("configured (2 keys, rotating)");
  });

  test("list shows hashed session ids and users, pages and filters by user", async () => {
    const { plugin, login, ctx } = setup({ store: memorySessionStore() });
    const a1 = await login("alice");
    const a2 = await login("alice");
    const b = await login("bob");
    const c = await ctx();
    const list = listOf(section(plugin, "sessions"), "sessions");
    const all = await list.list({ limit: 10 }, c);
    expect(all.rows.length).toBe(3);
    const text = JSON.stringify(all);
    for (const s of [a1, a2, b]) expect(text).not.toContain(s.id);
    expect(all.rows[0]).toEqual({ session: expect.stringMatching(/^[0-9a-f]{12}$/), user: "alice", expiresAt: expect.any(String), ref: expect.any(String) });
    const p1 = await list.list({ limit: 2 }, c);
    expect(p1.rows.length).toBe(2);
    const p2 = await list.list({ limit: 2, cursor: p1.next }, c);
    expect(p2.rows.length).toBe(1);
    expect(p2.next).toBeUndefined();
    const bobs = await list.list({ limit: 10, search: "bob" }, c);
    expect(bobs.rows.map((r) => r.user)).toEqual(["bob"]);
  });

  test("revoking one session by its row signs that browser out only", async () => {
    const { plugin, login, me, ctx } = setup({ store: memorySessionStore() });
    const a1 = await login("alice");
    const a2 = await login("alice");
    const c = await ctx();
    const list = listOf(section(plugin, "sessions"), "sessions");
    const { rows } = await list.list({ limit: 10 }, c);
    const revoke = actionOf(list, "revoke");
    expect(revoke.danger).toBe(true);
    expect(await run(revoke, { id: rows[0].ref }, c)).toBe(`Revoked session ${rows[0].session}.`);
    expect(await me(a1.jar)).toBeNull();
    expect(await me(a2.jar)).toBe("alice");
    expect(await run(revoke, { id: rows[0].ref }, c)).toBe(`Revoked session ${rows[0].session}.`); // idempotent
    await expect(run(revoke, { id: "not-a-ref" }, c)).rejects.toThrow(/Unknown session reference/);
  });

  test("a row reference from another secret is refused", async () => {
    const a = setup({ store: memorySessionStore() });
    await a.login("alice");
    const { rows } = await listOf(section(a.plugin, "sessions"), "sessions").list({ limit: 1 }, await a.ctx());
    const b = setup({ store: memorySessionStore(), secret: SECRET.replace("t", "T") });
    await expect(run(actionOf(listOf(section(b.plugin, "sessions"), "sessions"), "revoke"), { id: rows[0].ref }, await b.ctx())).rejects.toThrow(/Unknown session reference/);
  });

  test("revokeUser signs every session of one user out, and is idempotent", async () => {
    const { plugin, login, me, ctx } = setup({ store: memorySessionStore() });
    const a1 = await login("alice");
    const a2 = await login("alice");
    const b = await login("bob");
    const c = await ctx();
    const revoke = actionOf(section(plugin, "sessions"), "revokeUser");
    expect(revoke.danger).toBe(true);
    expect(await run(revoke, { userId: "alice" }, c)).toBe('Revoked 2 sessions of user "alice".');
    expect(await me(a1.jar)).toBeNull();
    expect(await me(a2.jar)).toBeNull();
    expect(await me(b.jar)).toBe("bob");
    expect(await run(revoke, { userId: "alice" }, c)).toBe('Revoked 0 sessions of user "alice".');
    expect(validate(revoke.input!, { userId: "" }).ok).toBe(false);
  });

  test("numeric user ids are matched as text", async () => {
    for (const store of [memorySessionStore(), dbSessionStore(sqlite())]) {
      const plugin = session({ secret: SECRET, store });
      const app = miu({ logLevel: "silent", plugins: [plugin], routes: [route.post("/in", { handler: (c) => void c.session.set("userId", 42) })] });
      const jar = new Jar();
      jar.store(await app.fetch(jar.request(`${BASE}/in`, { method: "POST" })));
      const c = await manageCtx(plugin);
      expect((await listOf(section(plugin, "sessions"), "sessions").list({ limit: 5, search: "42" }, c)).rows[0].user).toBe("42");
      expect(await run(actionOf(section(plugin, "sessions"), "revokeUser"), { userId: "42" }, c)).toBe('Revoked 1 session of user "42".');
    }
  });

  test("db store: count, list, revoke one and revoke a user (SQLite / D1)", async () => {
    const database = sqlite();
    const { plugin, login, me, ctx } = setup({ store: dbSessionStore(database) });
    const a = await login("alice");
    const b1 = await login("bob");
    await login("bob");
    const c = await ctx();
    const s = section(plugin, "sessions");
    expect(stat((await s.status!(c)).stats, "Active sessions")?.value).toBe(3);
    const list = listOf(s, "sessions");
    const p1 = await list.list({ limit: 2 }, c);
    expect(p1.rows.length).toBe(2);
    expect(JSON.stringify(p1)).not.toContain(a.id);
    const p2 = await list.list({ limit: 2, cursor: p1.next }, c);
    expect(p2.rows.length).toBe(1);
    expect(p2.next).toBeUndefined();
    const bobs = await list.list({ limit: 10, search: "bob" }, c);
    expect(bobs.rows.map((r) => r.user)).toEqual(["bob", "bob"]);
    await run(actionOf(list, "revoke"), { id: p1.rows[0].ref }, c);
    expect(await me(a.jar)).toBeNull();
    expect(await run(actionOf(s, "revokeUser"), { userId: "bob" }, c)).toBe('Revoked 2 sessions of user "bob".');
    expect(await me(b1.jar)).toBeNull();
    expect(stat((await s.status!(c)).stats, "Active sessions")?.value).toBe(0);
  });

  test("kv store: no count, list or per-user revoke, explained", async () => {
    const data = new Map<string, string>();
    const kv: KVLike = {
      get: async (k) => (data.has(k) ? JSON.parse(data.get(k)!) : null),
      put: async (k, v) => void data.set(k, v),
      delete: async (k) => void data.delete(k),
    };
    const { plugin, ctx } = setup({ store: kvSessionStore(kv) });
    const c = await ctx();
    const s = section(plugin, "sessions");
    expect(stat((await s.status!(c)).stats, "Active sessions")?.hint).toMatch(/not countable/);
    await expect(Promise.resolve(listOf(s, "sessions").list({ limit: 5 }, c))).rejects.toThrow(/cannot list/);
    await expect(run(actionOf(s, "revokeUser"), { userId: "x" }, c)).rejects.toThrow(/cannot find sessions by user/);
  });

  test("cookie sessions: revoking explains that rotating the secret is the way", async () => {
    const { plugin, ctx } = setup();
    const c = await ctx();
    await expect(run(actionOf(section(plugin, "sessions"), "revokeUser"), { userId: "x" }, c)).rejects.toMatchObject({ status: 400, fix: expect.stringMatching(/rotate SESSION_SECRET/) });
  });

  test("list caps the page size at 100", async () => {
    const store = memorySessionStore();
    for (let i = 0; i < 120; i++) await store.set(`id${i}`, { d: {}, e: Date.now() + 60_000 }, 60, {});
    const { plugin, ctx } = setup({ store });
    expect((await listOf(section(plugin, "sessions"), "sessions").list({ limit: 1000 }, await ctx())).rows.length).toBe(100);
  });

  test("expired sessions are neither counted nor listed", async () => {
    const store = memorySessionStore();
    await store.set("old", { d: { userId: "x" }, e: Date.now() - 1 }, 60, {});
    await store.set("new", { d: { userId: "y" }, e: Date.now() + 60_000 }, 60, {});
    const { plugin, ctx } = setup({ store });
    const c = await ctx();
    const s = section(plugin, "sessions");
    expect(stat((await s.status!(c)).stats, "Active sessions")?.value).toBe(1);
    expect((await listOf(s, "sessions").list({ limit: 10 }, c)).rows.map((r) => r.user)).toEqual(["y"]);
  });

  test("settings: maxAge applies to new cookies and is validated", async () => {
    const { plugin, app, ctx } = setup({ store: memorySessionStore() });
    const settings = section(plugin, "sessions").settings!;
    const c = await ctx();
    expect(await settings.get(c)).toEqual({ maxAge: 7 * 24 * 3600 });
    expect(validate(settings.schema, { maxAge: 30 }).ok).toBe(false);
    expect(validate(settings.schema, { maxAge: 3600.5 }).ok).toBe(false);
    expect(validate(settings.schema, {}).ok).toBe(false);
    await settings.set({ maxAge: 3600 }, c);
    expect(await settings.get(c)).toEqual({ maxAge: 3600 });
    const jar = new Jar();
    const res = await app.fetch(jar.request(`${BASE}/login/zed`, { method: "POST" }));
    expect(res.headers.getSetCookie()[0]).toContain("Max-Age=3600");
    expect(stat((await section(plugin, "sessions").status!(c)).stats, "Max age")?.value).toBe("1h");
  });
});

describe("session manage() limits", () => {
  test("active sessions are capped at 10000+", async () => {
    const store = memorySessionStore();
    const e = Date.now() + 60_000;
    for (let i = 0; i < 10_001; i++) await store.set(`id${i}`, { d: {}, e }, 60, {});
    const { plugin, ctx } = setup({ store });
    expect(stat((await section(plugin, "sessions").status!(await ctx())).stats, "Active sessions")?.value).toBe("10000+");
  });

  test("db store skips expired sessions in count and list", async () => {
    const database = sqlite();
    const store = dbSessionStore(database);
    await store.set("old", { d: { userId: "x" }, e: Date.now() - 1000 }, 60, {});
    await store.set("new", { d: { userId: "y" }, e: Date.now() + 60_000 }, 60, {});
    const { plugin, ctx } = setup({ store });
    const c = await ctx();
    const s = section(plugin, "sessions");
    expect(stat((await s.status!(c)).stats, "Active sessions")?.value).toBe(1);
    expect((await listOf(s, "sessions").list({ limit: 10 }, c)).rows.map((r) => r.user)).toEqual(["y"]);
  });
});
