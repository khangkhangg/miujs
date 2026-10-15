import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { miu, route, type Context } from "miujs";
import { migrateProxy } from "../src/proxy.ts";

// A fake "old app": echoes what it received, plus a few special paths.
let upstream: ReturnType<typeof Bun.serve>;
let base: string;
const received: { headers: Record<string, string> }[] = [];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `${base}/login?next=%2F` } });
      if (url.pathname === "/redirect-relative") return new Response(null, { status: 302, headers: { location: "/home" } });
      if (url.pathname === "/redirect-away") return new Response(null, { status: 302, headers: { location: "https://accounts.example.com/x" } });
      if (url.pathname === "/cookies") {
        const h = new Headers();
        h.append("set-cookie", `laravel_session=abc; Domain=${url.hostname}; Path=/; HttpOnly`);
        h.append("set-cookie", "XSRF-TOKEN=def; domain=.example.com; Path=/");
        h.append("set-cookie", "plain=1; Path=/");
        return new Response("ok", { headers: h });
      }
      if (url.pathname === "/gzip") return new Response(Bun.gzipSync("compressed hello"), { headers: { "content-encoding": "gzip", "content-type": "text/plain" } });
      if (url.pathname === "/slow") {
        await Bun.sleep(500);
        return new Response("late");
      }
      if (url.pathname === "/missing") return new Response("nope", { status: 404, headers: { "x-old": "1" } });
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      const headers = Object.fromEntries(req.headers);
      received.push({ headers });
      return Response.json({ method: req.method, path: url.pathname, search: url.search, body, bodyLength: body.length, headers }, { headers: { "x-from": "old-app", "proxy-authenticate": "Basic", "keep-alive": "timeout=5" } });
    },
  });
  base = `http://127.0.0.1:${upstream.port}`;
});
afterAll(() => upstream.stop(true));

const ported = route.get("/ported", { handler: () => ({ servedBy: "miujs" }) });
const flagged = route.get("/flagged", { handler: () => ({ servedBy: "miujs" }) });

function makeApp(opts: Partial<Parameters<typeof migrateProxy>[0]> = {}) {
  return miu({ logLevel: "silent", routes: [ported, flagged], plugins: [migrateProxy({ upstream: base, ...opts })] });
}

