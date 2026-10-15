// Behavior the per-route fast paths must keep. Routes are specialized at startup (by closure
// selection, no code generation) by their static shape; these tests pin down what every variant
// must still do, so a specialization that drops a step fails here.
import { expect, test } from "bun:test";
import { definePlugin, miu, route, t } from "../src/index.ts";
import { pathOf } from "../src/context.ts";

const TEXT = "text/plain; charset=utf-8";

test("pathOf: path without query or fragment, for any scheme", () => {
  const cases: [string, string][] = [
    ["http://localhost/", "/"],
    ["http://localhost/users/42", "/users/42"],
    ["https://example.com/a/b?x=1", "/a/b"],
    ["http://a/x?y#z", "/x"],
    ["http://a/x#z?y", "/x"],
    ["http://a/x#z", "/x"],
    ["http://localhost:3000/p?q=/r", "/p"],
    ["https://h", "/"],
    ["https://h/x/y", "/x/y"],
    ["http://h/x/y", "/x/y"],
    ["ws://h/p?x", "/p"],
    ["file:///tmp/x", "/tmp/x"],
    ["chrome-extension://id/page", "/page"],
  ];
  for (const [url, path] of cases) expect([url, pathOf(url)]).toEqual([url, path]);
});

test("repeated text responses: each is a fresh Response with content-type and its own headers", async () => {
  const app = miu({ logLevel: "silent", routes: [route.get("/", { handler: () => "Hi" })] });
  const seen: Response[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.headers.get("content-type")).toBe(TEXT);
    expect(await res.text()).toBe("Hi");
    // Still there after the body is read (app.call reads the body first).
    expect(res.headers.get("content-type")).toBe(TEXT);
    seen.push(res);
  }
  expect(new Set(seen).size).toBe(5);
  // Mutating one response's headers never leaks into the next.
  const a = await app.fetch(new Request("http://localhost/"));
  a.headers.set("x-mutated", "1");
  a.headers.set("content-type", "text/html");
  const b = await app.fetch(new Request("http://localhost/"));
  expect(b.headers.get("x-mutated")).toBeNull();
  expect(b.headers.get("content-type")).toBe(TEXT);
  expect(await b.text()).toBe("Hi");
});

test("text responses that change between requests are not mixed up", async () => {
  let n = 0;
  const app = miu({ logLevel: "silent", routes: [route.get("/n", { handler: () => `n${n++ % 3}` })] });
  const got: string[] = [];
  for (let i = 0; i < 7; i++) got.push(await (await app.fetch(new Request("http://localhost/n"))).text());
  expect(got).toEqual(["n0", "n1", "n2", "n0", "n1", "n2", "n0"]);
  // Same text twice in a row, then a different one.
  let v = "a";
  const app2 = miu({ logLevel: "silent", routes: [route.get("/", { handler: () => v })] });
  expect(await (await app2.fetch(new Request("http://localhost/"))).text()).toBe("a");
  expect(await (await app2.fetch(new Request("http://localhost/"))).text()).toBe("a");
  expect(await (await app2.fetch(new Request("http://localhost/"))).text()).toBe("a");
  v = "b";
  for (let i = 0; i < 3; i++) {
    const res = await app2.fetch(new Request("http://localhost/"));
    expect(await res.text()).toBe("b");
    expect(res.headers.get("content-type")).toBe(TEXT);
  }
});

test("text route status, ctx.set headers and cookies are kept after a repeated response", async () => {
  let setHeader = false;
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/created", { status: 201, handler: () => "made" }),
      route.get("/h", {
        handler: (ctx) => {
          if (setHeader) ctx.set.headers.set("x-h", "1");
          return "h";
        },
      }),
      route.get("/c", { handler: (ctx) => (ctx.cookies.set("k", "v"), "c") }),
    ],
  });
  for (let i = 0; i < 3; i++) {
    const r = await app.fetch(new Request("http://localhost/created"));
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toBe(TEXT);
    expect(await r.text()).toBe("made");
  }
  for (let i = 0; i < 3; i++) await app.fetch(new Request("http://localhost/h"));
  setHeader = true;
  const h = await app.fetch(new Request("http://localhost/h"));
  expect(h.headers.get("x-h")).toBe("1");
  expect(h.headers.get("content-type")).toBe(TEXT);
  for (let i = 0; i < 3; i++) {
    const c = await app.fetch(new Request("http://localhost/c"));
    expect(c.headers.get("set-cookie")).toContain("k=v");
    expect(await c.text()).toBe("c");
  }
});

