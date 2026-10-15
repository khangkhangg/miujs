import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { ANTHROPIC_DEFAULT_MODEL, anthropic } from "../src/providers/anthropic.ts";
import type { ProviderRequest } from "../src/types.ts";
import { collect, fakeFetch, json, runtime, sse } from "./helpers.ts";

const KEY = "sk-ant-test-key";
const env = { ANTHROPIC_API_KEY: KEY };

const reply = (over: Record<string, unknown> = {}) =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
    ...over,
  });

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: ANTHROPIC_DEFAULT_MODEL,
  messages: [{ role: "user", content: "Hi" }],
  maxTokens: 1000,
  ...over,
});

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isMiuError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("anthropic() generate", () => {
  test("defaults to the latest Claude model", () => {
    expect(ANTHROPIC_DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(anthropic().defaultModel).toBe("claude-opus-5-5");
  });

  test("sends a Messages API request and parses the reply", async () => {
    const f = fakeFetch(reply());
    const out = await anthropic().generate(req({ system: "Be brief" }), runtime({ fetch: f, env }));
    const call = f.calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.method).toBe("POST");
    expect(call.headers.get("x-api-key")).toBe(KEY);
    expect(call.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      system: "Be brief",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(call.body.stream).toBeUndefined();
    expect(out.text).toBe("Hello world");
    expect(out.toolCalls).toEqual([]);
    expect(out.stopReason).toBe("end_turn");
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 });
    expect(out.model).toBe("claude-opus-5-5");
    // The assistant turn keeps the thinking block so it is echoed back unchanged.
    expect(out.message.raw).toEqual({ provider: "anthropic", content: (await reply().json()).content });
  });

  test("reads the key from a custom env var and fails clearly when missing", async () => {
    const f = fakeFetch(reply());
    await anthropic({ apiKeyEnv: "MY_KEY" }).generate(req(), runtime({ fetch: f, env: { MY_KEY: "k-123" } }));
    expect(f.calls[0].headers.get("x-api-key")).toBe("k-123");

    const e = await caught(anthropic().generate(req(), runtime({ fetch: f, env: {} })));
    expect(e.code).toBe("MIU_E_AI_MISSING_KEY");
    expect(e.fix).toContain("ANTHROPIC_API_KEY");
  });

  test("an explicit apiKey wins over env", async () => {
    const f = fakeFetch(reply());
    await anthropic({ apiKey: "explicit-key" }).generate(req(), runtime({ fetch: f, env }));
    expect(f.calls[0].headers.get("x-api-key")).toBe("explicit-key");
  });

  test("opts into server-side refusal fallbacks on models that support them", async () => {
    const f = fakeFetch(reply());
    await anthropic().generate(req(), runtime({ fetch: f, env }));
    expect(f.calls[0].body.fallbacks).toBe("default");
    expect(f.calls[0].headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");

    await anthropic({ fallbacks: false }).generate(req(), runtime({ fetch: f, env }));
    expect(f.calls[1].body.fallbacks).toBeUndefined();
    expect(f.calls[1].headers.get("anthropic-beta")).toBeNull();

    await anthropic().generate(req({ model: "claude-haiku-4-5" }), runtime({ fetch: f, env }));
    expect(f.calls[2].body.fallbacks).toBeUndefined();
  });

  test("maps tools, tool calls and tool results", async () => {
    const f = fakeFetch(
      reply({
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        stop_reason: "tool_use",
      }),
    );
    const out = await anthropic().generate(
      req({
        tools: [{ name: "get_weather", description: "Weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
        messages: [
          { role: "user", content: "Weather?" },
          { role: "assistant", content: [{ type: "tool_call", id: "toolu_0", name: "get_weather", args: { city: "Rome" } }] },
          { role: "user", content: [{ type: "tool_result", id: "toolu_0", content: "sunny", isError: false }] },
        ],
      }),
      runtime({ fetch: f, env }),
    );
    const body = f.calls[0].body;
    expect(body.tools).toEqual([{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "toolu_0", name: "get_weather", input: { city: "Rome" } }] });
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "sunny" }] });
    expect(out.toolCalls).toEqual([{ id: "toolu_1", name: "get_weather", args: { city: "Paris" } }]);
    expect(out.stopReason).toBe("tool_use");
  });

  test("echoes raw assistant content, dropping blocks before a fallback boundary", async () => {
    const f = fakeFetch(reply());
    const raw = [
      { type: "thinking", thinking: "", signature: "a" },
      { type: "text", text: "partial" },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
      { type: "thinking", thinking: "", signature: "b" },
      { type: "tool_use", id: "t", name: "x", input: {} },
    ];
    await anthropic().generate(
      req({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "ignored", raw: { provider: "anthropic", content: raw } },
          { role: "user", content: [{ type: "tool_result", id: "t", content: "err", isError: true }] },
        ],
      }),
      runtime({ fetch: f, env }),
    );
    const body = f.calls[0].body;
    expect(body.messages[1].content).toEqual([raw[1], raw[2], raw[3], raw[4]]);
    expect(body.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t", content: "err", is_error: true });
  });

  test("prompt caching sets top-level cache_control", async () => {
    const f = fakeFetch(reply());
    await anthropic().generate(req({ cache: true }), runtime({ fetch: f, env }));
    await anthropic().generate(req({ cache: "1h" }), runtime({ fetch: f, env }));
    expect(f.calls[0].body.cache_control).toEqual({ type: "ephemeral" });
    expect(f.calls[1].body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("structured output uses output_config.format", async () => {
    const f = fakeFetch(reply());
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    await anthropic().generate(req({ json: { name: "out", schema, strict: true } }), runtime({ fetch: f, env }));
    expect(f.calls[0].body.output_config).toEqual({ format: { type: "json_schema", schema } });
  });

  test("temperature is rejected up front on models that do not accept it", async () => {
    const f = fakeFetch(reply());
    const e = await caught(anthropic().generate(req({ temperature: 0.2 }), runtime({ fetch: f, env })));
    expect(e.code).toBe("MIU_E_AI_UNSUPPORTED");
    expect(f.calls.length).toBe(0);
    await anthropic().generate(req({ model: "claude-haiku-4-5", temperature: 0.2 }), runtime({ fetch: f, env }));
    expect(f.calls[0].body.temperature).toBe(0.2);
  });

  test("custom baseUrl over a real local server", async () => {
    let seen: any;
    const server = Bun.serve({
      port: 0,
      async fetch(r) {
        seen = { path: new URL(r.url).pathname, key: r.headers.get("x-api-key"), body: await r.json() };
        return reply();
      },
    });
    try {
      const out = await anthropic({ baseUrl: `http://localhost:${server.port}/` }).generate(req(), runtime({ fetch, env }));
      expect(out.text).toBe("Hello world");
      expect(seen.path).toBe("/v1/messages");
      expect(seen.key).toBe(KEY);
    } finally {
      server.stop(true);
    }
  });

  test("inspect() never includes the key", () => {
    const info = JSON.stringify(anthropic({ apiKey: KEY }).inspect());
    expect(info).not.toContain(KEY);
    expect(info).toContain("anthropic");
  });
});

describe("anthropic() stream", () => {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "m", model: "claude-opus-5-5", content: [], usage: { input_tokens: 9, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }],
    ["ping", { type: "ping" }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "lookup", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":' } }],
    ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"miu"}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 2 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];

  test("yields text deltas, tool calls and a finish event", async () => {
    const f = fakeFetch(sse(events));
    const out = await collect(anthropic().stream(req(), runtime({ fetch: f, env })));
    expect(f.calls[0].body.stream).toBe(true);
    expect(out.slice(0, 3)).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "tool_call", id: "toolu_9", name: "lookup", args: { q: "miu" } },
    ]);
    const fin = out[3] as any;
    expect(fin.type).toBe("finish");
    expect(fin.stopReason).toBe("tool_use");
    expect(fin.usage).toEqual({ inputTokens: 9, outputTokens: 20 });
    expect(fin.message.raw.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "miu" } },
    ]);
  });

  test("an error event mid-stream throws a MiuError", async () => {
    const f = fakeFetch(sse([events[0], ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]));
    const e = await caught(collect(anthropic().stream(req(), runtime({ fetch: f, env }))));
    expect(e.code).toBe("MIU_E_AI_PROVIDER_ERROR");
    expect(e.message).toContain("Overloaded");
  });
});
