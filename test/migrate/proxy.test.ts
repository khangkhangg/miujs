import { afterAll, describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { openapi } from "../../src/ai/openapi.ts";
import { legacyFallback, legacyProxy } from "../../src/migrate/proxy.ts";

/** A stand-in "legacy PHP app" on a real socket. */
const legacy = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/cookies") {
      const h = new Headers({ "content-type": "text/plain" });
      h.append("set-cookie", "a=1; Path=/");
      h.append("set-cookie", "b=2; Path=/; HttpOnly");
      return new Response("ok", { headers: h });
    }
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/login.php" } });
    if (url.pathname === "/abs-redirect") return new Response(null, { status: 301, headers: { location: `${url.origin}/new.php?x=1` } });
    if (url.pathname === "/slow") {
      await Bun.sleep(500);
      return new Response("late");
    }
    if (url.pathname === "/stream") {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(ctl) {
            for (const part of ["one,", "two,", "three"]) {
              ctl.enqueue(enc.encode(part));
              await Bun.sleep(5);
            }
            ctl.close();
          },
        }),
      );
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    return Response.json(
      { legacy: true, method: req.method, path: url.pathname, search: url.search, headers, body: await req.text() },
      { headers: { "x-powered-by": "PHP/5.6", connection: "keep-alive", "keep-alive": "timeout=5" } },
    );
  },
});
const TARGET = `http://localhost:${legacy.port}`;
afterAll(() => legacy.stop(true));

function makeApp(opts: Partial<Parameters<typeof legacyProxy>[0]> = {}) {
  const app = new Miu({ logger: false });
  app.use(openapi());
  app.use(legacyProxy({ target: TARGET, ...opts }));
  app.get("/users/:id", (c) => ({ miu: true, id: c.params.id }));
  return app;
}

describe("legacyProxy", () => {
  const app = makeApp();

  test("routes Miu handles stay in Miu", async () => {
    expect(await (await app.request("/users/7")).json()).toEqual({ miu: true, id: "7" });
  });

  test("middleware-handled paths registered earlier still work", async () => {
    const res = await app.request("/openapi.json");
    expect((await res.json()).openapi).toBeDefined();
  });

  test("unknown paths are forwarded with method, query, headers and body", async () => {
    const res = await app.request("http://shop.example.com/cart.php?add=3&qty=1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: "PHPSESSID=abc", "x-custom": "1", connection: "x-custom-hop", "x-custom-hop": "drop-me" },
      body: "a=1&b=2",
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ legacy: true, method: "POST", path: "/cart.php", search: "?add=3&qty=1", body: "a=1&b=2" });
    expect(j.headers.cookie).toBe("PHPSESSID=abc");
    expect(j.headers["x-custom"]).toBe("1");
    expect(j.headers["x-custom-hop"]).toBeUndefined();
    expect(j.headers["x-forwarded-proto"]).toBe("http");
    expect(j.headers["x-forwarded-host"]).toBe("shop.example.com");
    expect(j.headers.host).toBe(`localhost:${legacy.port}`);
    expect(res.headers.get("x-powered-by")).toBe("PHP/5.6");
    expect(res.headers.get("keep-alive")).toBeNull();
  });

  test("method mismatch on a Miu path is forwarded too", async () => {
    const j = await (await app.request("/users/7", { method: "DELETE" })).json();
    expect(j).toMatchObject({ legacy: true, method: "DELETE", path: "/users/7" });
  });

  test("appends to x-forwarded-for", async () => {
    const j = await (await app.request("/x", { headers: { "x-forwarded-for": "1.2.3.4" } })).json();
    expect(j.headers["x-forwarded-for"]).toBe("1.2.3.4");
    const app2 = makeApp({ clientIp: () => "9.9.9.9" });
    const j2 = await (await app2.request("/x", { headers: { "x-forwarded-for": "1.2.3.4" } })).json();
    expect(j2.headers["x-forwarded-for"]).toBe("1.2.3.4, 9.9.9.9");
  });

  test("forwardHost keeps the original Host header", async () => {
    const j = await (await makeApp({ forwardHost: true }).request("http://shop.example.com/x")).json();
    expect(j.headers.host).toBe("shop.example.com");
  });

  test("preserves multiple set-cookie headers", async () => {
    const res = await app.request("/cookies");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
  });

  test("does not follow redirects; absolute legacy URLs are rewritten to the public origin", async () => {
    const res = await app.request("/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login.php");
    const abs = await app.request("https://shop.example.com/abs-redirect");
    expect(abs.status).toBe(301);
    expect(abs.headers.get("location")).toBe("https://shop.example.com/new.php?x=1");
  });

  test("streams response bodies", async () => {
    expect(await (await app.request("/stream")).text()).toBe("one,two,three");
  });

  test("rewrite maps paths", async () => {
    const j = await (await makeApp({ rewrite: (p) => "/legacy" + p }).request("/a?b=1")).json();
    expect(j.path).toBe("/legacy/a");
    expect(j.search).toBe("?b=1");
  });

  test("target base path is prepended", async () => {
    const a = new Miu({ logger: false }).use(legacyProxy({ target: `${TARGET}/old/` }));
    expect((await (await a.request("/x.php")).json()).path).toBe("/old/x.php");
  });

  test("timeout returns 504; unreachable origin returns 502", async () => {
    expect((await makeApp({ timeout: 50 }).request("/slow")).status).toBe(504);
    const dead = new Miu({ logger: false }).use(legacyProxy({ target: "http://127.0.0.1:1" }));
    expect((await dead.request("/x")).status).toBe(502);
  });

  test("routes added after the first request are picked up", async () => {
    const a = makeApp();
    await a.request("/late");
    a.get("/late", () => "miu");
    expect(await (await a.request("/late")).text()).toBe("miu");
  });
});

describe("legacyFallback", () => {
  test("forwards unknown paths from app.notFound", async () => {
    const app = new Miu({ logger: false });
    app.get("/users/:id", (c) => ({ miu: true, id: c.params.id }));
    app.notFound(legacyFallback({ target: TARGET }));
    expect(await (await app.request("/users/1")).json()).toEqual({ miu: true, id: "1" });
    expect(await (await app.request("/index.php?q=1")).json()).toMatchObject({ legacy: true, path: "/index.php", search: "?q=1" });
    // Known path, other method: Miu answers 405 itself (use legacyProxy to forward these).
    expect((await app.request("/users/1", { method: "POST" })).status).toBe(405);
  });
});
