import { describe, expect, test } from "bun:test";
import { definePlugin, errors, miu, route, t, type AuthUser } from "../src/index.ts";

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
const json = (body: unknown, method = "POST") =>
  ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as RequestInit;

describe("routing and responses", () => {
  test("GET route returns handler object as JSON", async () => {
    const app = miu({ routes: [route.get("/hello", { handler: () => ({ hi: "there" }) })] });
    const res = await app.fetch(req("/hello"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ hi: "there" });
  });

  test("trailing slash matches the same route", async () => {
    const app = miu({ routes: [route.get("/hello", { handler: () => "ok" })] });
    expect((await app.fetch(req("/hello/"))).status).toBe(200);
  });

  test("string result is text/plain", async () => {
    const app = miu({ routes: [route.get("/t", { handler: () => "plain" })] });
    const res = await app.fetch(req("/t"));
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("plain");
  });

  test("undefined result is 204 No Content", async () => {
    const app = miu({ routes: [route.delete("/x", { handler: () => {} })] });
    const res = await app.fetch(req("/x", { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("Response result passes through", async () => {
    const app = miu({ routes: [route.get("/r", { handler: () => new Response("raw", { status: 418 }) })] });
    const res = await app.fetch(req("/r"));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("raw");
  });

  test("route `status` sets success status", async () => {
    const app = miu({ routes: [route.post("/items", { status: 201, handler: () => ({ id: 1 }) })] });
    expect((await app.fetch(req("/items", { method: "POST" }))).status).toBe(201);
  });

  test("ctx.set controls status and headers", async () => {
    const app = miu({
      routes: [
        route.get("/s", {
          handler: (ctx) => {
            ctx.set.status = 202;
            ctx.set.headers.set("x-custom", "yes");
            return { ok: true };
          },
        }),
      ],
    });
    const res = await app.fetch(req("/s"));
    expect(res.status).toBe(202);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("HEAD falls back to the GET route with an empty body", async () => {
    const app = miu({ routes: [route.get("/h", { handler: () => ({ a: 1 }) })] });
    const res = await app.fetch(req("/h", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("unknown path is 404 with a did-you-mean fix", async () => {
    const app = miu({ routes: [route.get("/users/:id", { handler: () => ({}) })] });
    const res = await app.fetch(req("/user/1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_ROUTE_NOT_FOUND");
    expect(body.error.fix).toContain("/users/:id");
  });

  test("wrong method is 405 with Allow header", async () => {
    const app = miu({ routes: [route.get("/a", { handler: () => "a" }), route.post("/a", { handler: () => "b" })] });
    const res = await app.fetch(req("/a", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    expect((await res.json()).error.code).toBe("MIU_E_METHOD_NOT_ALLOWED");
  });
});

describe("validation", () => {
  test("params are coerced from strings", async () => {
    const app = miu({
      routes: [route.get("/n/:id", { params: t.object({ id: t.integer() }), handler: ({ params }) => ({ id: params.id, type: typeof params.id }) })],
    });
    expect(await (await app.fetch(req("/n/42"))).json()).toEqual({ id: 42, type: "number" });
  });

  test("invalid params give 400 with issue paths", async () => {
    const app = miu({ routes: [route.get("/n/:id", { params: t.object({ id: t.integer() }), handler: () => ({}) })] });
    const res = await app.fetch(req("/n/abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_VALIDATION");
    expect(body.error.details.issues[0].path).toBe("params.id");
  });

  test("query schema applies defaults and coercion", async () => {
    const app = miu({
      routes: [
        route.get("/list", {
          query: t.object({ page: t.default(t.integer({ min: 1 }), 1), tags: t.optional(t.array(t.string())) }),
          handler: ({ query }) => query,
        }),
      ],
    });
    expect(await (await app.fetch(req("/list?tags=a"))).json()).toEqual({ page: 1, tags: ["a"] });
    expect(await (await app.fetch(req("/list?page=3&tags=a&tags=b"))).json()).toEqual({ page: 3, tags: ["a", "b"] });
  });

  test("JSON body is validated and unknown keys dropped", async () => {
    const app = miu({
      routes: [route.post("/u", { body: t.object({ name: t.string({ minLength: 1 }) }), handler: ({ body }) => body })],
    });
    expect(await (await app.fetch(req("/u", json({ name: "Mia", admin: true })))).json()).toEqual({ name: "Mia" });
    const bad = await app.fetch(req("/u", json({ name: "" })));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.details.issues[0].path).toBe("body.name");
  });

  test("malformed JSON body is 400 MIU_E_BAD_JSON", async () => {
    const app = miu({ routes: [route.post("/u", { body: t.object({}), handler: () => ({}) })] });
    const res = await app.fetch(req("/u", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("MIU_E_BAD_JSON");
  });

  test("form bodies are parsed and coerced", async () => {
    const app = miu({
      routes: [route.post("/f", { body: t.object({ qty: t.integer() }), handler: ({ body }) => body })],
    });
    const res = await app.fetch(req("/f", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "qty=5" }));
    expect(await res.json()).toEqual({ qty: 5 });
  });

  test("response schema mismatch is 500 in dev", async () => {
    const app = miu({ dev: true, routes: [route.get("/bad", { response: t.object({ id: t.string() }), handler: () => ({ id: 1 }) as any })] });
    const res = await app.fetch(req("/bad"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_RESPONSE_INVALID");
  });

  test("response schema is not checked in production", async () => {
    const app = miu({ dev: false, routes: [route.get("/bad", { response: t.object({ id: t.string() }), handler: () => ({ id: 1 }) as any })] });
    expect((await app.fetch(req("/bad"))).status).toBe(200);
  });
});

describe("errors", () => {
  test("thrown MiuError becomes its JSON response", async () => {
    const app = miu({ routes: [route.get("/e", { handler: () => { throw errors.notFound("user", "7"); } })] });
    const res = await app.fetch(req("/e"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "MIU_E_NOT_FOUND", message: 'user "7" not found' });
    expect(body.error.docs).toContain("MIU_E_NOT_FOUND");
  });

  test("unexpected errors are 500 and hide the message in production", async () => {
    const app = miu({ dev: false, logLevel: "silent", routes: [route.get("/boom", { handler: () => { throw new Error("db password is hunter2"); } })] });
    const res = await app.fetch(req("/boom"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("MIU_E_INTERNAL");
    expect(text).not.toContain("hunter2");
  });

  test("unexpected errors include the message in dev", async () => {
    const app = miu({ dev: true, logLevel: "silent", routes: [route.get("/boom", { handler: () => { throw new Error("kaboom"); } })] });
    expect(await (await app.fetch(req("/boom"))).text()).toContain("kaboom");
  });

  test("params schema with a key missing from the path fails at startup", async () => {
    const app = miu({ routes: [route.get("/users", { params: t.object({ id: t.string() }), handler: () => ({}) })] });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_PARAM_UNKNOWN" });
  });

  test("path param missing from params schema fails at startup", async () => {
    const app = miu({ routes: [route.get("/users/:id/:slug", { params: t.object({ id: t.string() }), handler: () => ({}) })] });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_PARAM_MISSING" });
  });

  test("two routes with the same name fail at startup", async () => {
    const app = miu({
      routes: [route.get("/a", { name: "dup", handler: () => "" }), route.get("/b", { name: "dup", handler: () => "" })],
    });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_ROUTE_NAME_DUPLICATE" });
  });
});

describe("auth requirements", () => {
  const userPlugin = definePlugin({
    name: "test-user",
    onRequest(ctx) {
      const h = ctx.req.headers.get("x-user");
      if (h) ctx.user = { id: h, roles: h === "boss" ? ["admin"] : [] } satisfies AuthUser;
    },
  });
  const app = miu({
    plugins: [userPlugin],
    routes: [
      route.get("/me", { auth: "required", handler: ({ user }) => ({ id: user.id }) }),
      route.get("/admin", { auth: { role: "admin" }, handler: () => "secret" }),
    ],
  });

  test("required auth without a user is 401", async () => {
    expect((await app.fetch(req("/me"))).status).toBe(401);
  });

  test("required auth with a user runs the handler", async () => {
    expect(await (await app.fetch(req("/me", { headers: { "x-user": "u1" } }))).json()).toEqual({ id: "u1" });
  });

  test("missing role is 403", async () => {
    expect((await app.fetch(req("/admin", { headers: { "x-user": "u1" } }))).status).toBe(403);
    expect((await app.fetch(req("/admin", { headers: { "x-user": "boss" } }))).status).toBe(200);
  });
});

describe("plugins and cookies", () => {
  test("plugin routes are served and onResponse can replace the response", async () => {
    const plugin = definePlugin({
      name: "p",
      routes: [route.get("/from-plugin", { handler: () => "hi" })],
      onResponse(_ctx, res) {
        const out = new Response(res.body, res);
        out.headers.set("x-plugin", "1");
        return out;
      },
    });
    const app = miu({ plugins: [plugin] });
    const res = await app.fetch(req("/from-plugin"));
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("x-plugin")).toBe("1");
  });

  test("onRequest can short-circuit with a Response", async () => {
    const app = miu({
      plugins: [definePlugin({ name: "block", onRequest: () => new Response("blocked", { status: 451 }) })],
      routes: [route.get("/x", { handler: () => "never" })],
    });
    expect((await app.fetch(req("/x"))).status).toBe(451);
  });

  test("setup runs once before the first request", async () => {
    let calls = 0;
    const app = miu({ plugins: [definePlugin({ name: "s", setup: () => void calls++ })], routes: [route.get("/", { handler: () => "" })] });
    await app.fetch(req("/"));
    await app.fetch(req("/"));
    expect(calls).toBe(1);
  });

  test("cookies set in the handler become Set-Cookie headers", async () => {
    const app = miu({
      routes: [
        route.get("/c", {
          handler: (ctx) => {
            ctx.cookies.set("theme", "dark");
            return { seen: ctx.cookies.get("lang") ?? null };
          },
        }),
      ],
    });
    const res = await app.fetch(req("/c", { headers: { cookie: "lang=vi" } }));
    expect(await res.json()).toEqual({ seen: "vi" });
    expect(res.headers.get("set-cookie")).toContain("theme=dark");
  });
});

describe("modules, testing helpers and introspection", () => {
  const usersModule = {
    getUser: route.get("/users/:id", {
      summary: "Get a user",
      params: t.object({ id: t.string() }),
      handler: ({ params }) => (params.id === "1" ? { id: "1", name: "Mia" } : (() => { throw errors.notFound("user", params.id); })()),
    }),
    tests: {
      "returns 404 for unknown id": async (call: any) => {
        const res = await call(usersModule.getUser, { params: { id: "nope" } });
        res.expectStatus(404);
      },
    },
  };

  test("routes passed as a module take their export names", async () => {
    const app = miu({ routes: [usersModule] });
    await app.ready();
    expect(app.inspect().routes.map((r: any) => r.name)).toEqual(["getUser"]);
  });

  test("route-file tests are collected and runnable", async () => {
    const app = miu({ routes: [usersModule] });
    await app.ready();
    expect(app.tests.map((x) => x.name)).toEqual(["returns 404 for unknown id"]);
    await app.tests[0].fn(app.call);
  });

  test("call() fills params, query and body and parses JSON", async () => {
    const app = miu({ routes: [usersModule] });
    const res = await app.call(usersModule.getUser, { params: { id: "1" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "1", name: "Mia" });
    expect(() => res.expectStatus(201)).toThrow(/expected status 201, got 200/);
  });

  test("unnamed routes get a name from method and path", async () => {
    const app = miu({ routes: [route.get("/users/:id/posts", { handler: () => [] })] });
    await app.ready();
    expect(app.inspect().routes[0].name).toBe("get_users_by_id_posts");
  });

  test("inspect() describes routes, schemas and plugins", async () => {
    const app = miu({ name: "demo", plugins: [definePlugin({ name: "extra", inspect: () => ({ ok: 1 }) })], routes: [usersModule] });
    await app.ready();
    const info = app.inspect();
    expect(info.name).toBe("demo");
    expect(info.routes[0]).toMatchObject({ method: "GET", path: "/users/:id", summary: "Get a user" });
    expect(info.routes[0].params).toEqual(t.object({ id: t.string() }).json);
    expect(info.plugins).toEqual([{ name: "extra", info: { ok: 1 } }]);
  });

  test("dev mode serves /_miu/app.json", async () => {
    const app = miu({ dev: true, routes: [usersModule] });
    const res = await app.fetch(req("/_miu/app.json"));
    expect(res.status).toBe(200);
    expect((await res.json()).routes.length).toBe(1);
  });

  test("production does not serve /_miu/app.json", async () => {
    const app = miu({ dev: false, routes: [usersModule] });
    expect((await app.fetch(req("/_miu/app.json"))).status).toBe(404);
  });
});
