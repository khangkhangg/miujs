import { describe, expect, test } from "bun:test";
import { errors, t } from "miujs";
import { createAI } from "../src/client.ts";
import { anthropic } from "../src/providers/anthropic.ts";
import { tool } from "../src/tools.ts";
import { fakeFetch, json } from "./helpers.ts";

const env = { ANTHROPIC_API_KEY: "k" };
let ids = 0;
const turn = (content: unknown[], stop = "tool_use", usage = { input_tokens: 10, output_tokens: 5 }) =>
  json({ model: "claude-opus-5-5", content, stop_reason: stop, usage });
const use = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${++ids}`, name, input });
const text = (s: string) => ({ type: "text", text: s });

const add = tool({
  name: "add",
  description: "Add two numbers",
  input: t.object({ a: t.number(), b: t.number() }),
  run: ({ a, b }) => ({ sum: a + b }),
});

describe("ai.run() agent loop", () => {
  test("calls tools until the model answers, returning a transcript", async () => {
    const f = fakeFetch(turn([{ type: "thinking", thinking: "", signature: "s1" }, use("add", { a: 2, b: 3 })]), turn([text("It is 5.")], "end_turn"));
    const ai = createAI({ provider: anthropic(), fetch: f, env });
    const out = await ai.run({ prompt: "2+3?", tools: [add] });

    expect(out.text).toBe("It is 5.");
    expect(out.stopReason).toBe("end_turn");
    expect(out.steps).toBe(2);
    expect(out.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(out.toolCalls).toMatchObject([{ name: "add", args: { a: 2, b: 3 }, result: '{"sum":5}', isError: false }]);
    expect(out.transcript.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    expect(f.calls[0].body.tools).toEqual([
      { name: "add", description: "Add two numbers", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
    ]);
    const second = f.calls[1].body.messages;
    // The assistant turn goes back unchanged, thinking block included.
    expect(second[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "s1" });
    expect(second[2].content).toEqual([{ type: "tool_result", tool_use_id: second[1].content[1].id, content: '{"sum":5}' }]);
  });

  test("runs parallel tool calls and returns all results in one message", async () => {
    const f = fakeFetch(turn([use("add", { a: 1, b: 1 }), use("add", { a: 2, b: 2 })]), turn([text("done")], "end_turn"));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [add] });
    const results = f.calls[1].body.messages[2].content;
    expect(results.map((r: any) => r.content)).toEqual(['{"sum":2}', '{"sum":4}']);
    expect(out.toolCalls.length).toBe(2);
  });

  test("invalid arguments, unknown tools and thrown errors become error results", async () => {
    const boom = tool({ name: "boom", description: "fails", input: t.object({}), run: () => { throw errors.forbidden("nope"); } });
    const f = fakeFetch(turn([use("add", { a: "x" }), use("missing", {}), use("boom", {})]), turn([text("sorry")], "end_turn"));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [add, boom] });
    const results = f.calls[1].body.messages[2].content;
    expect(results.every((r: any) => r.is_error)).toBe(true);
    expect(results[0].content).toContain("a expected number");
    expect(results[0].content).toContain("b is required");
    expect(results[1].content).toContain("Unknown tool");
    expect(results[2].content).toContain("MIU_E_FORBIDDEN");
    expect(out.toolCalls.map((c) => c.isError)).toEqual([true, true, true]);
  });

  test("stops at maxSteps", async () => {
    const f = fakeFetch(() => turn([use("add", { a: 1, b: 2 })]));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [add], maxSteps: 3 });
    expect(out.stopReason).toBe("max_steps");
    expect(out.steps).toBe(3);
    expect(f.calls.length).toBe(3);
  });

  test("stops when the token budget is spent", async () => {
    const f = fakeFetch(() => turn([use("add", { a: 1, b: 2 })], "tool_use", { input_tokens: 60, output_tokens: 40 }));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [add], limits: { totalTokens: 150 } });
    expect(out.stopReason).toBe("token_limit");
    expect(f.calls.length).toBe(2);
  });

  test("stops when the wall-time budget is spent", async () => {
    const slow = tool({ name: "slow", description: "s", input: t.object({}), run: () => new Promise((r) => setTimeout(() => r("ok"), 40)) });
    const f = fakeFetch(() => turn([use("slow", {})]));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [slow], limits: { timeMs: 20 } });
    expect(out.stopReason).toBe("time_limit");
    expect(f.calls.length).toBe(1);
  });

  test("does not run tools when the turn was cut off by max_tokens", async () => {
    let ran = false;
    const spy = tool({ name: "spy", description: "s", input: t.object({}), run: () => (ran = true) });
    const f = fakeFetch(turn([use("spy", {})], "max_tokens"));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [spy] });
    expect(ran).toBe(false);
    expect(out.stopReason).toBe("max_tokens");
  });

  test("tools accept raw JSON schemas", async () => {
    const echo = tool({ name: "echo", description: "e", input: { type: "object", properties: { v: { type: "string" } } }, run: (a: any) => a.v });
    const f = fakeFetch(turn([use("echo", { v: "hi" })]), turn([text("ok")], "end_turn"));
    const out = await createAI({ provider: anthropic(), fetch: f, env }).run({ prompt: "x", tools: [echo] });
    expect(out.toolCalls[0].result).toBe("hi");
  });
});