test("HEAD on a repeated text route has no body and keeps the headers", async () => {
  const app = miu({ logLevel: "silent", routes: [route.get("/", { handler: () => "Hi" })] });
  await (await app.fetch(new Request("http://localhost/"))).text();
  await (await app.fetch(new Request("http://localhost/"))).text();
  const res = await app.fetch(new Request("http://localhost/", { method: "HEAD" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(TEXT);
  expect(await res.text()).toBe("");
  const again = await app.fetch(new Request("http://localhost/"));
  expect(await again.text()).toBe("Hi");
});

test("onResponse hooks see the text Response with its content-type on every request", async () => {
  const types: (string | null)[] = [];
  const app = miu({
    logLevel: "silent",
    plugins: [definePlugin({ name: "watch", onResponse: (_ctx, res) => void types.push(res.headers.get("content-type")) })],
    routes: [route.get("/", { handler: () => "Hi" })],
  });
  for (let i = 0; i < 3; i++) await app.fetch(new Request("http://localhost/"));
  expect(types).toEqual([TEXT, TEXT, TEXT]);
});

test("params: plain string schemas keep declared key order and the router's values", async () => {
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/a/:x/:y", { params: t.object({ x: t.string(), y: t.string() }), handler: ({ params }) => JSON.stringify(params) }),
      route.get("/b/:x/:y", { params: t.object({ y: t.string(), x: t.string() }), handler: ({ params }) => JSON.stringify(params) }),
      route.get("/c/:id", { params: t.object({ id: t.string() }), handler: ({ params }) => ({ params, keys: Object.keys(params) }) }),
      route.get("/f/*rest", { params: t.object({ rest: t.string() }), handler: ({ params }) => params }),
    ],
  });
  expect(await (await app.fetch(new Request("http://localhost/a/1/2"))).text()).toBe('{"x":"1","y":"2"}');
  expect(await (await app.fetch(new Request("http://localhost/b/1/2"))).text()).toBe('{"y":"2","x":"1"}');
  expect(await (await app.fetch(new Request("http://localhost/c/h%C3%A9"))).json()).toEqual({ params: { id: "hé" }, keys: ["id"] });
  expect(await (await app.fetch(new Request("http://localhost/f/a/b%20c"))).json()).toEqual({ rest: "a/b c" });
});

test("params: constrained, coerced and optional schemas are still validated", async () => {
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/len/:id", { params: t.object({ id: t.string({ minLength: 3 }) }), handler: ({ params }) => params }),
      route.get("/fmt/:id", { params: t.object({ id: t.string({ format: "uuid" }) }), handler: ({ params }) => params }),
      route.get("/pat/:id", { params: t.object({ id: t.string({ pattern: /^a/ }) }), handler: ({ params }) => params }),
      route.get("/num/:id", { params: t.object({ id: t.integer() }), handler: ({ params }) => ({ id: params.id, type: typeof params.id }) }),
      route.get("/enum/:id", { params: t.object({ id: t.enum(["a", "b"]) }), handler: ({ params }) => params }),
    ],
  });
  expect((await app.fetch(new Request("http://localhost/len/ab"))).status).toBe(400);
  expect((await app.fetch(new Request("http://localhost/len/abc"))).status).toBe(200);
  expect((await app.fetch(new Request("http://localhost/fmt/nope"))).status).toBe(400);
  expect((await app.fetch(new Request("http://localhost/pat/bcd"))).status).toBe(400);
  expect((await app.fetch(new Request("http://localhost/pat/abc"))).status).toBe(200);
  expect(await (await app.fetch(new Request("http://localhost/num/7"))).json()).toEqual({ id: 7, type: "number" });
  expect((await app.fetch(new Request("http://localhost/num/x"))).status).toBe(400);
  expect((await app.fetch(new Request("http://localhost/enum/c"))).status).toBe(400);
});

