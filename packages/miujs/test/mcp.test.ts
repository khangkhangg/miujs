import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, t, type AuthUser, type MiuOptions } from "../src/index.ts";

const URL_BASE = "http://localhost";

function post(app: { fetch: (r: Request) => Response | Promise<Response> }, body: unknown, headers: Record<string, string> = {}, path = "/mcp") {
  return app.fetch(
    new Request(URL_BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function rpc(app: { fetch: (r: Request) => Response | Promise<Response> }, method: string, params?: unknown, headers?: Record<string, string>) {
  const res = await post(app, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }, headers);
  return { status: res.status, body: (await res.json()) as any };
}

const mk = (opts: MiuOptions) => miu({ logLevel: "silent", dev: true, mcp: true, ...opts });

async function listTools(app: ReturnType<typeof miu>) {
  const { body } = await rpc(app, "tools/list");
  return body.result.tools as any[];
}

async function tool(app: ReturnType<typeof miu>, name: string) {
  return (await listTools(app)).find((x) => x.name === name);
}

async function call(app: ReturnType<typeof miu>, name: string, args: unknown, headers?: Record<string, string>) {
  const { body } = await rpc(app, "tools/call", { name, arguments: args }, headers);
  return body;
}

describe("MCP endpoint and protocol", () => {
  const app = mk({ name: "demo", version: "1.2.3", routes: [route.get("/ping", { name: "pong", handler: () => "pong" })] });

  test("is not served when mcp is off", async () => {
    const off = miu({ logLevel: "silent", routes: [route.get("/a", { handler: () => "a" })] });
    expect((await post(off, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
  });

  test("custom path", async () => {
    const custom = mk({ mcp: { path: "/agent" }, routes: [] });
    expect((await post(custom, { jsonrpc: "2.0", id: 1, method: "ping" }, {}, "/agent")).status).toBe(200);
    expect((await post(custom, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
  });

  test("initialize echoes a supported protocol version and server info", async () => {
    const { status, body } = await rpc(app, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo).toEqual({ name: "demo", version: "1.2.3" });
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.instructions).toBeUndefined();
  });

  test("initialize negotiates every supported version", async () => {
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      expect((await rpc(app, "initialize", { protocolVersion: v })).body.result.protocolVersion).toBe(v);
    }
  });

  test("initialize falls back to the latest version for unknown versions", async () => {
    expect((await rpc(app, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(app, "initialize")).body.result.protocolVersion).toBe("2025-06-18");
  });

  test("initialize includes instructions when configured", async () => {
    const a = mk({ mcp: { instructions: "Use getUser first." }, routes: [] });
    expect((await rpc(a, "initialize", { protocolVersion: "2025-06-18" })).body.result.instructions).toBe("Use getUser first.");
  });

  test("ping returns an empty result", async () => {
    expect((await rpc(app, "ping")).body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("string ids are echoed back", async () => {
    const res = await post(app, { jsonrpc: "2.0", id: "abc", method: "ping" });
    expect((await res.json()).id).toBe("abc");
  });

  test("notifications get 202 with no body", async () => {
    const res = await post(app, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("unknown method is -32601", async () => {
    const { body } = await rpc(app, "resources/list");
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe(1);
  });

  test("parse error is -32700 with a null id", async () => {
    const res = await post(app, "{not json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  test("batches are rejected with -32600", async () => {
    const res = await post(app, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("Batch");
  });

  test("missing jsonrpc or method is -32600", async () => {
    const r1 = await post(app, { id: 5, method: "ping" });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ id: 5, error: { code: -32600 } });
    const r2 = await post(app, { jsonrpc: "2.0", id: 6 });
    expect((await r2.json()).error.code).toBe(-32600);
  });

  test("GET and DELETE are 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.fetch(new Request(URL_BASE + "/mcp", { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("MCP origin checks", () => {
  const app = mk({ mcp: { allowedOrigins: ["https://trusted.example"] }, routes: [] });

  test("no Origin header is allowed (non-browser clients)", async () => {
    expect((await rpc(app, "ping")).status).toBe(200);
  });

  test("same-host Origin is allowed", async () => {
    expect((await rpc(app, "ping", undefined, { origin: "http://localhost" })).status).toBe(200);
  });

  test("allow-listed Origin is allowed", async () => {
    expect((await rpc(app, "ping", undefined, { origin: "https://trusted.example" })).status).toBe(200);
  });

  test("cross-origin requests are rejected with 403", async () => {
    const { status, body } = await rpc(app, "ping", undefined, { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("https://evil.example");
  });

  test("a different port on the same hostname is cross-origin", async () => {
    expect((await rpc(app, "ping", undefined, { origin: "http://localhost:8080" })).status).toBe(403);
  });

  test("an unparseable Origin is rejected", async () => {
    expect((await rpc(app, "ping", undefined, { origin: "null" })).status).toBe(403);
  });

  test("origin check also guards GET", async () => {
    const res = await app.fetch(new Request(URL_BASE + "/mcp", { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
  });
});

describe("tools/list", () => {
  const app = mk({
    routes: [
      route.get("/users/:id", {
        name: "getUser",
        summary: "Get a user",
        description: "Looks a user up by id.",
        params: t.object({ id: t.integer() }),
        query: t.object({ expand: t.optional(t.boolean()), fields: t.array(t.string()) }),
        response: t.object({ id: t.integer(), name: t.string() }),
        handler: ({ params }) => ({ id: params.id, name: "Ann" }),
      }),
      route.post("/users", {
        name: "createUser",
        body: t.object({ name: t.string(), age: t.optional(t.integer()) }),
        status: 201,
        handler: ({ body }) => body,
      }),
      route.put("/users/:id", { name: "putUser", body: t.object({ id: t.string(), name: t.string() }), handler: () => ({}) }),
      route.patch("/notes/:id", { name: "tagNote", body: t.array(t.string()), handler: () => ({}) }),
      route.delete("/users/:id", { name: "deleteUser", auth: "required", handler: () => {} }),
      route.get("/secret", { name: "secret", mcp: false, handler: () => "s" }),
      route.get("/list", { name: "listThings", response: t.array(t.string()), handler: () => ["a"] }),
      route.get("/opt", { name: "optAuth", auth: "optional", handler: () => "x" }),
      route.get("/v1/things.json", { name: "things.json", handler: () => [] }),
    ],
  });

  test("lists every route except mcp: false", async () => {
    const names = (await listTools(app)).map((x) => x.name);
    expect(names).toEqual(["getUser", "createUser", "putUser", "tagNote", "deleteUser", "listThings", "optAuth", "things_json"]);
  });

  test("merges path params, query and body into one input schema", async () => {
    const t1 = await tool(app, "getUser");
    expect(t1.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        expand: { type: "boolean" },
        fields: { type: "array", items: { type: "string" } },
      },
      required: ["id", "fields"],
    });
    const t2 = await tool(app, "createUser");
    expect(t2.inputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name"],
    });
  });

  test("path params without a params schema default to string", async () => {
    expect((await tool(app, "deleteUser")).inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
  });

  test("body is nested under `body` when its keys clash with params", async () => {
    expect((await tool(app, "putUser")).inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
      },
      required: ["id", "body"],
    });
  });

  test("non-object body is nested under `body`", async () => {
    const s = (await tool(app, "tagNote")).inputSchema;
    expect(s.properties.body).toEqual({ type: "array", items: { type: "string" } });
    expect(s.required).toEqual(["id", "body"]);
  });

  test("tools without inputs still have an object input schema", async () => {
    expect((await tool(app, "listThings")).inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("description and title come from summary/description, else method and path", async () => {
    const t1 = await tool(app, "getUser");
    expect(t1.title).toBe("Get a user");
    expect(t1.description).toBe("Get a user\n\nLooks a user up by id.");
    const t2 = await tool(app, "createUser");
    expect(t2.description).toBe("POST /users");
    expect(t2.title).toBeUndefined();
  });

  test("auth routes mention it in the description; optional auth does not", async () => {
    expect((await tool(app, "deleteUser")).description).toBe("DELETE /users/:id\n\nRequires an authenticated user.");
    expect((await tool(app, "optAuth")).description).toBe("GET /opt");
  });

  test("annotations follow the HTTP method", async () => {
    expect((await tool(app, "getUser")).annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect((await tool(app, "createUser")).annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect((await tool(app, "putUser")).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect((await tool(app, "tagNote")).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect((await tool(app, "deleteUser")).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  test("outputSchema only for object response schemas", async () => {
    expect((await tool(app, "getUser")).outputSchema).toEqual({
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" } },
      required: ["id", "name"],
    });
    expect((await tool(app, "listThings")).outputSchema).toBeUndefined();
    expect((await tool(app, "createUser")).outputSchema).toBeUndefined();
  });

  test("tool names are sanitized to [A-Za-z0-9_-] and at most 64 chars", async () => {
    const long = "x".repeat(80);
    const a = mk({ routes: [route.get("/l", { name: long, handler: () => "ok" })] });
    const names = (await listTools(a)).map((x) => x.name);
    expect(names).toEqual(["x".repeat(64)]);
    // and the sanitized name is callable
    expect((await call(app, "things_json", {})).result.isError).toBe(false);
  });

  test("derived route names become tool names", async () => {
    const a = mk({ routes: [route.get("/posts/:slug/comments", { handler: () => [] })] });
    expect((await listTools(a)).map((x) => x.name)).toEqual(["get_posts_by_slug_comments"]);
  });

  test("include filters routes", async () => {
    const a = mk({
      mcp: { include: (r) => r.method === "GET" },
      routes: [route.get("/a", { name: "a", handler: () => "" }), route.post("/b", { name: "b", handler: () => "" })],
    });
    expect((await listTools(a)).map((x) => x.name)).toEqual(["a"]);
  });

  test("internal routes are never tools", async () => {
    const names = (await listTools(app)).map((x) => x.name);
    expect(names.some((n) => n.includes("_miu") || n.includes("mcp"))).toBe(false);
  });
});

describe("tools/call", () => {
  const userPlugin = definePlugin({
    name: "test-user",
    onRequest(ctx) {
      const h = ctx.req.headers.get("authorization");
      if (h?.startsWith("Bearer ")) ctx.user = { id: h.slice(7), roles: [] } satisfies AuthUser;
      const c = ctx.req.headers.get("cookie");
      if (c?.startsWith("uid=")) ctx.user = { id: c.slice(4), roles: [] } satisfies AuthUser;
    },
  });
  const app = mk({
    plugins: [userPlugin],
    routes: [
      route.get("/users/:id", {
        name: "getUser",
        params: t.object({ id: t.integer() }),
        query: t.object({ expand: t.optional(t.boolean()), tags: t.optional(t.array(t.string())) }),
        response: t.object({ id: t.integer(), expand: t.boolean(), tags: t.array(t.string()) }),
        handler: ({ params, query }) => ({ id: params.id, expand: query.expand ?? false, tags: query.tags ?? [] }),
      }),
      route.post("/users", {
        name: "createUser",
        body: t.object({ name: t.string({ minLength: 1 }), age: t.optional(t.integer()) }),
        status: 201,
        handler: ({ body }) => ({ created: body }),
      }),
      route.put("/users/:id", {
        name: "putUser",
        body: t.object({ id: t.string(), name: t.string() }),
        handler: ({ params, body }) => ({ path: params.id, body }),
      }),
      route.post("/tags", { name: "tag", body: t.array(t.string()), handler: ({ body }) => ({ n: body.length }) }),
      route.post("/note", { name: "note", body: t.optional(t.string()), handler: ({ body }) => ({ got: body ?? null }) }),
      route.post("/defaults", {
        name: "defaults",
        body: t.object({ n: t.default(t.integer(), 7) }),
        handler: ({ body }) => ({ n: body.n }),
      }),
      route.get("/files/*rest", { name: "file", handler: ({ params }) => ({ rest: params.rest }) }),
      route.get("/me", { name: "me", auth: "required", handler: ({ user }) => ({ id: user.id }) }),
      route.get("/hello", { name: "hello", handler: () => "hi there" }),
      route.delete("/things/:id", { name: "deleteThing", handler: () => {} }),
      route.get("/boom", { name: "boom", handler: () => { throw new Error("kaboom"); } }),
      route.get("/rid", { name: "rid", handler: ({ req }) => ({ rid: req.headers.get("x-request-id"), other: req.headers.get("x-other") }) }),
    ],
  });

  test("path params and query are placed and coerced", async () => {
    const body = await call(app, "getUser", { id: 42, expand: true, tags: ["a", "b"] });
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: 42, expand: true, tags: ["a", "b"] });
  });

  test("structuredContent is returned when the tool has an outputSchema", async () => {
    const body = await call(app, "getUser", { id: 1 });
    expect(body.result.structuredContent).toEqual({ id: 1, expand: false, tags: [] });
    expect(body.result.content[0].type).toBe("text");
  });

  test("no structuredContent on error results, even with an outputSchema", async () => {
    const body = await call(app, "getUser", { id: "not-a-number" });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toBeUndefined();
  });

  test("no structuredContent without an outputSchema", async () => {
    const body = await call(app, "createUser", { name: "Ann" });
    expect(body.result.structuredContent).toBeUndefined();
  });

  test("flattened body properties are sent as a JSON body", async () => {
    const body = await call(app, "createUser", { name: "Ann", age: 30 });
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ created: { name: "Ann", age: 30 } });
  });

  test("validation errors come back as isError results, not JSON-RPC errors", async () => {
    const body = await call(app, "createUser", { name: "" });
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe("MIU_E_VALIDATION");
  });

  test("missing body properties still send a body so validation can report them", async () => {
    const body = await call(app, "createUser", {});
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe("MIU_E_VALIDATION");
  });

  test("body defaults apply when no body properties are passed", async () => {
    const body = await call(app, "defaults", {});
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ n: 7 });
  });

  test("clashing body is passed whole under `body`", async () => {
    const body = await call(app, "putUser", { id: "p1", body: { id: "b1", name: "N" } });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ path: "p1", body: { id: "b1", name: "N" } });
  });

  test("non-object body is passed whole under `body`", async () => {
    const body = await call(app, "tag", { body: ["x", "y", "z"] });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ n: 3 });
  });

  test("an omitted optional non-object body is not replaced with {}", async () => {
    expect((await tool(app, "note")).inputSchema).toEqual({ type: "object", properties: { body: { type: "string" } } });
    const body = await call(app, "note", {});
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ got: null });
    const body2 = await call(app, "note", { body: "hello" });
    expect(JSON.parse(body2.result.content[0].text)).toEqual({ got: "hello" });
  });

  test("path params are URL-encoded, wildcards keep their slashes", async () => {
    const body = await call(app, "putUser", { id: "a b/c", body: { id: "x", name: "y" } });
    expect(JSON.parse(body.result.content[0].text).path).toBe("a b/c");
    const f = await call(app, "file", { rest: "docs/a b/c.txt" });
    expect(JSON.parse(f.result.content[0].text)).toEqual({ rest: "docs/a b/c.txt" });
  });

  test("an unnamed wildcard is exposed as a valid `wildcard` property and fills the path", async () => {
    const a = mk({ routes: [route.get("/raw/*", { name: "raw", handler: ({ params }) => ({ p: params["*"] }) })] });
    const s = (await tool(a, "raw")).inputSchema;
    expect(s).toEqual({ type: "object", properties: { wildcard: { type: "string" } }, required: ["wildcard"] });
    for (const key of Object.keys(s.properties)) expect(key).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
    const body = await call(a, "raw", { wildcard: "x/y z" });
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ p: "x/y z" });
  });

  test("auth applies: no credentials is an isError 401", async () => {
    const body = await call(app, "me", {});
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe("MIU_E_UNAUTHORIZED");
  });

  test("Authorization header is forwarded to the route", async () => {
    const body = await call(app, "me", {}, { authorization: "Bearer u7" });
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: "u7" });
  });

  test("Cookie header is forwarded to the route", async () => {
    const body = await call(app, "me", {}, { cookie: "uid=c9" });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: "c9" });
  });

  test("x-request-id is forwarded, other headers are not", async () => {
    const body = await call(app, "rid", {}, { "x-request-id": "r-1", "x-other": "nope" });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ rid: "r-1", other: null });
  });

  test("text responses are returned as text content", async () => {
    const body = await call(app, "hello", {});
    expect(body.result).toEqual({ content: [{ type: "text", text: "hi there" }], isError: false });
  });

  test("empty responses describe the status", async () => {
    const body = await call(app, "deleteThing", { id: "1" });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toContain("204");
  });

  test("handler exceptions become isError 500 results", async () => {
    const body = await call(app, "boom", {});
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe("MIU_E_INTERNAL");
  });

  test("missing arguments are treated as {}", async () => {
    const { body } = await rpc(app, "tools/call", { name: "hello" });
    expect(body.result.content[0].text).toBe("hi there");
  });

  test("unknown tool is -32602", async () => {
    const { body } = await rpc(app, "tools/call", { name: "nope", arguments: {} });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("nope");
  });

  test("mcp: false routes cannot be called as tools", async () => {
    const a = mk({ routes: [route.get("/s", { name: "s", mcp: false, handler: () => "s" })] });
    expect((await rpc(a, "tools/call", { name: "s", arguments: {} })).body.error.code).toBe(-32602);
  });
});

describe("plugin MCP tools", () => {
  const plugin = definePlugin({
    name: "rooms",
    mcpTools: () => [
      {
        name: "join",
        description: "Join a room",
        inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
        outputSchema: { type: "object", properties: { joined: { type: "string" } } },
        call: (args, ctx) => ({ joined: String(args.room), by: ctx.req.headers.get("authorization") }),
      },
      { name: "echo", inputSchema: { type: "object" }, call: (args) => `echo:${args.x}` },
      { name: "list", inputSchema: { type: "object" }, call: () => ["a", "b"] },
      { name: "fail", inputSchema: { type: "object" }, call: () => { throw new Error("nope"); } },
    ],
  });
  const app = mk({ plugins: [plugin], routes: [route.get("/r", { name: "r", handler: () => "r" })] });

  test("listed after route tools, description defaults to name", async () => {
    const tools = await listTools(app);
    expect(tools.map((x) => x.name)).toEqual(["r", "join", "echo", "list", "fail"]);
    expect(tools[1]).toEqual({
      name: "join",
      description: "Join a room",
      inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
      outputSchema: { type: "object", properties: { joined: { type: "string" } } },
    });
    expect(tools[2]).toEqual({ name: "echo", description: "echo", inputSchema: { type: "object" } });
  });

  test("object results are text and structuredContent; the context is the MCP request", async () => {
    const body = await call(app, "join", { room: "lobby" }, { authorization: "Bearer z" });
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({ joined: "lobby", by: "Bearer z" });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ joined: "lobby", by: "Bearer z" });
  });

  test("string results are plain text without structuredContent", async () => {
    const body = await call(app, "echo", { x: 1 });
    expect(body.result).toEqual({ content: [{ type: "text", text: "echo:1" }], isError: false });
  });

  test("array results are not sent as structuredContent (it must be an object)", async () => {
    const body = await call(app, "list", {});
    expect(body.result.structuredContent).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toEqual(["a", "b"]);
  });

  test("thrown errors become isError results", async () => {
    const body = await call(app, "fail", {});
    expect(body.result).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });
});
