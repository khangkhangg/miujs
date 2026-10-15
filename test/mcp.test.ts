import { describe, expect, test } from "bun:test";
import { Miu, t, HttpError, requestId } from "../src/index.ts";
import { mcp, listTools } from "../src/ai/mcp.ts";

const makeApp = () =>
  new Miu({ name: "Todo", version: "0.1.0", logger: false })
    .get(
      "/todos/:id",
      { description: "Fetch one todo", params: t.object({ id: t.integer() }), query: t.object({ verbose: t.optional(t.boolean()) }) },
      (c) => {
        if (c.params.id === 404) throw new HttpError(404, "Todo not found");
        return { id: c.params.id, title: "Buy milk", verbose: c.query.verbose ?? false };
      },
    )
    .post(
      "/todos",
      { summary: "Create a todo", body: t.object({ title: t.string() }), tool: { name: "create_todo" } },
      (c) => {
        c.status(201);
        return { id: 1, title: c.body.title, user: c.get("user") ?? null };
      },
    )
    .get("/secret", { tool: false }, () => "no");

async function rpc(app: Miu<any>, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("MCP", () => {
  test("every route becomes a tool unless opted out", () => {
    const tools = listTools(makeApp());
    expect(tools.map((x) => x.name)).toEqual(["get_todos_by_id", "create_todo"]);
  });

  test("tool input schema merges params, query and body", () => {
    const [get, create] = listTools(makeApp());
    expect(get!.description).toBe("Fetch one todo");
    expect(get!.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "integer" }, verbose: { type: "boolean" } },
      required: ["id"],
    });
    expect(create!.description).toBe("Create a todo");
    expect(create!.inputSchema.required).toEqual(["title"]);
  });

  test("initialize handshake", async () => {
    const app = makeApp().use(mcp());
    const { body } = await rpc(app, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(body.result.serverInfo).toEqual({ name: "Todo", version: "0.1.0" });
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/list over JSON-RPC", async () => {
    const { body } = await rpc(makeApp().use(mcp()), "tools/list");
    expect(body.result.tools).toHaveLength(2);
  });

  test("tools/call routes through the real HTTP pipeline", async () => {
    const { body } = await rpc(makeApp().use(mcp()), "tools/call", { name: "get_todos_by_id", arguments: { id: 5, verbose: true } });
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({ id: 5, title: "Buy milk", verbose: true });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: 5, title: "Buy milk", verbose: true });
  });

  test("tools/call sends body args as JSON and keeps middleware (auth) in the loop", async () => {
    const app = makeApp()
      .use(async (c, next) => {
        if (c.req.headers.get("authorization") === "Bearer ok") c.set("user", "ann");
        await next();
      })
      .use(mcp());
    const { body } = await rpc(app, "tools/call", { name: "create_todo", arguments: { title: "Walk" } }, { authorization: "Bearer ok" });
    expect(body.result.structuredContent).toEqual({ id: 1, title: "Walk", user: "ann" });
  });

  test("HTTP errors become tool errors, not protocol errors", async () => {
    const { body } = await rpc(makeApp().use(mcp()), "tools/call", { name: "get_todos_by_id", arguments: { id: 404 } });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Todo not found");
  });

  test("unknown tool and unknown method are JSON-RPC errors", async () => {
    const app = makeApp().use(mcp());
    expect((await rpc(app, "tools/call", { name: "nope", arguments: {} })).body.error.code).toBe(-32602);
    expect((await rpc(app, "bogus/method")).body.error.code).toBe(-32601);
  });

  test("notifications get 202 with no body", async () => {
    const res = await makeApp()
      .use(mcp())
      .request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    expect(res.status).toBe(202);
  });

  test("ping", async () => {
    expect((await rpc(makeApp().use(mcp()), "ping")).body.result).toEqual({});
  });
});

describe("MCP CSRF protection", () => {
  const victimApp = () =>
    new Miu({ logger: false })
      .use(async (c, next) => {
        if (c.cookie("sid") === "victim") c.set("user", "victim");
        await next();
      })
      .post("/transfer", (c) => ({ by: c.get("user") ?? null }))
      .use(mcp());
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post_transfer", arguments: {} } });

  test("a cross-site text/plain form post cannot run tools (415)", async () => {
    const res = await victimApp().request("/mcp", {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: "sid=victim", "sec-fetch-site": "cross-site" },
      body: call,
    });
    expect(res.status).toBe(415);
  });

  test("a cross-site browser request riding on cookies is refused even with a JSON type (403)", async () => {
    const res = await victimApp().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "sid=victim", "sec-fetch-site": "cross-site" },
      body: call,
    });
    expect(res.status).toBe(403);
  });

  test("bearer-authenticated and same-origin clients still work", async () => {
    const bearer = await victimApp().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t", "sec-fetch-site": "cross-site" },
      body: call,
    });
    expect(bearer.status).toBe(200);
    const same = await victimApp().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", cookie: "sid=victim", "sec-fetch-site": "same-origin" },
      body: call,
    });
    expect(((await same.json()) as any).result.structuredContent).toEqual({ by: "victim" });
  });
});

describe("MCP tool calls keep the caller's identity for tracing and limits", () => {
  test("inner tool requests carry the outer request id and the agent's IP", async () => {
    const seen: { id?: string; ip?: string }[] = [];
    const app = new Miu({ logger: false })
      .use(requestId())
      .post("/thing", (c) => {
        seen.push({ id: c.get("requestId") as string, ip: c.ip });
        return { ok: true };
      })
      .use(mcp());
    const server = Bun.serve(app.serveOptions({ port: 0, hostname: "127.0.0.1" }));
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "outer-123", authorization: "Bearer t" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post_thing", arguments: {} } }),
      });
      expect(((await res.json()) as any).result.isError).toBe(false);
      expect(seen).toEqual([{ id: "outer-123", ip: "127.0.0.1" }]);
    } finally {
      server.stop(true);
    }
  });
});
