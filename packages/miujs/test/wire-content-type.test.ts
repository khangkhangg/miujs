// String responses that go straight to Bun.serve skip the `content-type` header on the Response
// object (Bun adds `text/plain;charset=utf-8` on the wire, as it does for Elysia). Anything that
// can observe the Response object keeps the header: app.fetch(req) without Bun's server, app.call,
// internal dispatch (MCP, plugins), onResponse hooks, HEAD, and routes that set their own headers.
import { afterEach, expect, test } from "bun:test";
import { definePlugin, miu, route } from "../src/index.ts";
import type { App } from "../src/app.ts";

const TEXT = "text/plain; charset=utf-8";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

function textApp(extra: Parameters<typeof miu>[0] = {}): App {
  return miu({
    logLevel: "silent",
    ...extra,
    routes: [
      route.get("/", { handler: () => "Hi" }),
      route.get("/created", { status: 201, handler: () => "made" }),
      route.get("/json", { handler: () => ({ a: 1 }) }),
      route.get("/own", { handler: (ctx) => ((ctx.set.headers.set("x-own", "1")), "own") }),
      route.get("/typed", { handler: (ctx) => ((ctx.set.headers.set("content-type", "text/html")), "<b>") }),
      route.get("/cookie", { handler: (ctx) => (ctx.cookies.set("a", "1"), "c") }),
      ...(extra.routes ?? []),
    ],
  });
}

/** Serve `app` the way `export default app` does on Bun, recording each Response object. */
function serveDefault(app: App) {
  // Bun moves the headers out of a Response once it is written, so record them before returning.
  const seen: (string | null)[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req, server) => {
      const res = await app.fetch(req, server);
      seen.push(res.headers.get("content-type"));
      return res;
    },
  });
  stops.push(() => s.stop(true));
  return { url: `http://127.0.0.1:${s.port}`, seen };
}

test("Bun.serve: string route has text/plain on the wire, not on the Response object", async () => {
  const { url, seen } = serveDefault(textApp());
  const res = await fetch(`${url}/`);
  expect(await res.text()).toBe("Hi");
  expect(res.headers.get("content-type")).toMatch(/^text\/plain;\s?charset=utf-8$/i);
  expect(seen[0]).toBeNull();

  const created = await fetch(`${url}/created`);
  expect(created.status).toBe(201);
  expect(await created.text()).toBe("made");
  expect(created.headers.get("content-type")).toMatch(/^text\/plain/i);
  expect(seen[1]).toBeNull();
});

test("Bun.serve: HEAD keeps content-type (Bun adds none to a bodyless HEAD response)", async () => {
  const { url, seen } = serveDefault(textApp());
  const res = await fetch(`${url}/`, { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(TEXT);
  expect(seen[0]).toBe(TEXT);
});

test("listen(): string route has text/plain on the wire", async () => {
  const app = textApp();
  const s = await app.listen(0, "127.0.0.1");
  stops.push(() => s.stop());
  const res = await fetch(s.url);
  expect(await res.text()).toBe("Hi");
  expect(res.headers.get("content-type")).toMatch(/^text\/plain;\s?charset=utf-8$/i);
  const head = await fetch(s.url, { method: "HEAD" });
  expect(head.headers.get("content-type")).toBe(TEXT);
});

test("Bun.serve: routes that set headers, JSON and cookies keep today's headers", async () => {
  const { url, seen } = serveDefault(textApp());
  const own = await fetch(`${url}/own`);
  expect(own.headers.get("x-own")).toBe("1");
  expect(own.headers.get("content-type")).toBe(TEXT);
  expect(seen[0]).toBe(TEXT);

  const typed = await fetch(`${url}/typed`);
  expect(typed.headers.get("content-type")).toBe("text/html");

  const json = await fetch(`${url}/json`);
  expect(await json.json()).toEqual({ a: 1 });
  expect(json.headers.get("content-type")).toMatch(/^application\/json/);
  expect(seen[2]).toMatch(/^application\/json/);

  const cookie = await fetch(`${url}/cookie`);
  expect(await cookie.text()).toBe("c");
  expect(cookie.headers.get("set-cookie")).toContain("a=1");
  expect(cookie.headers.get("content-type")).toMatch(/^text\/plain/i);
});

test("app.fetch(req) without Bun's server keeps the header", async () => {
  const app = textApp();
  const res = await app.fetch(new Request("http://localhost/"));
  expect(res.headers.get("content-type")).toBe(TEXT);
  // A fake server object (tests, other hosts) is not Bun's server.
  const fake = { upgrade: () => false, requestIP: () => null };
  const res2 = await app.fetch(new Request("http://localhost/"), fake);
  expect(res2.headers.get("content-type")).toBe(TEXT);
  const res3 = await app.fetch(new Request("http://localhost/created"));
  expect(res3.headers.get("content-type")).toBe(TEXT);
});

test("with an onResponse plugin the header is on the Response object, even under Bun.serve", async () => {
  const hookSaw: (string | null)[] = [];
  const app = textApp({ plugins: [definePlugin({ name: "obs", onResponse: (_ctx, res) => void hookSaw.push(res.headers.get("content-type")) })] });
  const { url, seen } = serveDefault(app);
  const res = await fetch(`${url}/`);
  expect(await res.text()).toBe("Hi");
  expect(hookSaw).toEqual([TEXT]);
  expect(seen[0]).toBe(TEXT);
});

test("internal dispatch with the request's platform (MCP, plugins) keeps the header", async () => {
  let app!: App;
  app = textApp({
    routes: [
      route.get("/inner", {
        handler: async (ctx) => {
          const platform = (ctx as unknown as { _platform: Parameters<App["dispatch"]>[2] })._platform;
          const r = await app.dispatch(new Request("http://localhost/"), ctx.env, platform);
          return { ct: r.headers.get("content-type") };
        },
      }),
    ],
  });
  const { url } = serveDefault(app);
  const res = await fetch(`${url}/inner`);
  expect(await res.json()).toEqual({ ct: TEXT });
});
