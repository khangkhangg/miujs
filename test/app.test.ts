import { describe, expect, test } from "bun:test";
import { Miu, t, HttpError } from "../src/index.ts";

describe("Miu app", () => {
  test("returns objects as JSON", async () => {
    const app = new Miu().get("/hello", () => ({ msg: "hi" }));
    const res = await app.request("/hello");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ msg: "hi" });
  });

  test("returns strings as text and passes Response through", async () => {
    const app = new Miu()
      .get("/text", () => "plain")
      .get("/raw", () => new Response("raw", { status: 201 }));
    const text = await app.request("/text");
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe("plain");
    const raw = await app.request("/raw");
    expect(raw.status).toBe(201);
  });

  test("undefined return is 204 No Content", async () => {
    const app = new Miu().delete("/x", () => undefined);
    expect((await app.request("/x", { method: "DELETE" })).status).toBe(204);
  });

  test("unknown route returns problem+json 404", async () => {
    const res = await new Miu().request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 404, title: "Not Found" });
  });

  test("wrong method returns 405 with Allow header", async () => {
    const app = new Miu().get("/x", () => "ok");
    const res = await app.request("/x", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test("HEAD is served by GET handlers with an empty body", async () => {
    const app = new Miu().get("/x", () => "hello");
    const res = await app.request("/x", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("validates and coerces params and query", async () => {
    const app = new Miu().get(
      "/users/:id",
      { params: t.object({ id: t.integer() }), query: t.object({ full: t.default(t.boolean(), false) }) },
      (c) => ({ id: c.params.id, full: c.query.full, idType: typeof c.params.id }),
    );
    expect(await (await app.request("/users/7?full=true")).json()).toEqual({ id: 7, full: true, idType: "number" });
    const bad = await app.request("/users/abc");
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { issues: { path: unknown[] }[] };
    expect(body.issues[0]!.path).toEqual(["params", "id"]);
  });

  test("validates JSON body", async () => {
    const app = new Miu().post(
      "/users",
      { body: t.object({ name: t.string({ min: 1 }), email: t.string({ format: "email" }) }) },
      (c) => {
        c.status(201);
        return { created: c.body.name };
      },
    );
    const ok = await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ann", email: "ann@x.io" }),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ created: "Ann" });

    const bad = await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", email: "x" }),
    });
    expect(bad.status).toBe(422);
  });

  test("accepts form-encoded bodies (PHP-style forms)", async () => {
    const app = new Miu().post("/login", { body: t.object({ user: t.string(), remember: t.boolean() }) }, (c) => c.body);
    const res = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "user=ann&remember=1",
    });
    expect(await res.json()).toEqual({ user: "ann", remember: true });
  });

  test("accepts multipart bodies with repeated keys", async () => {
    const app = new Miu().post("/up", { body: t.object({ tags: t.array(t.string()), n: t.integer() }) }, (c) => c.body);
    const fd = new FormData();
    fd.append("tags", "a");
    fd.append("tags", "b");
    fd.append("n", "2");
    expect(await (await app.request("/up", { method: "POST", body: fd })).json()).toEqual({ tags: ["a", "b"], n: 2 });
  });

  test("unsupported content-type is a 415", async () => {
    const app = new Miu().post("/x", { body: t.object({ a: t.string() }) }, (c) => c.body);
    const res = await app.request("/x", { method: "POST", headers: { "content-type": "text/csv" }, body: "a,b" });
    expect(res.status).toBe(415);
  });

  test("malformed JSON is a 400", async () => {
    const app = new Miu().post("/x", { body: t.object({ a: t.string() }) }, (c) => c.body);
    const res = await app.request("/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });

  test("HttpError becomes problem+json with its status and code", async () => {
    const app = new Miu().get("/x", () => {
      throw new HttpError(403, "Nope", { code: "forbidden" });
    });
    const res = await app.request("/x");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 403, detail: "Nope", code: "forbidden" });
  });

  test("unexpected errors are 500 and do not leak the message", async () => {
    const app = new Miu({ logger: false }).get("/x", () => {
      throw new Error("db password is hunter2");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });

  test("errors become responses inside the chain so outer middleware still sees them", async () => {
    const app = new Miu({ logger: false })
      .use(async (c, next) => {
        await next();
        c.res.headers.set("access-control-allow-origin", "*");
      })
      .get("/x", () => {
        throw new HttpError(409, "Conflict here");
      })
      .get("/boom", () => {
        throw new Error("boom");
      });
    const res = await app.request("/x");
    expect(res.status).toBe(409);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const boom = await app.request("/boom");
    expect(boom.status).toBe(500);
    expect(boom.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("custom onError handler", async () => {
    const app = new Miu()
      .get("/x", () => {
        throw new Error("boom");
      })
      .onError((err, c) => c.json({ caught: (err as Error).message }, 418));
    const res = await app.request("/x");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ caught: "boom" });
  });

  test("middleware runs in onion order and can set vars", async () => {
    const order: string[] = [];
    const app = new Miu()
      .use(async (c, next) => {
        order.push("a-in");
        c.set("user", "ann");
        await next();
        order.push("a-out");
      })
      .use(async (_c, next) => {
        order.push("b-in");
        await next();
        order.push("b-out");
      })
      .get("/x", (c) => {
        order.push("handler");
        return { user: c.get("user") };
      });
    expect(await (await app.request("/x")).json()).toEqual({ user: "ann" });
    expect(order).toEqual(["a-in", "b-in", "handler", "b-out", "a-out"]);
  });

  test("middleware can short-circuit by returning a Response", async () => {
    const app = new Miu()
      .use("/admin/*", (c) => c.json({ error: "unauthorized" }, 401))
      .get("/admin/panel", () => "secret")
      .get("/public", () => "hi");
    expect((await app.request("/admin/panel")).status).toBe(401);
    expect((await app.request("/public")).status).toBe(200);
  });

  test("middleware can modify the response after next()", async () => {
    const app = new Miu()
      .use(async (c, next) => {
        await next();
        c.res.headers.set("x-powered-by", "miu");
      })
      .get("/x", () => "ok");
    expect((await app.request("/x")).headers.get("x-powered-by")).toBe("miu");
  });

  test("route-level middleware", async () => {
    const app = new Miu().get(
      "/x",
      { use: [(c) => c.text("blocked", 403)] },
      () => "never",
    );
    expect((await app.request("/x")).status).toBe(403);
  });

  test("context helpers: headers, cookies, redirect, html", async () => {
    const app = new Miu()
      .get("/c", (c) => {
        c.header("x-a", "1");
        c.setCookie("sid", "abc", { httpOnly: true, path: "/" });
        return { got: c.cookie("theme") ?? null, ua: c.req.headers.get("user-agent") };
      })
      .get("/r", (c) => c.redirect("/c"))
      .get("/h", (c) => c.html("<b>hi</b>"));
    const res = await app.request("/c", { headers: { cookie: "theme=dark; x=1", "user-agent": "t" } });
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.get("set-cookie")).toBe("sid=abc; Path=/; HttpOnly");
    expect(await res.json()).toEqual({ got: "dark", ua: "t" });
    const r = await app.request("/r");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/c");
    expect((await app.request("/h")).headers.get("content-type")).toContain("text/html");
  });

  test("mounts sub-apps under a prefix", async () => {
    const users = new Miu().get("/", () => ["ann"]).get("/:id", (c) => ({ id: c.params.id }));
    const app = new Miu().route("/api/users", users);
    expect(await (await app.request("/api/users")).json()).toEqual(["ann"]);
    expect(await (await app.request("/api/users/3")).json()).toEqual({ id: "3" });
  });

  test("passes env and execution context (Cloudflare Workers signature)", async () => {
    const app = new Miu<{ Bindings: { SECRET: string } }>().get("/env", (c) => ({ s: c.env.SECRET }));
    const res = await app.fetch(new Request("http://x/env"), { SECRET: "s3" }, { waitUntil() {}, passThroughOnException() {} });
    expect(await res.json()).toEqual({ s: "s3" });
  });

  test("exposes route metadata", () => {
    const app = new Miu().get("/a", { summary: "A" }, () => 1).post("/b", () => 2);
    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /a", "POST /b"]);
    expect(app.routes[0]!.meta.summary).toBe("A");
  });
});

describe("type inference", () => {
  test("handler input types come from schemas", () => {
    new Miu().post(
      "/u/:id",
      { params: t.object({ id: t.integer() }), body: t.object({ name: t.string(), nick: t.optional(t.string()) }) },
      (c) => {
        const id: number = c.params.id;
        const name: string = c.body.name;
        const nick: string | undefined = c.body.nick;
        // @ts-expect-error id is a number, not a string
        const wrong: string = c.params.id;
        return { id, name, nick, wrong };
      },
    );
  });
});
