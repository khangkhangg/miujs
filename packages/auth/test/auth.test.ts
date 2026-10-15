import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { memorySessionStore, session, type SessionStore } from "@miujs/session";
import { sqlite } from "@miujs/db";
import { auth, dbUserStore, hashPassword, memoryUserStore, type AuthOptions, type UserStore } from "../src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";

const BASE = "http://localhost";
const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };

function makeApp(opts: Partial<AuthOptions> = {}, store?: SessionStore) {
  const users = opts.users ?? memoryUserStore();
  const app = miu({
    logLevel: "silent",
    mcp: true,
    plugins: [session({ secret: SECRET, store }), auth({ users, password: FAST, ...opts })],
    routes: [
      route.get("/admin", { auth: { role: "admin" }, handler: () => "admin ok" }),
      route.get("/whoami", { auth: "optional", handler: (c) => ({ id: c.user?.id ?? null }) }),
      route.post("/write", { auth: "required", handler: () => "written" }),
      route.get("/sid", { handler: (c) => ({ id: c.session.id }) }),
    ],
  });
  return { app, users };
}

const post = (jar: Jar, path: string, body: unknown, headers: Record<string, string> = {}) =>
  jar.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function register(app: ReturnType<typeof makeApp>["app"], jar = new Jar(), email = "ann@example.com", password = "correct horse battery") {
  const res = await app.fetch(post(jar, "/auth/register", { email, password, name: "Ann" }));
  jar.store(res);
  return { res, jar };
}

