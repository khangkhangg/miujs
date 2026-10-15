import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { sessions } from "../../src/batteries/session.ts";
import { memoryStore } from "../../src/batteries/store/index.ts";
import {
  auth,
  createApiKey,
  currentUser,
  hashPassword,
  login,
  logout,
  needsRehash,
  requireAuth,
  revokeApiKey,
  signJwt,
  verifyApiKey,
  verifyJwt,
  verifyPassword,
} from "../../src/batteries/auth/index.ts";

// Generated independently with Python: hashlib.pbkdf2_hmac('sha256', b'miujs-test', salt, iterations, 32)
const DJANGO_100K = "pbkdf2_sha256$100000$Xq3fT9kLmN2pR7sV4wYz1a$TEjYO/Y9sDXaB6iNMtDmUKb8qHIeDQNAzJK2czwJZ+I=";
const DJANGO_260K = "pbkdf2_sha256$260000$a1B2c3D4e5F6g7H8i9J0kL$zgi02BsxkKi7ycPxUnkx7IMMiwjE3rcvxmJxGV3pAWw=";

describe("passwords", () => {
  test("hashPassword produces the Django pbkdf2_sha256 format", async () => {
    const encoded = await hashPassword("hunter2", { iterations: 1000 });
    const [alg, iter, salt, hash] = encoded.split("$");
    expect(alg).toBe("pbkdf2_sha256");
    expect(iter).toBe("1000");
    expect(salt).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(atob(hash!)).toHaveLength(32);
    expect(await verifyPassword("hunter2", encoded)).toBe(true);
    expect(await verifyPassword("hunter3", encoded)).toBe(false);
  });

  test("defaults to 100k iterations and random salts", async () => {
    const a = await hashPassword("pw");
    const b = await hashPassword("pw");
    expect(a).toStartWith("pbkdf2_sha256$100000$");
    expect(a).not.toBe(b);
  });

  test("verifies real Django hashes, including other iteration counts", async () => {
    expect(await verifyPassword("miujs-test", DJANGO_100K)).toBe(true);
    expect(await verifyPassword("miujs-tesT", DJANGO_100K)).toBe(false);
    expect(await verifyPassword("miujs-test", DJANGO_260K)).toBe(true);
  });

  test("unknown or malformed formats never verify", async () => {
    expect(await verifyPassword("pw", "$2y$10$abcdefghijklmnopqrstuuW1nZ5U1m0P0m2v8c5q7aK8m2e7s9xK")).toBe(false);
    expect(await verifyPassword("pw", "md5$salt$hash")).toBe(false);
    expect(await verifyPassword("pw", "pbkdf2_sha256$abc$salt$hash")).toBe(false);
    expect(await verifyPassword("pw", "pbkdf2_sha256$1000$salt$!!!")).toBe(false);
    expect(await verifyPassword("pw", "")).toBe(false);
  });

  test("needsRehash", () => {
    expect(needsRehash(DJANGO_100K)).toBe(false);
    expect(needsRehash(DJANGO_260K)).toBe(true);
    expect(needsRehash(DJANGO_100K, { iterations: 50_000 })).toBe(true);
    expect(needsRehash("$2y$10$whatever")).toBe(true);
  });
});

describe("API keys", () => {
  test("create, verify and revoke; only the hash is stored", async () => {
    const store = memoryStore();
    const { key, id } = await createApiKey(store, { userId: "u1", name: "CI", scopes: ["read"] });
    expect(key).toMatch(/^miu_[\w-]{43}$/);
    const record = await verifyApiKey(store, key);
    expect(record).toMatchObject({ id, userId: "u1", name: "CI", scopes: ["read"] });
    expect(typeof record!.createdAt).toBe("number");

    const raw = store as unknown as { get(k: string): Promise<unknown> };
    expect(await raw.get(`apikey:${key}`)).toBeUndefined();

    expect(await verifyApiKey(store, "miu_nope")).toBeUndefined();
    expect(await verifyApiKey(store, "")).toBeUndefined();
    expect(await revokeApiKey(store, key)).toBe(true);
    expect(await verifyApiKey(store, key)).toBeUndefined();
  });

  test("defaults name and scopes", async () => {
    const store = memoryStore();
    const { key } = await createApiKey(store, { userId: "u2" });
    expect(await verifyApiKey(store, key)).toMatchObject({ userId: "u2", scopes: [] });
  });
});

