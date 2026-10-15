import { describe, expect, test } from "bun:test";
import { miu, route, t, type Plugin } from "miujs";
import { session, timingSafeEqual, type SessionOptions } from "../src/index.ts";
import { Jar, SECRET } from "./helpers.ts";

const BASE = "http://localhost";

function makeApp(opts: Partial<SessionOptions> = {}, extra: { dev?: boolean; plugins?: Plugin[] } = {}) {
  return miu({
    dev: extra.dev,
    logLevel: "silent",
    plugins: [session({ secret: SECRET, ...opts }), ...(extra.plugins ?? [])],
    routes: [
      route.get("/get/:key", { params: t.object({ key: t.string() }), handler: (c) => ({ value: c.session.get(c.params.key) ?? null, id: c.session.id }) }),
      route.post("/set/:key", {
        params: t.object({ key: t.string() }),
        body: t.object({ value: t.any() }),
        handler: (c) => {
          c.session.set(c.params.key, c.body.value);
          return { ok: true };
        },
      }),
      route.post("/delete/:key", { params: t.object({ key: t.string() }), handler: (c) => void c.session.delete(c.params.key) }),
      route.post("/flash", { handler: (c) => void c.session.flash("notice", "saved") }),
      route.post("/regenerate", { handler: (c) => { const before = c.session.id; c.session.regenerate(); return { before, after: c.session.id }; } }),
      route.post("/destroy", { handler: (c) => void c.session.destroy() }),
      route.get("/noop", { handler: () => "ok" }),
      route.post("/hook", { tags: ["csrf-exempt"], handler: () => "ok" }),
      route.post("/api", { handler: () => "ok" }),
    ],
  });
}

const json = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });

describe("session basics (signed cookie store)", () => {
  test("set then get across requests", async () => {
    const app = makeApp();
    const jar = new Jar();
    const set = await app.fetch(jar.request(`${BASE}/set/name`, json("Miu")));
    expect(set.status).toBe(200);
    const cookies = jar.store(set);
    expect(cookies.length).toBe(1);
    expect(cookies[0]).toStartWith("miu_session=");
    const got = await app.fetch(jar.request(`${BASE}/get/name`));
    expect((await got.json()).value).toBe("Miu");
  });

  test("no Set-Cookie when the session did not change", async () => {
    const app = makeApp();
    const jar = new Jar();
    expect((await app.fetch(jar.request(`${BASE}/noop`))).headers.getSetCookie()).toEqual([]);
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json(1))));
    expect((await app.fetch(jar.request(`${BASE}/get/a`))).headers.getSetCookie()).toEqual([]);
  });

  test("cookie attributes: HttpOnly, SameSite=Lax, Max-Age 7 days, no Secure on http://localhost", async () => {
    const app = makeApp();
    const [c] = new Jar().store(await app.fetch(new Jar().request(`${BASE}/set/a`, json(1))));
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain(`Max-Age=${7 * 24 * 3600}`);
    expect(c).not.toContain("Secure");
  });

  test("Secure by default on other hosts; custom name and maxAge", async () => {
    const app = makeApp({ cookieName: "sid", maxAge: 60 });
    const [c] = new Jar().store(await app.fetch(new Jar().request("https://example.com/set/a", json(1))));
    expect(c).toStartWith("sid=");
    expect(c).toContain("Secure");
    expect(c).toContain("Max-Age=60");
  });

  test("the cookie is base64url(JSON).signature", async () => {
    const app = makeApp();
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json("x"))));
    const raw = decodeURIComponent(jar.cookies.get("miu_session")!);
    const [payload, sig, extra] = raw.split(".");
    expect(extra).toBeUndefined();
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    expect(decoded.d).toEqual({ a: "x" });
  });

  test("delete() removes a key", async () => {
    const app = makeApp();
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json(1))));
    jar.store(await app.fetch(jar.request(`${BASE}/delete/a`, { method: "POST" })));
    expect((await (await app.fetch(jar.request(`${BASE}/get/a`))).json()).value).toBeNull();
  });

  test("flash() is readable once, on the next request only", async () => {
    const app = makeApp();
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/flash`, { method: "POST" })));
    const first = await app.fetch(jar.request(`${BASE}/get/notice`));
    expect((await first.json()).value).toBe("saved");
    jar.store(first);
    expect((await (await app.fetch(jar.request(`${BASE}/get/notice`))).json()).value).toBeNull();
  });

  test("regenerate() issues a new id and keeps the data", async () => {
    const app = makeApp();
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json("keep"))));
    const res = await app.fetch(jar.request(`${BASE}/regenerate`, { method: "POST" }));
    const { before, after } = await res.json();
    expect(after).not.toBe(before);
    jar.store(res);
    const got = await (await app.fetch(jar.request(`${BASE}/get/a`))).json();
    expect(got).toEqual({ value: "keep", id: after });
  });

  test("destroy() clears data and expires the cookie", async () => {
    const app = makeApp();
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json(1))));
    const res = await app.fetch(jar.request(`${BASE}/destroy`, { method: "POST" }));
    const [c] = res.headers.getSetCookie();
    expect(c).toContain("Max-Age=0");
    jar.store(res);
    expect(jar.cookies.has("miu_session")).toBe(false);
  });
});

describe("session security", () => {
  async function signedJar(app = makeApp()) {
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/role`, json("user"))));
    return { app, jar };
  }

  test("a tampered payload is rejected", async () => {
    const { app, jar } = await signedJar();
    const [payload, sig] = decodeURIComponent(jar.cookies.get("miu_session")!).split(".");
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))), d: { role: "admin" } }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    jar.cookies.set("miu_session", `${forged}.${sig}`);
    expect((await (await app.fetch(jar.request(`${BASE}/get/role`))).json()).value).toBeNull();
  });

  test("a tampered signature is rejected", async () => {
    const { app, jar } = await signedJar();
    const raw = decodeURIComponent(jar.cookies.get("miu_session")!);
    const flipped = raw.slice(0, -2) + (raw.at(-2) === "A" ? "B" : "A") + raw.at(-1);
    jar.cookies.set("miu_session", flipped);
    expect((await (await app.fetch(jar.request(`${BASE}/get/role`))).json()).value).toBeNull();
  });

  test("a cookie signed with another secret is rejected", async () => {
    const { jar } = await signedJar(makeApp({ secret: "another-secret-that-is-also-long-enough-xyz" }));
    const app = makeApp();
    expect((await (await app.fetch(jar.request(`${BASE}/get/role`))).json()).value).toBeNull();
  });

  test("garbage cookies are ignored", async () => {
    const app = makeApp();
    for (const bad of ["", ".", "abc", "a.b.c", "!!!.???", "e30.", ".sig"]) {
      const res = await app.fetch(new Request(`${BASE}/get/role`, { headers: { cookie: `miu_session=${bad}` } }));
      expect(res.status).toBe(200);
      expect((await res.json()).value).toBeNull();
    }
  });

  test("an expired session is rejected", async () => {
    const app = makeApp({ maxAge: 1 });
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json(1))));
    await Bun.sleep(1100);
    expect((await (await app.fetch(jar.request(`${BASE}/get/a`))).json()).value).toBeNull();
  });

  test("secret rotation: old secrets still verify, new cookies use the first", async () => {
    const OLD = "old-secret-that-is-long-enough-0123456789ab";
    const { jar } = await signedJar(makeApp({ secret: OLD }));
    const app = makeApp({ secret: [SECRET, OLD] });
    expect((await (await app.fetch(jar.request(`${BASE}/get/role`))).json()).value).toBe("user");
  });

  test("timingSafeEqual compares every byte", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 5]))).toBe(false);
    expect(timingSafeEqual(a, new Uint8Array([0, 2, 3, 4]))).toBe(false);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  test("short secrets are refused", async () => {
    const app = makeApp({ secret: "short" });
    const res = await app.fetch(new Request(`${BASE}/noop`));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_SESSION_SECRET_WEAK");
  });

  test("missing secret in production: MIU_E_SESSION_SECRET_MISSING with a fix", async () => {
    const app = miu({ dev: false, logLevel: "silent", plugins: [session()], routes: [route.get("/noop", { handler: () => "ok" })] });
    const res = await app.dispatch(new Request(`${BASE}/noop`), {}, { runtime: "workerd" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_SESSION_SECRET_MISSING");
    expect(body.error.fix).toContain("SESSION_SECRET");
  });

  test("env.SESSION_SECRET is used per request (Workers)", async () => {
    const app = miu({
      dev: false,
      logLevel: "silent",
      plugins: [session()],
      routes: [route.post("/set", { handler: (c) => void c.session.set("a", 1) }), route.get("/get", { handler: (c) => ({ a: c.session.get("a") ?? null }) })],
    });
    const env = { SESSION_SECRET: SECRET };
    const jar = new Jar();
    jar.store(await app.dispatch(jar.request(`${BASE}/set`, { method: "POST" }), env, { runtime: "workerd" }));
    expect(await (await app.dispatch(jar.request(`${BASE}/get`), env, { runtime: "workerd" })).json()).toEqual({ a: 1 });
    // Different secret → session invalid.
    expect(await (await app.dispatch(jar.request(`${BASE}/get`), { SESSION_SECRET: SECRET + "x" }, { runtime: "workerd" })).json()).toEqual({ a: null });
  });

  test("missing secret in dev: generates one and warns once", async () => {
    const lines: unknown[] = [];
    const app = miu({
      dev: true,
      logLevel: "silent",
      plugins: [session({ onWarning: (m) => lines.push(m) })],
      routes: [route.post("/set", { handler: (c) => void c.session.set("a", 1) }), route.get("/get", { handler: (c) => ({ a: c.session.get("a") ?? null }) })],
    });
    const jar = new Jar();
    jar.store(await app.dispatch(jar.request(`${BASE}/set`, { method: "POST" }), {}, { runtime: "bun" }));
    expect(await (await app.dispatch(jar.request(`${BASE}/get`), {}, { runtime: "bun" })).json()).toEqual({ a: 1 });
    expect(lines.length).toBe(1);
    expect(String(lines[0])).toContain("SESSION_SECRET");
  });

  test("oversized cookie sessions fail loudly", async () => {
    const app = makeApp();
    const res = await app.fetch(new Jar().request(`${BASE}/set/big`, json("x".repeat(5000))));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_SESSION_TOO_LARGE");
  });

  test("inspect() shows the store but never the secret", () => {
    const info = JSON.stringify(session({ secret: SECRET }).inspect());
    expect(info).toContain("cookie");
    expect(info).not.toContain(SECRET);
  });
});

