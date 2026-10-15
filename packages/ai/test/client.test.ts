import { describe, expect, test } from "bun:test";
import { isMiuError, t } from "miujs";
import { createAI } from "../src/client.ts";
import { anthropic } from "../src/providers/anthropic.ts";
import { openaiCompatible } from "../src/providers/openai.ts";
import { captureLogger, collect, fakeFetch, json, sse } from "./helpers.ts";

const KEY = "sk-ant-client-secret";
const env = { ANTHROPIC_API_KEY: KEY };

const claude = (text: string, over: Record<string, unknown> = {}) =>
  json({ model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4 }, ...over });

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isMiuError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("createAI().generate", () => {
  test("turns a prompt into a user message with sensible defaults", async () => {
    const f = fakeFetch(claude("Hi!"));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    const out = await ai.generate({ prompt: "Hello", system: "Be nice" });
    expect(out.text).toBe("Hi!");
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(f.calls[0].body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, system: "Be nice", messages: [{ role: "user", content: "Hello" }] });
  });

  test("appends the prompt after messages and honors per-call model and maxTokens", async () => {
    const f = fakeFetch(claude("ok"));
    const ai = createAI({ provider: anthropic(), fetch: f, env, model: "claude-sonnet-5-5" });
    await ai.generate({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], prompt: "c", maxTokens: 50 });
    expect(f.calls[0].body.model).toBe("claude-sonnet-5-5");
    expect(f.calls[0].body.max_tokens).toBe(50);
    expect(f.calls[0].body.messages.map((m: any) => m.content)).toEqual(["a", "b", "c"]);
    await ai.generate({ prompt: "x", model: "claude-haiku-5-5" });
    expect(f.calls[1].body.model).toBe("claude-haiku-5-5");
  });

  test("needs a prompt or messages", async () => {
    const ai = createAI({ provider: anthropic(), fetch: fakeFetch(claude("x")), env });
    expect((await caught(ai.generate({}))).code).toBe("MIU_E_AI_CONFIG");
  });

  test("needs a model when the provider has no default", async () => {
    const ai = createAI({ provider: openaiCompatible({ baseUrl: "http://localhost:1/v1" }), fetch: fakeFetch(json({})) });
    const e = await caught(ai.generate({ prompt: "x" }));
    expect(e.code).toBe("MIU_E_AI_CONFIG");
    expect(e.fix).toContain("model");
  });

  test("logs usage at debug level and never logs the key", async () => {
    const { log, lines } = captureLogger("debug");
    const ai = createAI({ provider: anthropic(), fetch: fakeFetch(claude("x")), env, log });
    await ai.generate({ prompt: "x" });
    const usage = lines.find((l) => l.msg === "ai.usage");
    expect(usage).toMatchObject({ level: "debug", provider: "anthropic", model: "claude-opus-5-5", op: "generate", inputTokens: 10, outputTokens: 4 });
    const failing = createAI({ provider: anthropic(), fetch: fakeFetch(json({ error: { message: `no ${KEY}` } }, 400)), env, log });
    await caught(failing.generate({ prompt: "x" }));
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  test("passes cache and temperature through", async () => {
    const f = fakeFetch(claude("x"));
    const ai = createAI({ provider: anthropic(), fetch: f, env, model: "claude-haiku-4-5" });
    await ai.generate({ prompt: "x", cache: true, temperature: 0 });
    expect(f.calls[0].body.cache_control).toEqual({ type: "ephemeral" });
    expect(f.calls[0].body.temperature).toBe(0);
  });
});