test("params: a hand-built schema that only looks like t.string() is still called", async () => {
  let calls = 0;
  const str = t.string();
  const spy = { ...str, parse: (v: unknown, p: string, i: any[], c: boolean) => (calls++, str.parse(v, p, i, c)) };
  const obj = t.object({ id: spy as typeof str });
  const lookalike = { ...obj, parse: (v: unknown, p: string, i: any[], c: boolean) => ({ ...(obj.parse(v, p, i, c) as object), seen: true }) };
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/spy/:id", { params: obj, handler: ({ params }) => params }),
      route.get("/look/:id", { params: lookalike as unknown as typeof obj, handler: ({ params }) => params }),
    ],
  });
  expect(await (await app.fetch(new Request("http://localhost/spy/1"))).json()).toEqual({ id: "1" });
  expect(calls).toBe(1);
  expect(await (await app.fetch(new Request("http://localhost/look/1"))).json()).toEqual({ id: "1", seen: true });
});

test("params: onRequest hooks that change ctx.params are validated afterwards", async () => {
  const app = miu({
    logLevel: "silent",
    plugins: [
      definePlugin({
        name: "rewrite",
        onRequest(ctx) {
          if (ctx.path === "/u/bad") ctx.params = { id: 42 };
          if (ctx.path === "/u/extra") ctx.params = { id: "x", extra: "dropped" };
        },
      }),
    ],
    routes: [route.get("/u/:id", { params: t.object({ id: t.string() }), handler: ({ params }) => params })],
  });
  expect((await app.fetch(new Request("http://localhost/u/bad"))).status).toBe(400);
  expect(await (await app.fetch(new Request("http://localhost/u/extra"))).json()).toEqual({ id: "x" });
  expect(await (await app.fetch(new Request("http://localhost/u/ok"))).json()).toEqual({ id: "ok" });
});

test("fast routes still run auth, permissions, query and body steps when configured", async () => {
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/auth", { auth: "required", handler: () => "in" }),
      route.get("/perm", { permission: "x:read", handler: () => "in" }),
      route.get("/q", { query: t.object({ n: t.integer() }), handler: ({ query }) => query }),
      route.post("/b", { body: t.object({ n: t.integer() }), handler: ({ body }) => body }),
    ],
  });
  expect((await app.fetch(new Request("http://localhost/auth"))).status).toBe(401);
  expect((await app.fetch(new Request("http://localhost/perm"))).status).toBe(500);
  expect(await (await app.fetch(new Request("http://localhost/q?n=3"))).json()).toEqual({ n: 3 });
  expect((await app.fetch(new Request("http://localhost/q?n=x"))).status).toBe(400);
  const ok = await app.fetch(new Request("http://localhost/b", { method: "POST", headers: { "content-type": "application/json" }, body: '{"n":1}' }));
  expect(await ok.json()).toEqual({ n: 1 });
});