describe("CSRF", () => {
  async function withCookie() {
    const app = makeApp({ trustedOrigins: ["https://admin.example.com"] });
    const jar = new Jar();
    jar.store(await app.fetch(jar.request(`${BASE}/set/a`, json(1))));
    return { app, cookie: jar.header() };
  }

  test("cross-origin POST with the session cookie → 403 MIU_E_CSRF", async () => {
    const { app, cookie } = await withCookie();
    const res = await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { cookie, origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_CSRF");
    expect(body.error.fix).toBeTruthy();
  });

  test("unsafe methods without Origin or Referer are rejected", async () => {
    const { app, cookie } = await withCookie();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.fetch(new Request(`${BASE}/api`, { method, headers: { cookie } }));
      expect(res.status).toBe(403);
    }
  });

  test("same-origin Origin or Referer passes", async () => {
    const { app, cookie } = await withCookie();
    expect((await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { cookie, origin: BASE } }))).status).toBe(200);
    expect((await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { cookie, referer: `${BASE}/form?x=1` } }))).status).toBe(200);
  });

  test("Origin wins over Referer; a lookalike host fails", async () => {
    const { app, cookie } = await withCookie();
    const res = await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { cookie, origin: "http://localhost.evil.com", referer: `${BASE}/` } }));
    expect(res.status).toBe(403);
    expect((await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { cookie, origin: "null" } }))).status).toBe(403);
  });

  test("GET is never checked", async () => {
    const { app, cookie } = await withCookie();
    expect((await app.fetch(new Request(`${BASE}/noop`, { headers: { cookie, origin: "https://evil.example" } }))).status).toBe(200);
  });

  test("trustedOrigins are allowed", async () => {
    const { app, cookie } = await withCookie();
    expect((await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { cookie, origin: "https://admin.example.com" } }))).status).toBe(200);
  });

  test("routes tagged csrf-exempt skip the check", async () => {
    const { app, cookie } = await withCookie();
    expect((await app.fetch(new Request(`${BASE}/hook`, { method: "POST", headers: { cookie, origin: "https://evil.example" } }))).status).toBe(200);
  });

  test("requests without the session cookie (e.g. Bearer) are exempt", async () => {
    const { app } = await withCookie();
    const res = await app.fetch(new Request(`${BASE}/api`, { method: "POST", headers: { authorization: "Bearer abc", origin: "https://evil.example" } }));
    expect(res.status).toBe(200);
  });
});

