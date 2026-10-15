import { describe, expect, test } from "bun:test";
import { openaiCompatible } from "../src/providers/openai.ts";
import type { ProviderRequest } from "../src/types.ts";
import { collect, fakeFetch, json, runtime, sse } from "./helpers.ts";

const completion = (message: Record<string, unknown>, finish = "stop") =>
  json({
    id: "c1",
    model: "llama-3",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "llama-3",
  messages: [{ role: "user", content: "Hi" }],
  maxTokens: 100,
  ...over,
});

describe("openaiCompatible() generate", () => {
  test("posts chat completions and parses the reply", async () => {
    const f = fakeFetch(completion({ content: "Hello" }));
    const p = openaiCompatible({ baseUrl: "https://openrouter.test/api/v1/", apiKey: "or-key", model: "llama-3" });
    expect(p.defaultModel).toBe("llama-3");
    const out = await p.generate(req({ system: "Be brief", temperature: 0.3 }), runtime({ fetch: f }));
    const c = f.calls[0];
    expect(c.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(c.headers.get("authorization")).toBe("Bearer or-key");
    expect(c.body).toEqual({
      model: "llama-3",
      max_tokens: 100,
      temperature: 0.3,
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out).toMatchObject({ text: "Hello", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 }, model: "llama-3" });
  });

  test("sends no Authorization header without a key (local models)", async () => {
    const f = fakeFetch(completion({ content: "x" }));
    await openaiCompatible({ baseUrl: "http://localhost:11434/v1" }).generate(req(), runtime({ fetch: f }));
    expect(f.calls[0].headers.get("authorization")).toBeNull();
  });

  test("apiKeyEnv reads the key from env", async () => {
    const f = fakeFetch(completion({ content: "x" }));
    await openaiCompatible({ baseUrl: "https://x.test/v1", apiKeyEnv: "OPENROUTER_API_KEY" }).generate(req(), runtime({ fetch: f, env: { OPENROUTER_API_KEY: "k1" } }));
    expect(f.calls[0].headers.get("authorization")).toBe("Bearer k1");
  });

  test("maps tools, tool calls and tool results", async () => {
    const f = fakeFetch(completion({ content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"miu"}' } }] }, "tool_calls"));
    const out = await openaiCompatible({ baseUrl: "https://x.test/v1" }).generate(
      req({
        tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_call", id: "call_0", name: "lookup", args: { q: "a" } }] },
          { role: "user", content: [{ type: "tool_result", id: "call_0", name: "lookup", content: "found" }] },
        ],
      }),
      runtime({ fetch: f }),
    );
    const body = f.calls[0].body;
    expect(body.tools).toEqual([{ type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object", properties: {} } } }]);
    expect(body.messages.slice(1)).toEqual([
      { role: "assistant", content: "Let me look.", tool_calls: [{ id: "call_0", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }] },
      { role: "tool", tool_call_id: "call_0", content: "found" },
    ]);
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "lookup", args: { q: "miu" } }]);
    expect(out.stopReason).toBe("tool_use");
  });

  test("structured output forces a tool by default and returns its arguments as text", async () => {
    const f = fakeFetch(completion({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "respond", arguments: '{"a":1}' } }] }, "tool_calls"));
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const out = await openaiCompatible({ baseUrl: "https://x.test/v1" }).generate(req({ json: { name: "respond", schema, strict: false } }), runtime({ fetch: f }));
    const body = f.calls[0].body;
    expect(body.tools).toEqual([{ type: "function", function: { name: "respond", description: expect.any(String), parameters: schema } }]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "respond" } });
    expect(out.text).toBe('{"a":1}');
    expect(out.toolCalls).toEqual([]);
  });

  test("structured: 'json_schema' uses response_format", async () => {
    const f = fakeFetch(completion({ content: '{"a":1}' }));
    const schema = { type: "object", properties: { a: { type: "number" } } };
    await openaiCompatible({ baseUrl: "https://x.test/v1", structured: "json_schema" }).generate(req({ json: { name: "respond", schema, strict: true } }), runtime({ fetch: f }));
    expect(f.calls[0].body.response_format).toEqual({ type: "json_schema", json_schema: { name: "respond", schema, strict: true } });
  });

  test("structured: 'json_object' uses JSON mode and puts the schema in the system prompt", async () => {
    const f = fakeFetch(completion({ content: '{"a":1}' }));
    const schema = { type: "object", properties: { a: { type: "number" } } };
    await openaiCompatible({ baseUrl: "https://x.test/v1", structured: "json_object" }).generate(req({ json: { name: "respond", schema, strict: true } }), runtime({ fetch: f }));
    expect(f.calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(f.calls[0].body.messages[0].role).toBe("system");
    expect(f.calls[0].body.messages[0].content).toContain('"properties"');
  });
});

describe("openaiCompatible() stream", () => {
  test("yields text, assembled tool calls and usage", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    const f = fakeFetch(
      sse([
        [null, chunk({ role: "assistant", content: "Hi" })],
        [null, chunk({ content: " there" })],
        [null, chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":' } }] })],
        [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] })],
        [null, chunk({}, "tool_calls")],
        [null, { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } }],
        [null, "[DONE]"],
      ]),
    );
    const out = await collect(openaiCompatible({ baseUrl: "https://x.test/v1" }).stream(req(), runtime({ fetch: f })));
    expect(f.calls[0].body.stream).toBe(true);
    expect(f.calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(out.slice(0, 3)).toEqual([
      { type: "text", text: "Hi" },
      { type: "text", text: " there" },
      { type: "tool_call", id: "call_1", name: "lookup", args: { q: "x" } },
    ]);
    expect(out[3]).toMatchObject({ type: "finish", stopReason: "tool_use", usage: { inputTokens: 4, outputTokens: 6 } });
  });
});

describe("openaiCompatible() embed", () => {
  test("posts /embeddings and returns vectors in input order", async () => {
    const f = fakeFetch(json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
    const p = openaiCompatible({ baseUrl: "https://x.test/v1", embedModel: "text-embedding-3-small" });
    expect(p.defaultEmbedModel).toBe("text-embedding-3-small");
    const out = await p.embed!(["a", "b"], "text-embedding-3-small", runtime({ fetch: f }));
    expect(f.calls[0].url).toBe("https://x.test/v1/embeddings");
    expect(f.calls[0].body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
    expect(out).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});
