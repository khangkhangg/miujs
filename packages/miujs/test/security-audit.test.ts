// Adversarial checks for the core request pipeline (2026-10-16 audit). Each test pins one
// finding: the exploit is replayed and must now be refused.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { definePlugin, miu, route, t, type MiuOptions } from "../src/index.ts";
import { pathOf } from "../src/context.ts";
import { parseCookies } from "../src/cookies.ts";
import { serveNode } from "../src/node.ts";

const quiet = (o: MiuOptions) => miu({ logLevel: "silent", dev: false, ...o });

describe("prototype keys in query, form and cookies stay plain data", () => {
  const app = quiet({
    routes: [
      route.get("/raw", { handler: (c) => ({ proto: Object.getPrototypeOf(c.query) === Object.prototype, own: Object.getOwnPropertyNames(c.query), ctor: c.query.constructor }) }),
      route.post("/form", { body: t.record(t.any()), handler: (c) => ({ keys: Object.keys(c.body), ctor: (c.body as any).constructor }) }),
      route.post("/proto", { body: t.object({ name: t.optional(t.string()) }), handler: (c) => ({ body: c.body }) }),
    ],
  });

  test("?__proto__=a&__proto__=b does not replace ctx.query's prototype", async () => {
    const body = await (await app.request("/raw?__proto__=a&__proto__=b&constructor=c")).json();
    expect(body.proto).toBe(true);
    expect(body.own.sort()).toEqual(["__proto__", "constructor"]);
    expect(body.ctor).toBe("c");
  });

  test("a single ?constructor=x is a string, not [Object, x]", async () => {
    expect((await (await app.request("/raw?constructor=x")).json()).ctor).toBe("x");
  });

  test("form fields named __proto__ / constructor are own fields, not inherited", async () => {
    const fd = new FormData();
    fd.append("constructor", "x");
    fd.append("__proto__", new File(["a"], "admin"));
    const res = await app.request("/form", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ctor).toBe("x");
    expect(body.keys.sort()).toEqual(["__proto__", "constructor"]);
    const fd2 = new FormData();
    fd2.append("__proto__", new File(["a"], "admin"));
    expect(await (await app.request("/proto", { method: "POST", body: fd2 })).json()).toEqual({ body: {} });
  });

  test("cookies: inherited names are not cookies, and __proto__ is a plain cookie", () => {
    const c = parseCookies("__proto__=evil; constructor=c1; a=1");
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(c.constructor as unknown).toBe("c1");
    expect(c.__proto__ as unknown).toBe("evil");
    // Previously `name in out` made "constructor=c1" look like a duplicate and dropped it.
    expect(Object.keys(parseCookies("constructor=c1; toString=t"))).toEqual(["constructor", "toString"]);
  });

  test("ctx.cookies.get never returns inherited members", async () => {
    const a = quiet({ routes: [route.get("/c", { handler: (c) => ({ v: typeof c.cookies.get("toString"), w: typeof c.cookies.get("constructor") }) })] });
    expect(await (await a.request("/c", { headers: { cookie: "a=1" } })).json()).toEqual({ v: "undefined", w: "undefined" });
  });
});

describe("auth requirements fail closed", () => {
  for (const bad of [true, "Required", "yes", 1, { roles: ["admin"] }]) {
    test(`auth: ${JSON.stringify(bad)} is a startup error, not a public route`, async () => {
      const app = quiet({ routes: [route.get("/admin", { auth: bad as any, handler: () => "secret" })] });
      await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_AUTH_INVALID" });
    });
  }
  test("valid auth values still work", async () => {
    const app = quiet({
      routes: [
        route.get("/a", { auth: false, handler: () => "a" }),
        route.get("/b", { auth: "optional", handler: () => "b" }),
        route.get("/c", { auth: "required", handler: () => "c" }),
        route.get("/d", { auth: { role: ["x"] }, handler: () => "d" }),
      ],
    });
    expect((await app.request("/a")).status).toBe(200);
    expect((await app.request("/b")).status).toBe(200);
    expect((await app.request("/c")).status).toBe(401);
    expect((await app.request("/d")).status).toBe(401);
  });
});