describe("migrateProxy routing", () => {
  test("routes the app defines are served by MiuJS", async () => {
    const res = await makeApp().request("/ported");
    expect(await res.json()).toEqual({ servedBy: "miujs" });
  });

  test("everything else goes to the old app with method, path, query and body", async () => {
    const res = await makeApp().request("/users/7/edit?tab=a&tab=b&q=%20x", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"name":"Ann"}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-from")).toBe("old-app");
    const echo = await res.json();
    expect(echo).toMatchObject({ method: "PATCH", path: "/users/7/edit", search: "?tab=a&tab=b&q=%20x", body: '{"name":"Ann"}' });
    expect(echo.headers["content-type"]).toBe("application/json");
  });

  test("a matched path with an unmatched method is forwarded too", async () => {
    const res = await makeApp().request("/ported", { method: "POST", body: "x" });
    expect((await res.json()).method).toBe("POST");
  });

  test("ported(ctx) can send a defined route back to the old app", async () => {
    const app = makeApp({ ported: (ctx: Context) => ctx.route?.path !== "/flagged" });
    expect((await (await app.request("/flagged")).json()).path).toBe("/flagged");
    expect((await (await app.request("/ported")).json()).servedBy).toBe("miujs");
  });

  test("routes tagged not-ported (generated stubs) still go to the old app", async () => {
    const stub = route.get("/stub", { tags: ["not-ported"], handler: () => ({ servedBy: "miujs" }) });
    const app = miu({ logLevel: "silent", routes: [stub], plugins: [migrateProxy({ upstream: base })] });
    expect((await (await app.request("/stub")).json()).path).toBe("/stub");
  });

  test("upstream status codes pass through", async () => {
    const res = await makeApp().request("/missing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("nope");
    expect(res.headers.get("x-old")).toBe("1");
  });

  test("streams large bodies", async () => {
    const big = "z".repeat(3 * 1024 * 1024);
    const stream = new Response(big).body!;
    const res = await makeApp().request("/upload", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect((await res.json()).bodyLength).toBe(big.length);
  });

  test("an upstream base path is kept as a prefix", async () => {
    const app = miu({ logLevel: "silent", plugins: [migrateProxy({ upstream: `${base}/legacy/` })] });
    expect((await (await app.request("/a/b?x=1")).json()).path).toBe("/legacy/a/b");
  });

  test("a path like //evil.com never changes the upstream host (no SSRF)", async () => {
    const res = await makeApp().request("http://localhost//evil.example/x");
    const echo = await res.json();
    // (Bun's server folds the double slash; what matters is the host.)
    expect(echo.path).toEndWith("/evil.example/x");
    expect(echo.headers.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  test("HEAD is forwarded without a body", async () => {
    const res = await makeApp().request("/anything", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("migrateProxy headers", () => {
  test("sets X-Forwarded-* and drops what the client claimed", async () => {
    const res = await makeApp().request("https://shop.example.com/fwd", { headers: { "x-forwarded-for": "6.6.6.6", "x-forwarded-host": "evil", "forwarded": "for=6.6.6.6", "x-forwarded-proto": "http" } });
    const h = (await res.json()).headers;
    expect(h["x-forwarded-host"]).toBe("shop.example.com");
    expect(h["x-forwarded-proto"]).toBe("https");
    expect(h["x-forwarded-for"]).toBeUndefined(); // no client IP in-process, and the claimed one is gone
    expect(h.forwarded).toBeUndefined();
  });

  test("X-Forwarded-For is the socket address over the network", async () => {
    const server = await makeApp().listen(0);
    try {
      const res = await fetch(`${server.url}fwd`, { headers: { "x-forwarded-for": "6.6.6.6" } });
      expect((await res.json()).headers["x-forwarded-for"]).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      await server.stop();
    }
  });

  test("trustForwardedHeaders appends to the chain from a trusted load balancer", async () => {
    const server = await makeApp({ trustForwardedHeaders: true }).listen(0);
    try {
      const res = await fetch(`${server.url}fwd`, { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-forwarded-host": "shop.example.com" } });
      const h = (await res.json()).headers;
      expect(h["x-forwarded-for"]).toMatch(/^203\.0\.113\.9, /);
      expect(h["x-forwarded-proto"]).toBe("https");
      expect(h["x-forwarded-host"]).toBe("shop.example.com");
    } finally {
      await server.stop();
    }
  });

  test("strips hop-by-hop request headers, including ones named in Connection", async () => {
    const res = await makeApp().request("/hop", {
      headers: { connection: "x-secret-hop", "x-secret-hop": "1", "proxy-authorization": "Basic Zm9v", te: "trailers", "keep-alive": "300", "x-normal": "kept", cookie: "a=1" },
    });
    const h = (await res.json()).headers;
    expect(h["x-secret-hop"]).toBeUndefined();
    expect(h["proxy-authorization"]).toBeUndefined();
    expect(h.te).toBeUndefined();
    expect(h["x-normal"]).toBe("kept");
    expect(h.cookie).toBe("a=1");
  });

  test("strips hop-by-hop response headers", async () => {
    const res = await makeApp().request("/hop");
    expect(res.headers.get("proxy-authenticate")).toBeNull();
    expect(res.headers.get("keep-alive")).toBeNull();
  });

  test("extra upstream headers (e.g. a shared secret) are added", async () => {
    const res = await makeApp({ headers: { "x-proxy-secret": "s3cret" } }).request("/hdr");
    expect((await res.json()).headers["x-proxy-secret"]).toBe("s3cret");
  });

  test("preserveHost sends the public Host", async () => {
    const res = await makeApp({ preserveHost: true }).request("http://shop.example.com/h");
    expect((await res.json()).headers.host).toBe("shop.example.com");
  });

  test("rewrites absolute Location headers that point at the upstream, without following", async () => {
    const app = makeApp();
    const res = await app.request("https://shop.example.com/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://shop.example.com/login?next=%2F");
    expect((await app.request("/redirect-relative")).headers.get("location")).toBe("/home");
    expect((await app.request("/redirect-away")).headers.get("location")).toBe("https://accounts.example.com/x");
  });

  test("rewrites Set-Cookie domains that name the upstream host; keeps every cookie", async () => {
    const res = await makeApp().request("https://shop.example.com/cookies");
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toBe("laravel_session=abc; Path=/; HttpOnly");
    expect(cookies[1]).toBe("XSRF-TOKEN=def; domain=.example.com; Path=/");
    const withDomain = await makeApp({ cookieDomain: "example.com" }).request("/cookies");
    expect(withDomain.headers.getSetCookie()[0]).toBe("laravel_session=abc; Domain=example.com; Path=/; HttpOnly");
  });

  test("compressed responses reach the client intact", async () => {
    const server = await makeApp().listen(0);
    try {
      const res = await fetch(`${server.url}gzip`);
      expect(await res.text()).toBe("compressed hello");
    } finally {
      await server.stop();
    }
  });
});

describe("migrateProxy failures", () => {
  test("upstream down: 502 MIU_E_MIGRATE_UPSTREAM with a fix", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = dead.port;
    dead.stop(true);
    const app = miu({ logLevel: "silent", plugins: [migrateProxy({ upstream: `http://127.0.0.1:${port}` })] });
    const res = await app.request("/x");
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error.code).toBe("MIU_E_MIGRATE_UPSTREAM");
    expect(error.fix).toContain("upstream");
  });

  test("slow upstream: 504 after the timeout", async () => {
    const res = await makeApp({ timeout: 50 }).request("/slow");
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("MIU_E_MIGRATE_UPSTREAM_TIMEOUT");
  });

  test("WebSocket upgrades are not proxied", async () => {
    const res = await makeApp().request("/ws", { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("MIU_E_MIGRATE_WEBSOCKET");
  });

  test("bad upstream URLs fail at startup", () => {
    for (const bad of ["", "old-app:8000", "ftp://x", "http://user:pass@old-app"]) {
      expect(() => migrateProxy({ upstream: bad })).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_CONFIG" }));
    }
  });

  test("inspect shows the upstream but not header values", () => {
    const p = migrateProxy({ upstream: base, headers: { "x-proxy-secret": "s3cret" } });
    const shown = JSON.stringify(p.inspect!());
    expect(shown).toContain(base);
    expect(shown).not.toContain("s3cret");
  });
});
