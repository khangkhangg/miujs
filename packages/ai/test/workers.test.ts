import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { WORKERS_AI_DEFAULT_EMBED_MODEL, WORKERS_AI_DEFAULT_MODEL, workersAI } from "../src/providers/workers.ts";
import type { ProviderRequest } from "../src/types.ts";
import { collect, runtime, sse } from "./helpers.ts";

/** A stand-in for the Cloudflare `env.AI` binding: records calls, answers from a function. */
function fakeAI(answer: (model: string, inputs: any) => unknown) {
  const calls: { model: string; inputs: any; options: any }[] = [];
  return {
    calls,
    async run(model: string, inputs: any, options?: any) {
      calls.push({ model, inputs, options });
      return answer(model, inputs);
    },
  };
}

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: WORKERS_AI_DEFAULT_MODEL,
  messages: [{ role: "user", content: "Hi" }],
  maxTokens: 50,
  ...over,
});

describe("workersAI()", () => {
  test("runs the model through env.AI and parses the reply", async () => {
    const AI = fakeAI(() => ({ response: "Hello", usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const p = workersAI();
    expect(p.defaultModel).toBe(WORKERS_AI_DEFAULT_MODEL);
    const out = await p.generate(req({ system: "Brief", temperature: 0.1 }), runtime({ env: { AI } }));
    expect(AI.calls[0].model).toBe(WORKERS_AI_DEFAULT_MODEL);
    expect(AI.calls[0].inputs).toEqual({
      messages: [
        { role: "system", content: "Brief" },
        { role: "user", content: "Hi" },
      ],
      max_tokens: 50,
      temperature: 0.1,
    });
    expect(out).toMatchObject({ text: "Hello", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1 } });
  });

  test("uses a custom binding name and reports a missing binding", async () => {
    const AI = fakeAI(() => ({ response: "x" }));
    await workersAI("MY_AI").generate(req(), runtime({ env: { MY_AI: AI } }));
    expect(AI.calls.length).toBe(1);
    try {
      await workersAI("MY_AI").generate(req(), runtime({ env: {} }));
      throw new Error("should fail");
    } catch (e) {
      expect(isMiuError(e) && e.code).toBe("MIU_E_AI_BINDING");
    }
  });

  test("tool calls come back with ids", async () => {
    const AI = fakeAI(() => ({ response: null, tool_calls: [{ name: "lookup", arguments: { q: "miu" } }] }));
    const out = await workersAI().generate(req({ tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }] }), runtime({ env: { AI } }));
    expect(AI.calls[0].inputs.tools).toEqual([{ type: "function", function: { name: "lookup", description: "d", parameters: { type: "object" } } }]);
    expect(out.toolCalls).toEqual([{ id: "call_0", name: "lookup", args: { q: "miu" } }]);
    expect(out.stopReason).toBe("tool_use");
  });

  test("structured output uses JSON mode; object responses become JSON text", async () => {
    const AI = fakeAI(() => ({ response: { a: 1 } }));
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const out = await workersAI().generate(req({ json: { name: "r", schema, strict: false } }), runtime({ env: { AI } }));
    expect(AI.calls[0].inputs.response_format).toEqual({ type: "json_schema", json_schema: schema });
    expect(out.text).toBe('{"a":1}');
  });

  test("streams SSE from the binding", async () => {
    const AI = fakeAI(() => sse([[null, { response: "He" }], [null, { response: "y" }], [null, { response: "", usage: { prompt_tokens: 2, completion_tokens: 2 } }], [null, "[DONE]"]]).body);
    const out = await collect(workersAI().stream(req(), runtime({ env: { AI } })));
    expect(AI.calls[0].inputs.stream).toBe(true);
    expect(out.slice(0, 2)).toEqual([
      { type: "text", text: "He" },
      { type: "text", text: "y" },
    ]);
    expect(out[2]).toMatchObject({ type: "finish", usage: { inputTokens: 2, outputTokens: 2 } });
  });

  test("embeds with an embedding model", async () => {
    const AI = fakeAI(() => ({ shape: [2, 2], data: [[1, 0], [0, 1]] }));
    const p = workersAI();
    expect(p.defaultEmbedModel).toBe(WORKERS_AI_DEFAULT_EMBED_MODEL);
    expect(await p.embed!(["a", "b"], WORKERS_AI_DEFAULT_EMBED_MODEL, runtime({ env: { AI } }))).toEqual([[1, 0], [0, 1]]);
    expect(AI.calls[0]).toMatchObject({ model: WORKERS_AI_DEFAULT_EMBED_MODEL, inputs: { text: ["a", "b"] } });
  });

  test("binding errors become MiuErrors", async () => {
    const AI = fakeAI(() => {
      throw new Error("3040: Capacity temporarily exceeded");
    });
    try {
      await workersAI().generate(req(), runtime({ env: { AI } }));
      throw new Error("should fail");
    } catch (e) {
      expect(isMiuError(e) && e.code).toBe("MIU_E_AI_PROVIDER_ERROR");
    }
  });
});