describe("register / login / logout / me", () => {
  test("register creates a user, signs in and never returns the hash", async () => {
    const { app } = makeApp();
    const { res, jar } = await register(app);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user).toMatchObject({ email: "ann@example.com", name: "Ann", roles: [] });
    expect(JSON.stringify(body)).not.toContain("pbkdf2");
    const me = await app.fetch(jar.request(`${BASE}/auth/me`));
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("ann@example.com");
  });

  test("duplicate email → 409 MIU_E_AUTH_EMAIL_TAKEN", async () => {
    const { app } = makeApp();
    await register(app);
    const { res } = await register(app, new Jar(), "ANN@example.com");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("MIU_E_AUTH_EMAIL_TAKEN");
  });

  test("weak password → 400 MIU_E_AUTH_PASSWORD_WEAK", async () => {
    const { app } = makeApp();
    const { res } = await register(app, new Jar(), "a@b.co", "short");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_AUTH_PASSWORD_WEAK");
    expect(body.error.fix).toBeTruthy();
  });

  test("invalid email is a validation error", async () => {
    const { app } = makeApp();
    const { res } = await register(app, new Jar(), "not-an-email");
    expect(res.status).toBe(400);
  });

  test("login signs in and regenerates the session id", async () => {
    const { app } = makeApp();
    const { jar } = await register(app);
    const before = (await (await app.fetch(jar.request(`${BASE}/sid`))).json()).id;
    const res = await app.fetch(post(jar, "/auth/login", { email: "Ann@Example.com", password: "correct horse battery" }));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("ann@example.com");
    jar.store(res);
    const after = (await (await app.fetch(jar.request(`${BASE}/sid`))).json()).id;
    expect(after).not.toBe(before);
    expect((await app.fetch(jar.request(`${BASE}/auth/me`))).status).toBe(200);
  });

  for (const [label, store] of [["cookie store", undefined], ["server store", memorySessionStore()]] as const) {
    test(`session fixation (${label}): a planted session does not become the victim's`, async () => {
      const { app } = makeApp({}, store);
      await register(app);
      const { jar: attacker } = await register(app, new Jar(), "mallory@example.com");
      const malloryId = (await (await app.fetch(attacker.request(`${BASE}/auth/me`))).json()).user.id;
      const victim = new Jar();
      for (const [k, v] of attacker.cookies) victim.cookies.set(k, v);
      const login = await app.fetch(post(victim, "/auth/login", { email: "ann@example.com", password: "correct horse battery" }));
      expect(login.status).toBe(200);
      victim.store(login);
      const annId = (await (await app.fetch(victim.request(`${BASE}/auth/me`))).json()).user.id;
      expect(annId).not.toBe(malloryId);
      const me = await app.fetch(attacker.request(`${BASE}/auth/me`));
      if (store) expect(me.status).toBe(401); // old server-side id was deleted
      else expect((await me.json()).user.id).toBe(malloryId);
    });
  }

  test("wrong password and unknown email give the same generic 401", async () => {
    const { app } = makeApp();
    await register(app);
    const wrong = await app.fetch(post(new Jar(), "/auth/login", { email: "ann@example.com", password: "wrong password!!" }));
    const missing = await app.fetch(post(new Jar(), "/auth/login", { email: "zed@example.com", password: "wrong password!!" }));
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    const a = (await wrong.json()).error;
    const b = (await missing.json()).error;
    expect(a.code).toBe("MIU_E_AUTH_INVALID");
    expect(a).toEqual(b);
    expect(wrong.headers.getSetCookie()).toEqual([]);
  });

  test("unknown email still runs a password hash (constant-ish time)", async () => {
    let verifies = 0;
    const counting = {
      hash: async () => "$argon2id$fake",
      verify: async () => (verifies++, false),
    };
    const { app, users } = makeApp({ password: { algorithm: "argon2id", bunPassword: counting } });
    await users.createUser({ email: "x@y.co", roles: [], passwordHash: "$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA" }, {});
    await app.fetch(post(new Jar(), "/auth/login", { email: "missing@y.co", password: "whatever-password" }));
    expect(verifies).toBe(1);
  });

  test("logout destroys the session", async () => {
    const { app } = makeApp();
    const { jar } = await register(app);
    const res = await app.fetch(post(jar, "/auth/logout", {}));
    expect(res.status).toBe(204);
    jar.store(res);
    expect((await app.fetch(jar.request(`${BASE}/auth/me`))).status).toBe(401);
  });

  test("/me without a session → 401", async () => {
    const { app } = makeApp();
    expect((await app.fetch(new Request(`${BASE}/auth/me`))).status).toBe(401);
  });

  test("roles: route.auth { role } uses ctx.user from the session", async () => {
    const { app, users } = makeApp();
    await users.createUser({ email: "boss@example.com", roles: ["admin"], passwordHash: await hashPassword("boss password!", FAST) }, {});
    const { jar } = await register(app);
    expect((await app.fetch(jar.request(`${BASE}/admin`))).status).toBe(403);
    const boss = new Jar();
    boss.store(await app.fetch(post(boss, "/auth/login", { email: "boss@example.com", password: "boss password!" })));
    expect((await app.fetch(boss.request(`${BASE}/admin`))).status).toBe(200);
  });

  test("login transparently re-hashes outdated hashes", async () => {
    const { app, users } = makeApp({ password: { algorithm: "pbkdf2", iterations: 2000 } });
    const u = (await users.createUser({ email: "old@example.com", roles: [], passwordHash: await hashPassword("old password!", FAST) }, {}))!;
    const bcryptUser = (await users.createUser({ email: "bc@example.com", roles: [], passwordHash: await Bun.password.hash("bcrypt password", { algorithm: "bcrypt", cost: 4 }) }, {}))!;
    expect((await app.fetch(post(new Jar(), "/auth/login", { email: "old@example.com", password: "old password!" }))).status).toBe(200);
    expect((await users.findUserById(u.id, {}))!.passwordHash).toStartWith("pbkdf2_sha256$2000$");
    expect((await app.fetch(post(new Jar(), "/auth/login", { email: "bc@example.com", password: "bcrypt password" }))).status).toBe(200);
    expect((await users.findUserById(bcryptUser.id, {}))!.passwordHash).toStartWith("pbkdf2_sha256$2000$");
  });

  test("register: false removes the route", async () => {
    const { app } = makeApp({ register: false });
    expect((await register(app)).res.status).toBe(404);
  });

  test("custom basePath", async () => {
    const { app } = makeApp({ basePath: "/account" });
    expect((await app.fetch(post(new Jar(), "/account/register", { email: "a@b.co", password: "long enough pw" }))).status).toBe(201);
  });
});