describe("fast path never skips auth, permission or validation (every combination)", () => {
  // A plugin that signs in with `x-user` (roles from `x-roles`) and grants permissions listed in `x-perms`.
  const fakeAuth = (withHook: boolean) =>
    definePlugin({
      name: "fake-auth",
      ...(withHook
        ? {
            onRequest(ctx: any) {
              const id = ctx.headers.get("x-user");
              if (id) ctx.user = { id, roles: (ctx.headers.get("x-roles") ?? "").split(",").filter(Boolean) };
              ctx.authorize = (p: string) => {
                if (!(ctx.headers.get("x-perms") ?? "").split(",").includes(p)) throw Object.assign(new Error("no"), { status: 403 });
              };
            },
          }
        : {}),
    });

  const auths = [false, "optional", "required", { role: "admin" }] as const;
  const perms = [undefined, "x.read"] as const;
  const paramKinds = ["none", "plain", "constrained"] as const;
  const queries = [false, true];
  const bodies = [false, true];
  let n = 0;
  for (const withHook of [false, true])
    for (const auth of auths)
      for (const permission of perms)
        for (const pk of paramKinds)
          for (const q of queries)
            for (const b of bodies) {
              const id = n++;
              const name = `hook=${withHook} auth=${JSON.stringify(auth)} perm=${permission ?? "-"} params=${pk} query=${q} body=${b}`;
              test(name, async () => {
                const path = pk === "none" ? `/r${id}` : `/r${id}/:id`;
                const params = pk === "none" ? undefined : pk === "plain" ? t.object({ id: t.string() }) : t.object({ id: t.string({ pattern: /^\d+$/ }) });
                const def: any = { auth, handler: (c: any) => ({ ok: true, params: c.params, query: c.query, body: c.body }) };
                if (permission) def.permission = permission;
                if (params) def.params = params;
                if (q) def.query = t.object({ n: t.integer() });
                if (b) def.body = t.object({ s: t.string() });
                const r = b ? route.post(path, def) : route.get(path, def);
                const app = quiet({ routes: [r], plugins: [fakeAuth(withHook)] });
                const url = `http://localhost/r${id}${pk === "none" ? "" : "/12"}${q ? "?n=5" : ""}`;
                const send = (headers: Record<string, string>, urlOverride?: string, bodyOverride?: string) =>
                  app.fetch(new Request(urlOverride ?? url, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: b ? (bodyOverride ?? '{"s":"v"}') : undefined }));
                const good = { "x-user": "u1", "x-roles": "admin", "x-perms": "x.read" };
                const needsUser = auth === "required" || typeof auth === "object";
                // 1. Anonymous.
                const anon = await send({});
                if (needsUser) expect(anon.status).toBe(401);
                else if (permission && !withHook) expect(anon.status).toBe(500); // nobody provides ctx.authorize: never allow
                else if (permission) expect(anon.status).not.toBe(200);
                else expect(anon.status).toBe(200);
                if (!withHook) return; // without the plugin nobody can sign in
                // 2. Signed in without the role.
                if (typeof auth === "object") expect((await send({ ...good, "x-roles": "user" })).status).toBe(403);
                // 3. Signed in without the permission.
                if (permission) expect((await send({ ...good, "x-perms": "" })).status).not.toBe(200);
                // 4. Fully allowed.
                const ok = await send(good);
                expect(ok.status).toBe(200);
                // 5. Invalid inputs are rejected even for an allowed caller.
                if (pk === "constrained") expect((await send(good, url.replace("/12", "/abc"))).status).toBe(400);
                if (q) expect((await send(good, url.replace("n=5", "n=x"))).status).toBe(400);
                if (b) expect((await send(good, undefined, '{"s":1}'))).toHaveProperty("status", 400);
              });
            }
});