describe("verified-cookie cache (perf, audit 2026-10-16)", () => {
  const app = () =>
    miu({
      logLevel: "silent",
      dev: false,
      plugins: [session()],
      routes: [
        route.post("/set", { handler: (ctx) => (ctx.session.set("u", "alice"), "ok") }),
        route.get("/get", { handler: (ctx) => ({ u: ctx.session.get("u") ?? null }) }),
      ],
    });
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const send = (a: ReturnType<typeof app>, path: string, env: Record<string, string>, headers: Record<string, string> = {}, method = "GET") =>
    a.dispatch(new Request(BASE + path, { method, headers: { origin: BASE, ...headers } }), env, { runtime: "bun" });

  test("a cookie verified once is rejected after its secret is rotated out", async () => {
    const a = app();
    const set = await send(a, "/set", { SESSION_SECRET: A }, {}, "POST");
    const cookie = set.headers.getSetCookie()[0].split(";")[0];
    expect(await (await send(a, "/get", { SESSION_SECRET: A }, { cookie })).json()).toEqual({ u: "alice" });
    expect(await (await send(a, "/get", { SESSION_SECRET: A }, { cookie })).json()).toEqual({ u: "alice" });
    // Rotated: B signs, A still verifies.
    expect(await (await send(a, "/get", { SESSION_SECRET: [B, A] as any }, { cookie })).json()).toEqual({ u: "alice" });
    // A removed: the cached verification must not survive.
    expect(await (await send(a, "/get", { SESSION_SECRET: B }, { cookie })).json()).toEqual({ u: null });
    expect(await (await send(a, "/get", { SESSION_SECRET: A }, { cookie })).json()).toEqual({ u: "alice" });
  });

  test("a tampered copy of a cached cookie is still rejected, and changes do not leak between requests", async () => {
    const a = app();
    const set = await send(a, "/set", { SESSION_SECRET: A }, {}, "POST");
    const cookie = set.headers.getSetCookie()[0].split(";")[0];
    await send(a, "/get", { SESSION_SECRET: A }, { cookie });
    const [name, value] = cookie.split("=");
    const dot = value.lastIndexOf(".");
    const tampered = `${name}=${value.slice(0, dot - 2)}xx${value.slice(dot)}`;
    expect(await (await send(a, "/get", { SESSION_SECRET: A }, { cookie: tampered })).json()).toEqual({ u: null });
    expect(await (await send(a, "/get", { SESSION_SECRET: A }, { cookie })).json()).toEqual({ u: "alice" });
  });
});