describe("API tokens", () => {
  async function tokenFor(app: ReturnType<typeof makeApp>["app"]) {
    const { jar } = await register(app);
    const res = await app.fetch(post(jar, "/auth/tokens", { name: "ci" }));
    expect(res.status).toBe(201);
    return { jar, body: await res.json() };
  }

  test("POST /tokens returns the token once; Bearer authenticates", async () => {
    const { app } = makeApp();
    const { body } = await tokenFor(app);
    expect(body.token).toStartWith("miu_");
    expect(body.id).toBeTruthy();
    const res = await app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${body.token}` } }));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("ann@example.com");
  });

  test("only the SHA-256 hash is stored", async () => {
    const database = sqlite();
    const { app } = makeApp({ users: dbUserStore(database) });
    const { body } = await tokenFor(app);
    const row = await database.prepare("SELECT * FROM api_tokens").first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(body.token);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.token)));
    expect(row!.token_hash).toBe([...digest].map((b) => b.toString(16).padStart(2, "0")).join(""));
  });

  test("an invalid Bearer token → 401 MIU_E_AUTH_TOKEN_INVALID", async () => {
    const { app } = makeApp();
    const { body } = await tokenFor(app);
    const bad = body.token.slice(0, -1) + (body.token.endsWith("A") ? "B" : "A");
    const res = await app.fetch(new Request(`${BASE}/whoami`, { headers: { authorization: `Bearer ${bad}` } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("MIU_E_AUTH_TOKEN_INVALID");
  });

  test("Bearer requests are CSRF-exempt (no cookie)", async () => {
    const { app } = makeApp();
    const { body } = await tokenFor(app);
    const res = await app.fetch(new Request(`${BASE}/write`, { method: "POST", headers: { authorization: `Bearer ${body.token}`, origin: "https://elsewhere.example" } }));
    expect(res.status).toBe(200);
  });

  test("cookie-authenticated cross-site writes are blocked", async () => {
    const { app } = makeApp();
    const { jar } = await register(app);
    const res = await app.fetch(new Request(`${BASE}/write`, { method: "POST", headers: { cookie: jar.header(), origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_CSRF");
  });

  test("expired tokens are rejected", async () => {
    const { app, users } = makeApp();
    const { body } = await tokenFor(app);
    const rec = (await users.findTokenByHash(await sha256hex(body.token), {}))!;
    await users.deleteToken(rec.id, rec.userId, {});
    await users.createToken({ ...rec, expiresAt: Date.now() - 1000 }, {});
    expect((await app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${body.token}` } }))).status).toBe(401);
  });

  test("DELETE /tokens/:id revokes only your own token", async () => {
    const { app } = makeApp();
    const { jar, body } = await tokenFor(app);
    const { jar: other } = await register(app, new Jar(), "bob@example.com");
    expect((await app.fetch(other.request(`${BASE}/auth/tokens/${body.id}`, { method: "DELETE" }))).status).toBe(404);
    expect((await app.fetch(jar.request(`${BASE}/auth/tokens/${body.id}`, { method: "DELETE" }))).status).toBe(204);
    expect((await app.fetch(new Request(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${body.token}` } }))).status).toBe(401);
  });

  test("POST /tokens requires auth", async () => {
    const { app } = makeApp();
    expect((await app.fetch(post(new Jar(), "/auth/tokens", { name: "x" }))).status).toBe(401);
  });
});

async function sha256hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Turnstile", () => {
  function turnstileApp(success: boolean, seen: FormData[] = []) {
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init!.body as FormData);
      return Response.json({ success });
    };
    return makeApp({ turnstile: { secretKey: "ts-secret", fetch: fakeFetch as typeof fetch } }).app;
  }

  test("missing token → 403 MIU_E_AUTH_TURNSTILE_FAILED", async () => {
    const res = await turnstileApp(true).fetch(post(new Jar(), "/auth/register", { email: "a@b.co", password: "long enough pw" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_AUTH_TURNSTILE_FAILED");
  });

  test("a token that siteverify rejects → 403", async () => {
    const res = await turnstileApp(false).fetch(post(new Jar(), "/auth/login", { email: "a@b.co", password: "long enough pw", "cf-turnstile-response": "tok" }));
    expect(res.status).toBe(403);
  });

  test("a valid token passes; secret and token are sent to siteverify", async () => {
    const seen: FormData[] = [];
    const res = await turnstileApp(true, seen).fetch(
      post(new Jar(), "/auth/register", { email: "a@b.co", password: "long enough pw", "cf-turnstile-response": "tok" }, { "cf-connecting-ip": "1.2.3.4" }),
    );
    expect(res.status).toBe(201);
    expect(seen[0].get("secret")).toBe("ts-secret");
    expect(seen[0].get("response")).toBe("tok");
    expect(seen[0].get("remoteip")).toBe("1.2.3.4");
  });
});

describe("plugin wiring", () => {
  test("auth() without session() fails at startup with a fix", async () => {
    const app = miu({ logLevel: "silent", plugins: [auth({ password: FAST })] });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_AUTH_SESSION_REQUIRED" });
  });

  test("routes have summaries and schemas; login/register are hidden from MCP", async () => {
    const { app } = makeApp();
    await app.ready();
    const info = app.inspect();
    const authRoutes = info.routes.filter((r) => r.path.startsWith("/auth"));
    expect(authRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      ["DELETE /auth/tokens/:id", "GET /auth/me", "POST /auth/login", "POST /auth/logout", "POST /auth/register", "POST /auth/tokens"].sort(),
    );
    for (const r of authRoutes) expect(r.summary).toBeTruthy();
    expect(info.mcp!.tools).not.toContain("auth_login");
    expect(info.mcp!.tools).not.toContain("auth_register");
    expect(info.mcp!.tools).toContain("auth_me");
  });

  test("inspect() shows stores, never secrets", () => {
    const users: UserStore = dbUserStore(sqlite());
    const info = JSON.stringify(auth({ users, turnstile: { secretKey: "ts-secret-value" } }).inspect());
    expect(info).toContain("db");
    expect(info).toContain("turnstile");
    expect(info).not.toContain("ts-secret-value");
  });
});