describe("createAI().stream", () => {
  test("yields deltas and logs usage when done", async () => {
    const { log, lines } = captureLogger("debug");
    const f = fakeFetch(
      sse([
        ["message_start", { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 5 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hey" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    );
    const ai = createAI({ provider: anthropic(), fetch: f, env, log });
    const events = await collect(ai.stream({ prompt: "x" }));
    expect(events[0]).toEqual({ type: "text", text: "Hey" });
    expect(events.at(-1)).toMatchObject({ type: "finish", stopReason: "end_turn" });
    expect(f.calls[0].body.max_tokens).toBe(64000);
    expect(lines.find((l) => l.msg === "ai.usage")).toMatchObject({ op: "stream", inputTokens: 5, outputTokens: 2 });
  });
});

describe("createAI().object", () => {
  const Person = t.object({ name: t.string({ minLength: 2 }), age: t.integer({ min: 0 }), tags: t.optional(t.array(t.string())) });

  test("uses the provider's JSON schema mode and returns the validated value", async () => {
    const f = fakeFetch(claude('{"name":"Ada","age":36}'));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    const out = await ai.object({ schema: Person, prompt: "Ada, 36" });
    expect(out).toEqual({ name: "Ada", age: 36 });
    const format = f.calls[0].body.output_config.format;
    expect(format.type).toBe("json_schema");
    // Claude structured outputs need closed objects and no numeric/length constraints.
    expect(format.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
      required: ["name", "age"],
      additionalProperties: false,
    });
  });

  test("retries once with the issues fed back, then succeeds", async () => {
    const f = fakeFetch(claude('{"name":"A","age":-1}'), claude('```json\n{"name":"Ada","age":1}\n```'));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    expect(await ai.object({ schema: Person, prompt: "x" })).toEqual({ name: "Ada", age: 1 });
    expect(f.calls.length).toBe(2);
    const msgs = f.calls[1].body.messages;
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toContain("name must be at least 2 characters");
    expect(msgs[2].content).toContain("age must be >= 0");
  });

  test("throws MIU_E_AI_INVALID_OUTPUT with the issues after the retry", async () => {
    const f = fakeFetch(claude("not json"), claude('{"name":"Ada"}'));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    const e = await caught(ai.object({ schema: Person, prompt: "x" }));
    expect(e.code).toBe("MIU_E_AI_INVALID_OUTPUT");
    expect((e.details as any).issues).toEqual([{ path: "age", message: "is required" }]);
    expect(f.calls.length).toBe(2);
  });

  test("a refusal is not retried", async () => {
    const f = fakeFetch(claude("", { stop_reason: "refusal" }));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    expect((await caught(ai.object({ schema: Person, prompt: "x" }))).code).toBe("MIU_E_AI_REFUSED");
    expect(f.calls.length).toBe(1);
  });

  test("schemas the provider cannot enforce fall back to instructions in the system prompt", async () => {
    const f = fakeFetch(claude('{"counts":{"a":1}}'));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    const out = await ai.object({ schema: t.object({ counts: t.record(t.number()) }), prompt: "x" });
    expect(out).toEqual({ counts: { a: 1 } });
    expect(f.calls[0].body.output_config).toBeUndefined();
    expect(f.calls[0].body.system).toContain("JSON Schema");
  });

  test("works with tool-forcing providers", async () => {
    const f = fakeFetch(json({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "respond", arguments: '{"name":"Ada","age":3}' } }] }, finish_reason: "tool_calls" }] }));
    const ai = createAI({ provider: openaiCompatible({ baseUrl: "https://x.test/v1", model: "m" }), fetch: f });
    expect(await ai.object({ schema: Person, prompt: "x" })).toEqual({ name: "Ada", age: 3 });
    expect(f.calls[0].body.tool_choice.function.name).toBe("respond");
  });

  test("the schema root must be an object", async () => {
    const ai = createAI({ provider: anthropic(), fetch: fakeFetch(claude("[]")), env });
    expect((await caught(ai.object({ schema: t.array(t.string()) as any, prompt: "x" }))).code).toBe("MIU_E_AI_CONFIG");
  });
});

describe("createAI().embed", () => {
  test("embeds with the provider's embedding model", async () => {
    const f = fakeFetch(json({ data: [{ index: 0, embedding: [1, 2] }] }));
    const ai = createAI({ provider: openaiCompatible({ baseUrl: "https://x.test/v1", model: "m", embedModel: "e" }), fetch: f });
    expect(await ai.embed("hello")).toEqual([[1, 2]]);
    expect(f.calls[0].body).toEqual({ model: "e", input: ["hello"] });
  });

  test("providers without embeddings fail with MIU_E_AI_UNSUPPORTED unless an embeddings provider is set", async () => {
    const f = fakeFetch(json({ data: [{ index: 0, embedding: [3] }] }));
    const plain = createAI({ provider: anthropic(), fetch: f, env });
    const e = await caught(plain.embed(["x"]));
    expect(e.code).toBe("MIU_E_AI_UNSUPPORTED");
    expect(e.fix).toContain("embeddings");
    const withEmb = createAI({ provider: anthropic(), embeddings: { provider: openaiCompatible({ baseUrl: "https://x.test/v1" }), model: "e2" }, fetch: f, env });
    expect(await withEmb.embed(["x"])).toEqual([[3]]);
  });
});

describe("createAI().inspect", () => {
  test("reports provider, model and features without secrets", () => {
    const ai = createAI({ provider: anthropic({ apiKey: KEY }), env });
    const info = ai.inspect();
    expect(info).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", features: { tools: true, stream: true, structured: "json_schema", embed: false } });
    expect(JSON.stringify(info)).not.toContain(KEY);
  });
});