interface User {
  id: string;
  email: string;
  password: string;
}

function jar() {
  const cookies = new Map<string, string>();
  return {
    cookies,
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    take(res: Response) {
      for (const sc of res.headers.getSetCookie()) {
        const [pair, ...attrs] = sc.split(";");
        const i = pair!.indexOf("=");
        const k = pair!.slice(0, i).trim();
        const v = pair!.slice(i + 1).trim();
        if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0") || v === "") cookies.delete(k);
        else cookies.set(k, v);
      }
    },
  };
}

async function setupApp() {
  const store = memoryStore();
  const users = new Map<string, User>([["1", { id: "1", email: "a@b.c", password: await hashPassword("pw", { iterations: 1000 }) }]]);
  const app = new Miu({ logger: false });
  app.use(sessions({ store, secret: "x".repeat(32) }));
  app.use(
    auth<User>({
      loadUser: async (id) => users.get(id),
      bearer: async (token) => {
        const rec = await verifyApiKey(store, token);
        return rec ? users.get(rec.userId) : undefined;
      },
    }),
  );
  app.post("/login", async (c) => {
    const { email, password } = (await c.req.json()) as { email: string; password: string };
    const user = [...users.values()].find((u) => u.email === email);
    if (!user || !(await verifyPassword(password, user.password))) return c.json({ ok: false }, 401);
    await login(c, user);
    return { ok: true };
  });
  app.post("/logout", async (c) => (await logout(c), { ok: true }));
  app.get("/public", (c) => ({ user: currentUser<User>(c)?.email ?? null }));
  app.use("/admin/*", requireAuth());
  app.get("/admin/me", (c) => ({ email: currentUser<User>(c)!.email }));
  app.use("/app/*", requireAuth({ redirectTo: "/login" }));
  app.get("/app/home", () => "home");

  const j = jar();
  const req = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const ch = j.header();
    if (ch) headers.set("cookie", ch);
    const res = await app.request(path, { ...init, headers });
    j.take(res);
    return res;
  };
  return { app, store, users, req, jar: j };
}

