import { describe, expect, test } from "bun:test";
import { Miu, t, HttpError, mcp } from "../../src/index.ts";
import { ClientError, McpClientError, createClient, createMcpClient } from "../../src/client/index.ts";

const app = new Miu({ name: "client-test", version: "9.9.9", logger: false })
  .use(mcp())
  .get("/todos/:id", { params: t.object({ id: t.integer() }) }, (c) => {
    if (c.params.id === 404) throw new HttpError(404, "Todo not found", { code: "todo_missing" });
    return { id: c.params.id, title: "Buy milk" };
  })
  .get("/search", (c) => ({ query: c.query }))
  .post("/todos", { body: t.object({ title: t.string({ min: 1 }) }) }, (c) => {
    c.status(201);
    return { id: 1, title: c.body.title };
  })
  .get("/files/*", (c) => ({ path: c.params["*"] }))
  .get("/text", () => "plain hello")
  .delete("/todos/:id", () => undefined)
  .get("/whoami", (c) => ({ auth: c.req.headers.get("authorization"), extra: c.req.headers.get("x-extra") }));

const shim = (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init));

describe("createClient", () => {
  const client = createClient("http://api.test", { fetch: shim, headers: { authorization: "Bearer t0k" } });

  test("fills path params and parses JSON", async () => {
    expect(await client.request("GET", "/todos/:id", { params: { id: 7 } })).toEqual({ id: 7, title: "Buy milk" });
  });

  test("encodes query, repeating arrays and skipping undefined", async () => {
    const out = await client.request<{ query: unknown }>("GET", "/search", { query: { q: "a b&c", tag: ["x", "y"], none: undefined, n: 3 } });
    expect(out.query).toEqual({ q: "a b&c", tag: ["x", "y"], n: "3" });
  });

  test("sends JSON bodies", async () => {
    expect(await client.post("/todos", { body: { title: "Ship" } })).toEqual({ id: 1, title: "Ship" });
  });

  test("encodes params safely and supports wildcard", async () => {
    expect(await client.get("/files/*", { params: { path: "a b/c.txt" } })).toEqual({ path: "a b/c.txt" });
  });

  test("returns text for non-JSON and undefined for 204", async () => {
    expect(await client.get("/text")).toBe("plain hello");
    expect(await client.delete("/todos/:id", { params: { id: 1 } })).toBeUndefined();
  });

  test("merges default and per-request headers", async () => {
    expect(await client.get("/whoami", { headers: { "x-extra": "1" } })).toEqual({ auth: "Bearer t0k", extra: "1" });
  });

  test("headers may be a function (e.g. refreshed token)", async () => {
    let n = 0;
    const c2 = createClient("http://api.test/", { fetch: shim, headers: () => ({ authorization: `Bearer ${++n}` }) });
    expect(await c2.get<{ auth: string }>("/whoami")).toMatchObject({ auth: "Bearer 1" });
    expect(await c2.get<{ auth: string }>("/whoami")).toMatchObject({ auth: "Bearer 2" });
  });

  test("throws ClientError with problem details on non-2xx", async () => {
    const err = await client.get("/todos/:id", { params: { id: 404 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.status).toBe(404);
    expect(err.problem).toMatchObject({ status: 404, detail: "Todo not found", code: "todo_missing" });
    expect(err.message).toContain("Todo not found");
  });

  test("validation errors expose issues", async () => {
    const err = await client.post("/todos", { body: { title: "" } }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.problem.issues[0].path).toEqual(["body", "title"]);
  });

  test("missing path param is a programmer error", async () => {
    await expect(client.get("/todos/:id")).rejects.toThrow(/Missing path param "id"/);
  });
});

describe("createMcpClient", () => {
  const agent = createMcpClient("http://api.test/mcp", { fetch: shim, headers: { authorization: "Bearer t0k" } });

  test("initialize returns server info", async () => {
    const init = await agent.initialize();
    expect(init.serverInfo).toEqual({ name: "client-test", version: "9.9.9" });
    expect(typeof init.protocolVersion).toBe("string");
  });

  test("listTools returns tools", async () => {
    const tools = await agent.listTools();
    expect(tools.map((t) => t.name)).toContain("get_todos_by_id");
  });

  test("callTool returns structured results and errors", async () => {
    const ok = await agent.callTool("get_todos_by_id", { id: 3 });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toEqual({ id: 3, title: "Buy milk" });
    const bad = await agent.callTool("get_todos_by_id", { id: 404 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("Todo not found");
  });

  test("forwards headers to the tool call", async () => {
    const r = await agent.callTool("get_whoami", {});
    expect(r.structuredContent).toMatchObject({ auth: "Bearer t0k" });
  });

  test("JSON-RPC errors throw McpClientError", async () => {
    const err = await agent.callTool("nope", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect(err.code).toBe(-32602);
  });
});