test("static and dynamic routes on other methods, trailing slashes and HEAD still match", async () => {
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/s", { handler: () => "get" }),
      route.post("/s", { handler: () => "post" }),
      route.delete("/s/:id", { params: t.object({ id: t.string() }), handler: ({ params }) => `del ${params.id}` }),
    ],
  });
  expect(await (await app.fetch(new Request("http://localhost/s/"))).text()).toBe("get");
  expect(await (await app.fetch(new Request("http://localhost/s", { method: "POST" }))).text()).toBe("post");
  expect(await (await app.fetch(new Request("http://localhost/s/9", { method: "DELETE" }))).text()).toBe("del 9");
  expect((await app.fetch(new Request("http://localhost/s", { method: "PUT" }))).status).toBe(405);
  expect((await app.fetch(new Request("http://localhost/nope"))).status).toBe(404);
  const head = await app.fetch(new Request("http://localhost/s", { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("async handlers and thrown errors on fast routes", async () => {
  const app = miu({
    logLevel: "silent",
    routes: [
      route.get("/async", { handler: async () => "later" }),
      route.get("/throw", {
        handler: () => {
          throw new Error("boom");
        },
      }),
      route.get("/reject", { handler: async () => Promise.reject(new Error("no")) }),
      route.get("/none", { handler: () => undefined }),
    ],
  });
  const a = await app.fetch(new Request("http://localhost/async"));
  expect(await a.text()).toBe("later");
  expect(a.headers.get("content-type")).toBe(TEXT);
  expect((await app.fetch(new Request("http://localhost/throw"))).status).toBe(500);
  expect((await app.fetch(new Request("http://localhost/reject"))).status).toBe(500);
  expect((await app.fetch(new Request("http://localhost/none"))).status).toBe(204);
});

test("fetch(req, server): each request uses its own server's platform, even when servers alternate", async () => {
  const fake = (address: string) => ({ upgrade: () => false, requestIP: () => ({ address }) });
  const a = fake("1.1.1.1");
  const b = fake("2.2.2.2");
  const app = miu({ logLevel: "silent", routes: [route.get("/ip", { handler: (ctx) => String(ctx.ip) })] });
  const ip = async (server?: unknown) => (await (await app.fetch(new Request("http://localhost/ip"), server)).text());
  expect(await ip(a)).toBe("1.1.1.1");
  expect(await ip(a)).toBe("1.1.1.1");
  expect(await ip(b)).toBe("2.2.2.2");
  expect(await ip(a)).toBe("1.1.1.1");
  expect(await ip()).toBe("undefined");
  expect(await ip(b)).toBe("2.2.2.2");
  expect(await ip({ remoteAddr: { hostname: "3.3.3.3" } })).toBe("3.3.3.3");
  expect(await ip(b)).toBe("2.2.2.2");
});

test("router: static paths sharing a length, unique lengths, trailing slashes and very long paths", async () => {
  const { Router } = await import("../src/router.ts");
  const r = new Router<string>();
  const long1 = "/" + "a".repeat(300);
  const long2 = "/" + "b".repeat(400);
  for (const p of ["/", "/about", "/posts", "/x", long1, long2, "/u/:id"]) r.add(p, p);
  const params: Record<string, string> = {};
  expect(r.lookup("/", params)).toBe("/");
  expect(r.lookup("/about", params)).toBe("/about");
  expect(r.lookup("/posts", params)).toBe("/posts");
  expect(r.lookup("/posts/", params)).toBe("/posts");
  expect(r.lookup("/x", params)).toBe("/x");
  expect(r.lookup("/x/", params)).toBe("/x");
  expect(r.lookup("/y", params)).toBeUndefined();
  expect(r.lookup("/abouu", params)).toBeUndefined();
  expect(r.lookup(long1, params)).toBe(long1);
  expect(r.lookup(long2, params)).toBe(long2);
  expect(r.lookup("/" + "c".repeat(300), params)).toBeUndefined();
  expect(params).toEqual({});
  expect(r.lookup("/u/7", params)).toBe("/u/:id");
  expect(params).toEqual({ id: "7" });
  // A second static path of a length that had one keeps both reachable.
  const r2 = new Router<number>();
  r2.add("/ab", 1);
  expect(r2.lookup("/ab", {})).toBe(1);
  r2.add("/cd", 2);
  expect([r2.lookup("/ab", {}), r2.lookup("/cd", {}), r2.lookup("/ef", {})]).toEqual([1, 2, undefined]);
  // One path longer than the length table still matches.
  const r3 = new Router<number>();
  r3.add(long1, 1);
  expect([r3.lookup(long1, {}), r3.lookup(long2, {})]).toEqual([1, undefined]);
});
