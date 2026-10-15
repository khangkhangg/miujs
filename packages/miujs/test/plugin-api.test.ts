// Core features batteries asked for: internal routes, declarative permissions, error hooks,
// body size limits, app.drain() and the dev-mode default.
import { describe, expect, test } from "bun:test";
import { definePlugin, errors, isDevDefault, miu, route, t, type Context } from "../src/index.ts";

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("internal routes", () => {
  const app = miu({
    dev: true,
    mcp: true,
    logLevel: "silent",
    routes: [route.get("/public", { handler: () => "p" }), route.get("/_x/preview", { internal: true, handler: () => "i" })],
  });

  test("are served", async () => {
    expect(await (await app.fetch(req("/_x/preview"))).text()).toBe("i");
  });

  test("are hidden from inspect, OpenAPI and MCP", async () => {
    await app.ready();
    expect(app.inspect().routes.map((r: { path: string }) => r.path)).toEqual(["/public"]);
    expect(Object.keys((app.openapi() as { paths: object }).paths)).toEqual(["/public"]);
    expect(app.inspect().mcp?.tools).toEqual(["get_public"]);
  });
});

describe("declarative permissions", () => {
  const accessLike = definePlugin({
    name: "fake-access",
    onRequest(ctx) {
      const perms = (ctx.req.headers.get("x-perms") ?? "").split(",");
      (ctx as Context & { authorize: (p: string) => void }).authorize = (p: string) => {
        if (!perms.includes(p)) throw errors.forbidden(`Missing permission ${p}`);
      };
    },
  });

  test("a route's permission is enforced through ctx.authorize", async () => {
    const app = miu({ plugins: [accessLike], routes: [route.get("/c", { permission: "contacts:read", handler: () => "ok" })] });
    expect((await app.fetch(req("/c", { headers: { "x-perms": "contacts:read" } }))).status).toBe(200);
    expect((await app.fetch(req("/c", { headers: { "x-perms": "deals:read" } }))).status).toBe(403);
  });

  test("a permission without an access plugin fails loudly, never silently allows", async () => {
    const app = miu({ logLevel: "silent", routes: [route.get("/c", { permission: "contacts:read", handler: () => "ok" })] });
    const res = await app.fetch(req("/c"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_PERMISSION_UNCHECKED");
  });

  test("permissions appear in OpenAPI and the MCP tool description", async () => {
    const app = miu({ mcp: true, plugins: [accessLike], routes: [route.get("/c", { name: "list_contacts", permission: "contacts:read", handler: () => "ok" })] });
    await app.ready();
    const op = (app.openapi() as any).paths["/c"].get;
    expect(op["x-permission"]).toBe("contacts:read");
    const list = await (await app.fetch(req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }))).json();
    expect(list.result.tools[0].description).toContain("contacts:read");
  });
});

describe("onError hook", () => {
  test("plugins see the thrown error, then the normal error response is sent", async () => {
    const seen: string[] = [];
    const app = miu({
      logLevel: "silent",
      plugins: [definePlugin({ name: "watch", onError: (_ctx, err) => void seen.push((err as { code?: string }).code ?? "plain") })],
      routes: [route.get("/nf", { handler: () => { throw errors.notFound("thing"); } }), route.get("/boom", { handler: () => { throw new Error("x"); } })],
    });
    expect((await app.fetch(req("/nf"))).status).toBe(404);
    expect((await app.fetch(req("/boom"))).status).toBe(500);
    expect(seen).toEqual(["MIU_E_NOT_FOUND", "plain"]);
  });

  test("a failing onError hook does not change the response", async () => {
    const app = miu({
      logLevel: "silent",
      plugins: [definePlugin({ name: "bad", onError: () => { throw new Error("hook broke"); } })],
      routes: [route.get("/nf", { handler: () => { throw errors.notFound("thing"); } })],
    });
    expect((await app.fetch(req("/nf"))).status).toBe(404);
  });
});

describe("body size limit", () => {
  const big = "x".repeat(2048);
  const app = miu({
    maxBodySize: 1024,
    routes: [
      route.post("/j", { body: t.object({ s: t.string() }), handler: ({ body }) => ({ n: body.s.length }) }),
      route.post("/bigger", { maxBodySize: 4096, body: t.object({ s: t.string() }), handler: ({ body }) => ({ n: body.s.length }) }),
    ],
  });
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.fetch(req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));

  test("rejects a declared Content-Length over the limit with 413", async () => {
    const res = await post("/j", JSON.stringify({ s: big }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("MIU_E_BODY_TOO_LARGE");
  });

  test("rejects an oversized streamed body without Content-Length", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ s: big }))); c.close(); } });
    const res = await app.fetch(req("/j", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
  });

  test("applies to form bodies too", async () => {
    const res = await post("/j", `s=${big}`, { "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(413);
  });

  test("a route can raise its own limit", async () => {
    expect(await (await post("/bigger", JSON.stringify({ s: big }))).json()).toEqual({ n: 2048 });
  });
});

describe("app.drain()", () => {
  test("waits for waitUntil work off Workers", async () => {
    let done = false;
    const app = miu({
      routes: [route.get("/w", { handler: (ctx) => { ctx.waitUntil(new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 20))); return "ok"; } })],
    });
    await app.fetch(req("/w"));
    expect(done).toBe(false);
    await app.drain();
    expect(done).toBe(true);
  });
});

test("isDevDefault follows MIU_ENV and NODE_ENV", () => {
  const prev = { m: process.env.MIU_ENV, n: process.env.NODE_ENV };
  try {
    process.env.MIU_ENV = "production";
    expect(isDevDefault()).toBe(false);
    delete process.env.MIU_ENV;
    process.env.NODE_ENV = "development";
    expect(isDevDefault()).toBe(true);
  } finally {
    if (prev.m === undefined) delete process.env.MIU_ENV; else process.env.MIU_ENV = prev.m;
    if (prev.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev.n;
  }
});
