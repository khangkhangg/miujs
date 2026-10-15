import { beforeEach, describe, expect, test } from "bun:test";
import { definePlugin, miu, route, type AuthUser } from "miujs";
import { sqlite, type Database } from "@miujs/db";
import { randomBytes } from "node:crypto";
import { bridgeAuth, getLegacySession } from "../src/bridge.ts";
import { djangoDatabaseStore, djangoSession } from "../src/django.ts";
import { laravelDatabaseStore, laravelSession } from "../src/laravel.ts";
import { phpSerialize } from "../src/php.ts";
import { refDumps } from "./reference/django.ts";
import { refCookiePrefix, refEncrypt } from "./reference/laravel.ts";

const KEY = "base64:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const LOGIN_KEY = "login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d";
const SID = "Abcdefghij0123456789Abcdefghij0123456789";
const USERS: Record<string, AuthUser> = { "7": { id: "7", email: "ann@example.com", roles: ["admin"] } };

let db: Database;
let cookie: string;

beforeEach(async () => {
  db = sqlite(":memory:");
  await db.exec("CREATE TABLE sessions (id varchar(255) PRIMARY KEY, user_id integer, ip_address text, user_agent text, payload text NOT NULL, last_activity integer NOT NULL)");
  const payload = Buffer.from(phpSerialize({ _token: "t", [LOGIN_KEY]: 7 })).toString("base64");
  await db.prepare("INSERT INTO sessions VALUES (?, 7, null, null, ?, ?)").bind(SID, payload, Math.floor(Date.now() / 1000)).run();
  cookie = `laravel_session=${encodeURIComponent(refEncrypt(refCookiePrefix("laravel_session", KEY) + SID, KEY, randomBytes(16), { serialize: false }))}`;
});

const me = route.get("/me", { auth: "required", handler: ({ user }) => ({ user }) });
const adminOnly = route.get("/admin", { auth: { role: "admin" }, handler: () => ({ ok: true }) });
const update = route.post("/me", { auth: "required", handler: () => ({ updated: true }) });
const legacy = route.get("/legacy", { handler: (ctx) => ({ id: getLegacySession(ctx)?.id ?? null }) });

function makeApp(extra: Partial<Parameters<typeof bridgeAuth>[0]> = {}, before: ReturnType<typeof definePlugin>[] = []) {
  return miu({
    logLevel: "silent",
    routes: [me, adminOnly, update, legacy],
    plugins: [...before, bridgeAuth({ from: laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) }), findUser: async (id) => USERS[id] ?? null, ...extra })],
  });
}

describe("bridgeAuth", () => {
  test("a request with the old app's session is signed in to MiuJS", async () => {
    const res = await makeApp().request("/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ id: "7", email: "ann@example.com" });
    expect((await makeApp().request("/admin", { headers: { cookie } })).status).toBe(200);
  });

  test("no cookie, no user", async () => {
    expect((await makeApp().request("/me")).status).toBe(401);
  });

  test("findUser returning null leaves the request signed out", async () => {
    const app = makeApp({ findUser: async () => null });
    expect((await app.request("/me", { headers: { cookie } })).status).toBe(401);
  });

  test("an existing MiuJS user wins", async () => {
    const native = definePlugin({ name: "native-auth", onRequest(ctx) { ctx.user = { id: "native", roles: [] }; } });
    const res = await makeApp({}, [native]).request("/me", { headers: { cookie } });
    expect((await res.json()).user.id).toBe("native");
  });

  test("exposes the legacy session to handlers", async () => {
    expect(await (await makeApp().request("/legacy", { headers: { cookie } })).json()).toEqual({ id: SID });
  });

  describe("cross-site requests riding the old cookie are refused", () => {
    test("unsafe method from another origin", async () => {
      const res = await makeApp().request("http://shop.test/me", { method: "POST", headers: { cookie, origin: "https://evil.example" } });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("MIU_E_MIGRATE_CSRF");
    });
    test("unsafe method without Origin or Referer", async () => {
      const res = await makeApp().request("http://shop.test/me", { method: "POST", headers: { cookie } });
      expect(res.status).toBe(403);
    });
    test("same-origin and trusted origins are fine", async () => {
      expect((await makeApp().request("http://shop.test/me", { method: "POST", headers: { cookie, origin: "http://shop.test" } })).status).toBe(200);
      expect((await makeApp().request("http://shop.test/me", { method: "POST", headers: { cookie, referer: "http://shop.test/form" } })).status).toBe(200);
      const trusted = makeApp({ trustedOrigins: ["https://admin.shop.test"] });
      expect((await trusted.request("http://shop.test/me", { method: "POST", headers: { cookie, origin: "https://admin.shop.test" } })).status).toBe(200);
    });
    test("csrf: false turns the check off", async () => {
      expect((await makeApp({ csrf: false }).request("http://shop.test/me", { method: "POST", headers: { cookie } })).status).toBe(200);
    });
  });

  test("works with Django sessions", async () => {
    const d = sqlite(":memory:");
    await d.exec("CREATE TABLE django_session (session_key varchar(40) PRIMARY KEY, session_data text, expire_date datetime)");
    const secret = "django-insecure-test-secret-key-0123456789";
    const key = "abcdefghijklmnopqrstuvwxyz012345";
    const expires = new Date(Date.now() + 3600_000).toISOString().replace("T", " ").replace("Z", "");
    await d.prepare("INSERT INTO django_session VALUES (?, ?, ?)").bind(key, refDumps({ _auth_user_id: "7" }, secret, { salt: "django.contrib.sessions.SessionStore", compress: true }), expires).run();
    const app = miu({ logLevel: "silent", routes: [me], plugins: [bridgeAuth({ from: djangoSession({ secretKey: secret, store: djangoDatabaseStore(d) }), findUser: (id) => USERS[id] ?? null })] });
    const res = await app.request("/me", { headers: { cookie: `sessionid=${key}` } });
    expect((await res.json()).user.id).toBe("7");
  });

  test("inspect shows the source without keys", () => {
    const shown = JSON.stringify(bridgeAuth({ from: laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) }), findUser: () => null }).inspect!());
    expect(shown).toContain("laravel");
    expect(shown).not.toContain("AAECAwQF");
  });
});