describe("MCP endpoint", () => {
  const mk = (o: MiuOptions = {}) =>
    quiet({
      mcp: true,
      routes: [
        route.get("/users/:id/profile", { name: "profile", params: t.object({ id: t.string() }), handler: (c) => ({ id: c.params.id }) }),
        route.get("/files/*path", { name: "file", handler: (c) => ({ path: c.params.path }) }),
        route.get("/profile", { name: "hidden", mcp: false, handler: () => ({ hidden: true }) }),
        route.get("/delete", { name: "hidden2", mcp: false, handler: () => ({ hidden: true }) }),
      ],
      plugins: [definePlugin({ name: "p", mcpTools: () => [{ name: "boom", inputSchema: { type: "object" }, call: () => { throw new Error("db password=hunter2 at 10.0.0.5"); } }] })],
      ...o,
    });
  const rpc = (app: ReturnType<typeof miu>, body: unknown, headers: Record<string, string> = {}, host = "localhost") =>
    app.fetch(new Request(`http://${host}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const call = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  test("DNS rebinding: an Origin equal to an attacker-controlled Host is refused", async () => {
    const app = mk();
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://evil.example:3000" }, "evil.example:3000")).status).toBe(403);
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://app.example" }, "app.example")).status).toBe(403);
  });

  test("same-origin browsers on loopback hosts and allow-listed origins still work", async () => {
    const app = mk({ mcp: { allowedOrigins: ["https://app.example"] } });
    for (const [origin, host] of [["http://localhost:3000", "localhost:3000"], ["http://127.0.0.1:8787", "127.0.0.1:8787"], ["http://[::1]:3000", "[::1]:3000"], ["http://game.localhost", "game.localhost"]]) {
      expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin }, host)).status).toBe(200);
    }
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://app.example" }, "app.example")).status).toBe(200);
  });

  for (const bad of ["..", ".", "%2e%2e", "%2E.", ".%2e"]) {
    test(`tool args cannot traverse to other routes (id=${JSON.stringify(bad)})`, async () => {
      const res = await (await rpc(mk(), call("profile", { id: bad }))).json();
      expect(JSON.stringify(res)).not.toContain("hidden");
      if (bad === ".." || bad === ".") {
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toContain("MIU_E_VALIDATION");
      }
    });
  }

  test("wildcard tool args cannot climb out of their prefix", async () => {
    const res = await (await rpc(mk(), call("file", { path: "a/../../delete" }))).json();
    expect(res.result.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain("hidden");
    const ok = await (await rpc(mk(), call("file", { path: "a/b.txt" }))).json();
    expect(ok.result.structuredContent ?? JSON.parse(ok.result.content[0].text)).toEqual({ path: "a/b.txt" });
  });

  test("app.tools() call refuses dot-segment args too", async () => {
    const app = mk();
    await app.ready();
    const tool = app.tools().find((x) => x.name === "profile")!;
    const out = await tool.call({ id: ".." });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
  });

  test("bodies over maxBodySize are refused (413) before parsing", async () => {
    const app = mk({ maxBodySize: 1024 });
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(4096) });
    expect((await rpc(app, big)).status).toBe(413);
    const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await app.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: chunked, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  test("plugin tool errors do not leak internals in production", async () => {
    const text = (await (await rpc(mk(), call("boom", {}))).json()).result.content[0].text;
    expect(text).not.toContain("hunter2");
    expect(text).toContain("MIU_E_INTERNAL");
    const dev = (await (await rpc(mk({ dev: true }), call("boom", {}))).json()).result.content[0].text;
    expect(dev).toContain("hunter2");
  });
});

describe("WebSocket upgrades (cross-site WebSocket hijacking)", () => {
  const server = { upgrade: () => true };
  const ws = (o: Record<string, unknown> = {}) => quiet({ routes: [route.get("/ws", { handler: (c) => c.upgrade(o) })] });
  const open = (app: ReturnType<typeof miu>, headers: Record<string, string>, host = "game.example") =>
    app.fetch(new Request(`http://${host}/ws`, { headers: { upgrade: "websocket", ...headers } }), server);

  test("a cross-origin handshake that carries cookies is refused", async () => {
    const res = await open(ws(), { origin: "https://evil.example", cookie: "sid=abc" });
    expect(res?.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_WS_ORIGIN");
  });
  test("same-origin with cookies, cross-origin without cookies, and listed origins are accepted", async () => {
    expect(await open(ws(), { origin: "http://game.example", cookie: "sid=abc" })).toBeUndefined();
    expect(await open(ws(), { origin: "https://cdn.example" })).toBeUndefined();
    expect(await open(ws(), {})).toBeUndefined();
    expect(await open(ws({ origins: ["https://play.example"] }), { origin: "https://play.example", cookie: "sid=abc" })).toBeUndefined();
    expect(await open(ws({ origins: "*" }), { origin: "https://any.example", cookie: "sid=abc" })).toBeUndefined();
  });
  test("an origin list does not match by prefix or suffix", async () => {
    for (const origin of ["https://play.example.evil.example", "https://evilplay.example", "null"]) {
      expect((await open(ws({ origins: ["https://play.example"] }), { origin, cookie: "sid=abc" }))?.status).toBe(403);
    }
  });
});

describe("Host header cannot change the routed path", () => {
  test("pathOf reads a relative URL (Bun gives one for an invalid Host)", () => {
    expect(pathOf("/public")).toBe("/public");
    expect(pathOf("/public?x=1")).toBe("/public");
    expect(pathOf("/")).toBe("/");
  });

  const app = quiet({ routes: [route.get("/public", { handler: () => "public" }), route.get("/admin", { handler: () => "ADMIN" })] });
  let server: Awaited<ReturnType<typeof serveNode>>;
  beforeAll(async () => {
    await app.ready();
    server = await serveNode(app, { port: 0, hostname: "127.0.0.1" });
  });
  afterAll(() => server.stop());
  const raw = (host: string) =>
    new Promise<string>((resolve) => {
      const c = connect(server.port, "127.0.0.1", () => c.write(`GET /public HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let d = "";
      c.on("data", (b) => (d += b));
      c.on("end", () => resolve(d.split("\r\n\r\n").slice(1).join("")));
    });

  for (const host of ["x/admin?", "x/admin#", "x@127.0.0.1/admin?", "x\\admin?"]) {
    test(`Node adapter: Host ${JSON.stringify(host)} still serves the request line's path`, async () => {
      const body = await raw(host);
      expect(body).not.toContain("ADMIN");
      expect(body).toContain("public");
    });
  }
});
