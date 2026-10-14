import { describe, expect, test } from "bun:test";
import { Miu, t } from "../../src/index.ts";
import { generateLlmsFullTxt, generateLlmsTxt, llms } from "../../src/ai/llms.ts";

const makeApp = () =>
  new Miu({ name: "todo-api", version: "1.2.0", description: "Todos for humans and agents", logger: false })
    .get("/todos", { summary: "List todos", query: t.object({ limit: t.optional(t.integer()), tag: t.optional(t.array(t.string())) }) }, () => [])
    .get(
      "/todos/:id",
      { summary: "Get a todo", params: t.object({ id: t.integer() }), response: t.object({ id: t.integer(), title: t.string() }) },
      (c) => ({ id: c.params.id, title: "x" }),
    )
    .post(
      "/todos",
      { description: "Create a todo item", body: t.object({ title: t.string({ min: 1 }), done: t.optional(t.boolean()) }), tool: { name: "create_todo" } },
      () => ({}),
    )
    .get("/internal", { hidden: true, summary: "Internal" }, () => "x")
    .get("/no-tool", { tool: false, summary: "Not a tool" }, () => "x")
    .all("/catch", () => "x")
    .options("/opts", { summary: "Options route" }, () => "x");

describe("generateLlmsTxt", () => {
  test("has llms.txt header: title, summary blockquote, intro", () => {
    const txt = generateLlmsTxt(makeApp(), { intro: "Use the MCP endpoint if you are an agent." });
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# todo-api");
    expect(txt).toContain("> Todos for humans and agents");
    expect(txt).toContain("Use the MCP endpoint if you are an agent.");
    expect(txt).toContain("Version 1.2.0");
  });

  test("lists documented routes in an API section with inputs", () => {
    const txt = generateLlmsTxt(makeApp(), { baseUrl: "https://api.example.com" });
    expect(txt).toContain("## API");
    expect(txt).toContain("- [GET /todos](https://api.example.com/todos): List todos");
    expect(txt).toMatch(/\[GET \/todos\/\{id\}\]\(https:\/\/api\.example\.com\/todos\/\{id\}\): Get a todo.*id \(integer\)/);
    expect(txt).toMatch(/\[POST \/todos\]\(.*\): Create a todo item.*title \(string\).*done \(boolean, optional\)/);
    expect(txt).toContain("limit (integer, optional)");
    expect(txt).toContain("tag (string[], optional)");
    expect(txt).toContain("`create_todo`");
  });

  test("excludes hidden, tool:false, ALL and non-standard methods", () => {
    const txt = generateLlmsTxt(makeApp());
    expect(txt).not.toContain("/internal");
    expect(txt).not.toContain("/no-tool");
    expect(txt).not.toContain("/catch");
    expect(txt).not.toContain("/opts");
  });

  test("skips routes with unknown methods (e.g. WS)", () => {
    const app = makeApp();
    (app.routes as any[]).push({ method: "WS", path: "/chat", meta: { summary: "Chat socket" }, handler: () => {} });
    expect(generateLlmsTxt(app)).not.toContain("/chat");
  });

  test("has an Agent access section with MCP and OpenAPI links", () => {
    const txt = generateLlmsTxt(makeApp(), { baseUrl: "https://api.example.com/" });
    expect(txt).toContain("## Agent access");
    expect(txt).toContain("(https://api.example.com/mcp)");
    expect(txt).toContain("(https://api.example.com/openapi.json)");
    expect(txt).toContain("(https://api.example.com/llms-full.txt)");
  });

  test("relative links without baseUrl, custom endpoint paths", () => {
    const txt = generateLlmsTxt(makeApp(), { mcpPath: "/agents/mcp", openapiPath: false });
    expect(txt).toContain("(/agents/mcp)");
    expect(txt).not.toContain("openapi.json");
    expect(txt).toContain("- [GET /todos](/todos)");
  });

  test("appends custom sections", () => {
    const txt = generateLlmsTxt(makeApp(), {
      sections: [{ title: "Docs", links: [{ title: "Guide", url: "https://x.dev/guide", description: "How to use" }, { title: "FAQ", url: "https://x.dev/faq" }] }],
    });
    expect(txt).toContain("## Docs\n\n- [Guide](https://x.dev/guide): How to use\n- [FAQ](https://x.dev/faq)");
  });
});

describe("generateLlmsFullTxt", () => {
  test("includes JSON Schemas for params, query, body and response", () => {
    const txt = generateLlmsFullTxt(makeApp());
    expect(txt.split("\n")[0]).toBe("# todo-api");
    expect(txt).toContain("## GET /todos/{id}");
    expect(txt).toContain("Tool: `get_todos_by_id`");
    expect(txt).toContain("### Path parameters");
    expect(txt).toContain("### Query");
    expect(txt).toContain("### Request body");
    expect(txt).toContain("### Response");
    expect(txt).toContain('"minLength": 1');
    expect(txt).toContain("```json");
    expect(txt).not.toContain("/internal");
  });
});

describe("llms() middleware", () => {
  test("serves /llms.txt and /llms-full.txt as text/plain", async () => {
    const app = makeApp().use(llms({ intro: "hello agents" }));
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("hello agents");
    expect(body).toContain("(http://localhost/todos)");

    const full = await app.request("/llms-full.txt");
    expect(full.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await full.text()).toContain("### Request body");
  });

  test("custom paths and passthrough", async () => {
    const app = makeApp().use(llms({ path: "/ai.txt", fullPath: "/ai-full.txt" }));
    expect((await app.request("/ai.txt")).status).toBe(200);
    expect((await app.request("/ai-full.txt")).status).toBe(200);
    expect((await app.request("/llms.txt")).status).toBe(404);
    expect((await app.request("/todos")).status).toBe(200);
  });

  test("caches the generated document", async () => {
    const app = makeApp().use(llms());
    const a = await (await app.request("/llms.txt")).text();
    app.get("/later", { summary: "Added later" }, () => "x");
    const b = await (await app.request("/llms.txt")).text();
    expect(b).toBe(a);
  });
});
