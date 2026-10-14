import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { mcp } from "../../src/ai/mcp.ts";
import { devErrors, getTiming, inspector, timing } from "../../src/devtools/index.ts";

const TOKEN = "a".repeat(40);
const PROD = { NODE_ENV: "production" };
const AUTH = { authorization: `Bearer ${TOKEN}` };

function make(opts: Parameters<typeof inspector>[0] = {}) {
  const logs: string[] = [];
  const app = new Miu({ logger: false });
  app.use(inspector({ token: TOKEN, log: (s) => logs.push(s), ...opts }));
  app.use(timing());
  app.use(mcp());
  app.onError(devErrors({ log: () => {} }));
  app.get("/users/:id", (c) => {
    getTiming(c).add("db", 3, "load user");
    c.header("set-cookie", "sid=sekret-session");
    return { id: c.params.id };
  });
  app.get("/hello", { tool: { name: "say_hello" } }, () => ({ hi: true }));
  app.get("/r/:n", (c) => c.params.n);
  app.post("/echo", async (c) => ({ got: await c.req.text() }));
  app.get("/fail", () => {
    throw new Error("kaboom");
  });
  return { app, logs };
}

const api = async (app: Miu<any>, path = "/__miu/api/requests") => {
  const res = await app.request(path, { headers: AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
};

describe("inspector() security", () => {
  test("is not served in production (falls through to 404), even with the token", async () => {
    const { app } = make();
    const res = await app.request("/__miu", { headers: AUTH }, PROD);
    expect(res.status).toBe(404);
    const apiRes = await app.request("/__miu/api/requests", { headers: AUTH }, { MIU_ENV: "production" });
    expect(apiRes.status).toBe(404);
  });

  test("enabled: true does not override production; force: true does", async () => {
    expect((await make({ enabled: true }).app.request("/__miu", { headers: AUTH }, PROD)).status).toBe(404);
    expect((await make({ enabled: true, force: true }).app.request("/__miu", { headers: AUTH }, PROD)).status).toBe(200);
  });

  test("requires the token; ?token= sets an HttpOnly SameSite=Strict cookie and strips it from the URL", async () => {
    const { app, logs } = make();
    const anon = await app.request("/__miu");
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain(TOKEN);
    expect(logs.join("\n")).toContain(`/__miu?token=${TOKEN}`);

    expect((await app.request("/__miu?token=wrong")).status).toBe(401);

    const login = await app.request(`/__miu?token=${TOKEN}`);
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/__miu");
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/__miu");

    const ui = await app.request("/__miu", { headers: { cookie: cookie.split(";")[0]! } });
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
    expect(ui.headers.get("cache-control")).toBe("no-store");
    expect(ui.headers.get("x-robots-tag")).toContain("noindex");
    const csp = ui.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[\w+/=-]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await ui.text();
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain(TOKEN);
  });

  test("generates a random token and prints it once when none is configured", async () => {
    const logs: string[] = [];
    const app = new Miu({ logger: false });
    app.use(inspector({ log: (s) => logs.push(s) }));
    await app.request("/__miu");
    await app.request("/__miu");
    expect(logs.length).toBe(1);
    const m = logs[0]!.match(/token=([0-9a-f]{32,})/);
    expect(m).not.toBeNull();
    expect((await app.request(`/__miu/api/requests`, { headers: { authorization: `Bearer ${m![1]}` } })).status).toBe(200);
  });

  test("refuses non-loopback hosts and forwarded clients (404), unless allow() says otherwise", async () => {
    const { app } = make();
    expect((await app.request("http://example.com/__miu", { headers: AUTH })).status).toBe(404);
    expect((await app.request("/__miu", { headers: { ...AUTH, "x-forwarded-for": "203.0.113.9" } })).status).toBe(404);
    expect((await app.request("/__miu", { headers: { ...AUTH, origin: "https://evil.example" } })).status).toBe(404);
    expect((await app.request("http://127.0.0.1:3000/__miu", { headers: AUTH })).status).toBe(200);
    expect((await app.request("http://[::1]:3000/__miu", { headers: AUTH })).status).toBe(200);

    const open = make({ allow: () => true }).app;
    expect((await open.request("http://example.com/__miu", { headers: AUTH })).status).toBe(200);
    expect((await open.request("http://example.com/__miu")).status).toBe(401); // token still required
    const closed = make({ allow: () => false }).app;
    expect((await closed.request("/__miu", { headers: AUTH })).status).toBe(404);
  });

  test("never records its own traffic", async () => {
    const { app } = make();
    await app.request("/__miu", { headers: AUTH });
    await app.request("/hello");
    const data = await api(app);
    expect(data.requests.map((r: any) => r.path)).toEqual(["/hello"]);
  });
});

describe("inspector() recording", () => {
  test("ring buffer keeps only the newest `limit` requests, newest first", async () => {
    const { app } = make({ limit: 3 });
    for (let i = 1; i <= 5; i++) await app.request(`/r/${i}`);
    const data = await api(app);
    expect(data.limit).toBe(3);
    expect(data.requests.map((r: any) => r.path)).toEqual(["/r/5", "/r/4", "/r/3"]);
    const one = await api(app, `/__miu/api/requests/${data.requests[0].id}`);
    expect(one.path).toBe("/r/5");
    expect((await app.request("/__miu/api/requests/999999", { headers: AUTH })).status).toBe(404);
  });

  test("records status, route, timings and redacted headers", async () => {
    const { app } = make();
    await app.request("/users/42?x=1&token=sekret-q", { headers: { authorization: "Bearer sekret", "user-agent": "ua-test" } });
    const [r] = (await api(app)).requests;
    expect(r.method).toBe("GET");
    expect(r.path).toBe("/users/42");
    expect(r.query).not.toContain("sekret");
    expect(r.status).toBe(200);
    expect(r.route).toBe("/users/:id");
    expect(typeof r.duration).toBe("number");
    expect(r.requestHeaders["user-agent"]).toBe("ua-test");
    expect(r.requestHeaders.authorization).toBe("[redacted]");
    expect(r.responseHeaders["set-cookie"]).toBe("[redacted]");
    expect(r.timing.find((m: any) => m.name === "db")).toEqual({ name: "db", dur: 3, desc: "load user" });
    expect(JSON.stringify(r)).not.toContain("sekret");
  });

  test("records errors with their stack", async () => {
    const { app } = make();
    await app.request("/fail");
    const [r] = (await api(app)).requests;
    expect(r.status).toBe(500);
    expect(r.error.message).toBe("kaboom");
    expect(r.error.stack.join("\n")).toContain("inspector.test.ts");
    expect(r.error.location).toMatch(/inspector\.test\.ts:\d+:\d+$/);
  });

  test("does not consume request bodies by default", async () => {
    const { app } = make();
    let bodyUsedBeforeHandler: boolean | undefined;
    app.use("/echo", async (c, next) => {
      bodyUsedBeforeHandler = c.req.bodyUsed;
      await next();
    });
    const res = await app.request("/echo", { method: "POST", headers: { "content-length": "11" }, body: "payload-123" });
    expect(await res.json()).toEqual({ got: "payload-123" });
    expect(bodyUsedBeforeHandler).toBe(false);
    const [r] = (await api(app)).requests;
    expect(r.requestBody).toBeUndefined();
    expect(r.requestSize).toBe(11);
  });

  test("captureBodies: true records request and response bodies without breaking the handler", async () => {
    const { app } = make({ captureBodies: true });
    const res = await app.request("/echo", { method: "POST", headers: { "content-type": "text/plain" }, body: "payload-123" });
    expect(await res.json()).toEqual({ got: "payload-123" });
    await new Promise((r) => setTimeout(r, 10));
    const [r] = (await api(app)).requests;
    expect(r.requestBody).toBe("payload-123");
    expect(r.responseBody).toEqual({ got: "payload-123" }); // JSON is parsed so fields can be redacted
  });

  test("names the MCP tool called through the MCP endpoint", async () => {
    const { app } = make();
    await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "say_hello", arguments: {} } }),
    });
    const reqs = (await api(app)).requests;
    const outer = reqs.find((r: any) => r.path === "/mcp");
    expect(outer.mcp).toEqual({ method: "tools/call", tool: "say_hello" });
    expect(reqs.some((r: any) => r.path === "/hello")).toBe(true); // the in-process tool call
  });

  test("lists routes with their MCP tool names", async () => {
    const { app } = make();
    const data = await api(app, "/__miu/api/routes");
    expect(data.routes).toContainEqual({ method: "GET", path: "/hello", tool: "say_hello" });
    expect(data.routes).toContainEqual({ method: "GET", path: "/users/:id", tool: "get_users_by_id" });
    expect(data.links).toEqual(expect.objectContaining({ mcp: "/mcp" }));
  });

  test("DELETE clears the buffer", async () => {
    const { app } = make();
    await app.request("/hello");
    const del = await app.request("/__miu/api/requests", { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(204);
    expect((await api(app)).requests).toEqual([]);
  });

  test("streams new requests over SSE", async () => {
    const { app } = make();
    const res = await app.request("/__miu/events", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await app.request("/r/sse-check");
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes("/r/sse-check") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain("event: request");
    const data = text.split("\n").find((l) => l.startsWith("data: ") && l.includes("/r/sse-check"))!;
    expect(JSON.parse(data.slice(6)).path).toBe("/r/sse-check");
  });
});
