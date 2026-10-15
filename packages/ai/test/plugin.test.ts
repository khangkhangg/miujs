import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, t, type App } from "miujs";
import { ai, anthropic, appTools, createAI, toSSE } from "../src/index.ts";
import { fakeFetch, json, sse } from "./helpers.ts";

const KEY = "sk-ant-plugin-secret";
const claude = (content: unknown[], stop = "end_turn") => json({ model: "claude-opus-5-5", content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

/** Signs in "Bearer good" as user u1. */
const fakeAuth = definePlugin({
  name: "fake-auth",
  onRequest(ctx) {
    if (ctx.headers.get("authorization") === "Bearer good") ctx.user = { id: "u1", roles: [] };
  },
});

describe("ai() plugin", () => {
  test("decorates ctx.ai, reading the key from the request env", async () => {
    const f = fakeFetch(claude([{ type: "text", text: "Hi there" }]));
    const hello = route.get("/hello", { handler: async ({ ai }) => ({ text: (await ai.generate({ prompt: "Hi" })).text }) });
    const app = miu({ routes: [hello], plugins: [ai({ provider: anthropic(), fetch: f })], logLevel: "silent" });
    const res = await app.dispatch(req("/hello"), { ANTHROPIC_API_KEY: KEY }, { runtime: "workerd" });
    expect(await res.json()).toEqual({ text: "Hi there" });
    expect(f.calls[0].headers.get("x-api-key")).toBe(KEY);
  });

  test("a missing key fails only AI routes, with a fix and without leaking anything", async () => {
    const hello = route.get("/hello", { handler: async ({ ai }) => (await ai.generate({ prompt: "Hi" })).text });
    const plain = route.get("/plain", { handler: () => "ok" });
    const app = miu({ routes: [hello, plain], plugins: [ai({ provider: anthropic(), fetch: fakeFetch(claude([])) })], logLevel: "silent" });
    expect((await app.dispatch(req("/plain"), {}, { runtime: "workerd" })).status).toBe(200);
    const res = await app.dispatch(req("/hello"), {}, { runtime: "workerd" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_AI_MISSING_KEY");
  });

  test("inspect() shows provider, model and features", async () => {
    const app = miu({ plugins: [ai({ provider: anthropic({ apiKey: KEY }) })], logLevel: "silent" });
    await app.ready();
    const info = app.inspect().plugins.find((p) => p.name === "ai")!.info as any;
    expect(info).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", features: { tools: true } });
    expect(JSON.stringify(app.inspect())).not.toContain(KEY);
  });
});

describe("toSSE()", () => {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 2 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "secret-sig" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hey" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ];

  test("streams deltas as server-sent events from a handler", async () => {
    const f = fakeFetch(sse(events));
    const chat = route.get("/chat", { handler: ({ ai }) => toSSE(ai.stream({ prompt: "hi" })) });
    const app = miu({ routes: [chat], plugins: [ai({ provider: anthropic(), fetch: f })], logLevel: "silent" });
    const res = await app.dispatch(req("/chat"), { ANTHROPIC_API_KEY: KEY }, { runtime: "workerd" });
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain('event: text\ndata: {"type":"text","text":"Hey"}\n\n');
    expect(body).toContain('event: finish\ndata: {"type":"finish","stopReason":"end_turn","usage":{"inputTokens":2,"outputTokens":1},"model":"claude-opus-5-5"}\n\n');
    expect(body).not.toContain("secret-sig");
  });

  test("errors become an error event", async () => {
    const f = fakeFetch(json({ error: { message: `bad ${KEY}` } }, 400));
    const res = toSSE(createAI({ provider: anthropic(), fetch: f, env: { ANTHROPIC_API_KEY: KEY } }).stream({ prompt: "x" }));
    const body = await res.text();
    expect(body).toContain("event: error\n");
    expect(body).toContain("MIU_E_AI_BAD_REQUEST");
    expect(body).not.toContain(KEY);
  });
});

describe("appTools()", () => {
  const notes: string[] = [];
  const listNotes = route.get("/notes", { name: "listNotes", summary: "List notes", handler: () => ({ notes }) });
  const createNote = route.post("/notes", {
    name: "createNote",
    summary: "Create a note",
    body: t.object({ text: t.string() }),
    auth: "required",
    handler: ({ body, user }) => {
      notes.push(body.text);
      return { created: body.text, by: user.id };
    },
  });
  let app: App;
  const agent = route.post("/agent", {
    body: t.object({ prompt: t.string(), implicit: t.optional(t.boolean()) }),
    handler: async ({ ai, body }) => {
      const tools = body.implicit ? appTools({ include: ["createNote"] }) : appTools(app, { include: ["createNote"] });
      const out = await ai.run({ prompt: body.prompt, tools: [tools] });
      return { text: out.text, calls: out.toolCalls };
    },
  });
  const script = () =>
    fakeFetch(
      claude([{ type: "tool_use", id: "toolu_1", name: "createNote", input: { text: "buy milk" } }], "tool_use"),
      claude([{ type: "text", text: "Saved." }]),
    );
  const build = (f: typeof fetch, mcp = true) => {
    app = miu({ routes: [listNotes, createNote, agent], plugins: [fakeAuth, ai({ provider: anthropic(), fetch: f })], mcp, logLevel: "silent" });
    return app;
  };
  const post = (body: unknown, auth?: string) =>
    app.dispatch(req("/agent", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }), { ANTHROPIC_API_KEY: KEY }, { runtime: "bun" });

  test("exposes routes as tools and calls them with the user's auth", async () => {
    const f = script();
    build(f);
    const res = await post({ prompt: "Remember to buy milk" }, "Bearer good");
    const out = await res.json();
    expect(out.text).toBe("Saved.");
    expect(out.calls[0]).toMatchObject({ name: "createNote", isError: false });
    expect(JSON.parse(out.calls[0].result)).toEqual({ created: "buy milk", by: "u1" });
    // Only the included tool is offered, with the MCP description and input schema.
    expect(f.calls[0].body.tools).toEqual([
      { name: "createNote", description: "Create a note\n\nRequires an authenticated user.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    ]);
    expect(notes).toContain("buy milk");
  });

  test("permissions apply: an anonymous request gets a tool error", async () => {
    const f = script();
    build(f);
    const out = await (await post({ prompt: "x" })).json();
    expect(out.calls[0].isError).toBe(true);
    expect(out.calls[0].result).toContain("MIU_E_UNAUTHORIZED");
    expect(f.calls[1].body.messages[2].content[0].is_error).toBe(true);
  });

  test("appTools() without an app uses the plugin's app", async () => {
    build(script());
    const out = await (await post({ prompt: "x", implicit: true }, "Bearer good")).json();
    expect(out.calls[0].isError).toBe(false);
  });

  test("needs MCP on", async () => {
    build(script(), false);
    const res = await post({ prompt: "x" }, "Bearer good");
    expect((await res.json()).error.code).toBe("MIU_E_AI_CONFIG");
  });

  test("works outside requests with createAI and explicit headers", async () => {
    build(script());
    const client = createAI({ provider: anthropic(), fetch: script(), env: { ANTHROPIC_API_KEY: KEY } });
    const out = await client.run({ prompt: "x", tools: [appTools(app, { include: ["createNote"], headers: { authorization: "Bearer good" } })] });
    expect(out.toolCalls[0].isError).toBe(false);
  });
});
