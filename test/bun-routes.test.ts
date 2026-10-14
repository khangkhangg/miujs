import { afterAll, describe, expect, test } from "bun:test";
import { Miu, t } from "../src/index.ts";

// Behavior when served through Bun's native router (app.serveOptions / app.listen) must match app.fetch.
const order: string[] = [];
const app = new Miu({ logger: false })
  .use("/admin/*", (c) => c.json({ error: "no" }, 401))
  .use(async (c, next) => {
    await next();
    c.res.headers.set("x-mw", "1");
  })
  .get("/", () => "Hi")
  .get("/users/:id", { params: t.object({ id: t.integer() }) }, (c) => ({ id: c.params.id }))
  .get("/tags/:name", (c) => ({ name: c.params.name }))
  .post("/echo", { body: t.object({ a: t.string() }) }, (c) => c.body)
  .get("/admin/panel", () => "secret")
  .get("/files/*", (c) => ({ rest: c.params["*"] }))
  .all("/any", (c) => c.method)
  .get("/chat", () => "plain get")
  .ws("/chat", { open: (ws) => ws.send("hello") })
  .get("/route-info", (c) => {
    order.push(c.route?.path ?? "none");
    return "ok";
  });

const server = Bun.serve(app.serveOptions({ port: 0 }));
afterAll(() => server.stop(true));
const u = (p: string) => `http://127.0.0.1:${server.port}${p}`;

describe("Bun native routes", () => {
  test("serveOptions registers native routes and keeps a fetch fallback", () => {
    const o = app.serveOptions();
    expect(typeof o.fetch).toBe("function");
    expect(Object.keys(o.routes)).toEqual(expect.arrayContaining(["/", "/users/:id", "/echo"]));
    // Delegated to fetch: wildcard, ALL and paths shared with WebSocket routes
    expect(Object.keys(o.routes)).not.toContain("/files/*");
    expect(Object.keys(o.routes)).not.toContain("/any");
    expect(Object.keys(o.routes)).not.toContain("/chat");
  });

  test("text, params validation and middleware", async () => {
    const r = await fetch(u("/"));
    expect(await r.text()).toBe("Hi");
    expect(r.headers.get("x-mw")).toBe("1");
    expect(await (await fetch(u("/users/5"))).json()).toEqual({ id: 5 });
    expect((await fetch(u("/users/abc"))).status).toBe(422);
  });

  test("percent-encoded params are decoded like the JS router", async () => {
    expect(await (await fetch(u("/tags/hello%20world"))).json()).toEqual({ name: "hello world" });
  });

  test("body validation", async () => {
    const r = await fetch(u("/echo"), { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":"x"}' });
    expect(await r.json()).toEqual({ a: "x" });
  });

  test("path-scoped middleware still applies", async () => {
    expect((await fetch(u("/admin/panel"))).status).toBe(401);
  });

  test("405 with Allow, HEAD, trailing slash and 404 behave as in fetch", async () => {
    const r = await fetch(u("/echo"));
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toContain("POST");
    const h = await fetch(u("/"), { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(await (await fetch(u("/users/7/"))).json()).toEqual({ id: 7 });
    expect((await fetch(u("/nope"))).status).toBe(404);
  });

  test("wildcard and ALL routes via fallback", async () => {
    expect(await (await fetch(u("/files/a/b.txt"))).json()).toEqual({ rest: "a/b.txt" });
    expect(await (await fetch(u("/any"), { method: "PATCH" })).text()).toBe("PATCH");
  });

  test("WebSocket upgrade on a path that also has a GET route", async () => {
    expect(await (await fetch(u("/chat"))).text()).toBe("plain get");
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat`);
    const msg = await new Promise<string>((res, rej) => {
      ws.onmessage = (e) => res(String(e.data));
      ws.onerror = rej;
    });
    expect(msg).toBe("hello");
    ws.close();
  });

  test("c.route is set on the native path", async () => {
    await fetch(u("/route-info"));
    expect(order).toEqual(["/route-info"]);
  });
});