describe("auth middleware", () => {
  test("login → authenticated request → logout via cookies", async () => {
    const { req, jar: j } = await setupApp();
    expect((await req("/admin/me")).status).toBe(401);

    const anonymous = await req("/public");
    expect(anonymous.headers.getSetCookie()).toEqual([]);

    const bad = await req("/login", { method: "POST", body: JSON.stringify({ email: "a@b.c", password: "nope" }) });
    expect(bad.status).toBe(401);

    const ok = await req("/login", { method: "POST", body: JSON.stringify({ email: "a@b.c", password: "pw" }) });
    expect(ok.status).toBe(200);
    expect(j.cookies.has("miu.sid")).toBe(true);

    const me = await req("/admin/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ email: "a@b.c" });
    expect(await (await req("/public")).json()).toEqual({ user: "a@b.c" });

    await req("/logout", { method: "POST" });
    expect(j.cookies.has("miu.sid")).toBe(false);
    expect((await req("/admin/me")).status).toBe(401);
  });

  test("login regenerates the session id (fixation protection)", async () => {
    const { app, req, jar: j } = await setupApp();
    app.post("/visit", async (c) => {
      await (c.get("session") as { set(k: string, v: unknown): Promise<void> }).set("seen", true);
      return "ok";
    });
    await req("/visit", { method: "POST" });
    const before = j.cookies.get("miu.sid")!;
    await req("/login", { method: "POST", body: JSON.stringify({ email: "a@b.c", password: "pw" }) });
    expect(j.cookies.get("miu.sid")!.split(".")[0]).not.toBe(before.split(".")[0]);

    // The pre-login session id is no longer authenticated.
    j.cookies.set("miu.sid", before);
    expect((await req("/admin/me")).status).toBe(401);
  });

  test("bearer API key authenticates without a session", async () => {
    const { req, store } = await setupApp();
    const { key } = await createApiKey(store, { userId: "1" });
    const res = await req("/admin/me", { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "a@b.c" });
    expect(res.headers.getSetCookie()).toEqual([]);

    await revokeApiKey(store, key);
    expect((await req("/admin/me", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });

  test("bearer JWT authenticates", async () => {
    const secret = "jwt-secret-jwt-secret-jwt-secret-!!";
    const app = new Miu({ logger: false });
    app.use(
      auth({
        loadUser: async () => undefined,
        bearer: async (token) => {
          try {
            const p = await verifyJwt(token, secret);
            return { id: p.sub as string };
          } catch {
            return undefined;
          }
        },
      }),
    );
    app.use(requireAuth());
    app.get("/me", (c) => currentUser<{ id: string }>(c));
    const token = await signJwt({ sub: "42" }, secret, { expiresIn: 60 });
    expect(await (await app.request("/me", { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ id: "42" });
    expect((await app.request("/me", { headers: { authorization: "Bearer junk" } })).status).toBe(401);
  });

  test("auth() works without sessions() when only bearer is used", async () => {
    const app = new Miu({ logger: false });
    app.use(auth({ loadUser: async () => undefined }));
    app.get("/", (c) => ({ user: currentUser(c) ?? null }));
    expect(await (await app.request("/")).json()).toEqual({ user: null });
  });

  test("requireAuth returns 401 problem+json for API clients", async () => {
    const { req } = await setupApp();
    const res = await req("/admin/me", { headers: { accept: "application/json" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const body = (await res.json()) as { code: string; detail: string; status: number };
    expect(body.code).toBe("unauthenticated");
    expect(body.status).toBe(401);
    expect(body.detail).toMatch(/Authorization: Bearer/);
  });

  test("requireAuth redirects browsers when redirectTo is set", async () => {
    const { req } = await setupApp();
    const res = await req("/app/home?tab=2", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/app/home?tab=2")}`);

    const api = await req("/app/home", { headers: { accept: "application/json" } });
    expect(api.status).toBe(401);
  });

  test("login() without sessions() throws a helpful error", async () => {
    const app = new Miu({ logger: false });
    let error: unknown;
    app.post("/login", async (c) => {
      try {
        await login(c, { id: 1 });
      } catch (e) {
        error = e;
      }
      return "ok";
    });
    await app.request("/login", { method: "POST" });
    expect(String(error)).toMatch(/sessions\(\)/);
  });
});

describe("API key management by id", () => {
  test("listApiKeys returns a user's keys without secrets; revokeApiKeyById revokes one", async () => {
    const { createApiKey, listApiKeys, revokeApiKeyById, verifyApiKey } = await import("../../src/batteries/auth/index.ts");
    const { memoryStore } = await import("../../src/batteries/store/index.ts");
    const store = memoryStore();
    const a = await createApiKey(store, { userId: "u1", name: "laptop" });
    const b = await createApiKey(store, { userId: "u1", name: "ci", scopes: ["tours:write"] });
    await createApiKey(store, { userId: "u2", name: "other" });
    const listed = await listApiKeys(store, "u1");
    expect(listed.map((k) => k.name).sort()).toEqual(["ci", "laptop"]);
    expect(JSON.stringify(listed)).not.toContain("miu_");
    expect(await revokeApiKeyById(store, b.id)).toBe(true);
    expect(await revokeApiKeyById(store, b.id)).toBe(false);
    expect(await verifyApiKey(store, b.key)).toBeUndefined();
    expect(await verifyApiKey(store, a.key)).toBeDefined();
    expect((await listApiKeys(store, "u1")).map((k) => k.id)).toEqual([a.id]);
  });
});
