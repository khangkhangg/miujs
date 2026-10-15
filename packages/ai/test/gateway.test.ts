import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { aiGateway } from "../src/providers/gateway.ts";
import { anthropic } from "../src/providers/anthropic.ts";
import { openaiCompatible } from "../src/providers/openai.ts";
import { workersAI } from "../src/providers/workers.ts";
import type { Provider, ProviderRequest } from "../src/types.ts";
import { fakeFetch, json, runtime } from "./helpers.ts";

const req = (model: string): ProviderRequest => ({ model, messages: [{ role: "user", content: "Hi" }], maxTokens: 10 });
const gw = { accountId: "acc1", gatewayId: "gw1" };

describe("aiGateway()", () => {
  test("routes Anthropic through the gateway, keeping the provider key", async () => {
    const f = fakeFetch(json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }));
    const p = aiGateway({ ...gw, token: "cf-token" }, anthropic());
    const out = await p.generate(req("claude-opus-5-5"), runtime({ fetch: f, env: { ANTHROPIC_API_KEY: "k" } }));
    expect(out.text).toBe("ok");
    expect(f.calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acc1/gw1/anthropic/v1/messages");
    expect(f.calls[0].headers.get("x-api-key")).toBe("k");
    expect(f.calls[0].headers.get("cf-aig-authorization")).toBe("Bearer cf-token");
    expect(p.inspect()).toMatchObject({ provider: "anthropic", gateway: gw });
    expect(JSON.stringify(p.inspect())).not.toContain("cf-token");
  });

  test("routes OpenAI-compatible providers by slug", async () => {
    const f = fakeFetch(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    await aiGateway(gw, openaiCompatible({ baseUrl: "https://openrouter.ai/api/v1", gatewaySlug: "openrouter" })).generate(req("m"), runtime({ fetch: f }));
    expect(f.calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acc1/gw1/openrouter/chat/completions");
  });

  test("passes the gateway to Workers AI runs", async () => {
    const calls: unknown[] = [];
    const AI = { run: async (_m: string, _i: unknown, o?: unknown) => (calls.push(o), { response: "ok" }) };
    await aiGateway(gw, workersAI()).generate(req("@cf/x"), runtime({ env: { AI } }));
    expect(calls[0]).toEqual({ gateway: { id: "gw1" } });
  });

  test("rejects providers that cannot be routed", () => {
    const custom = { name: "custom", features: {}, inspect: () => ({}) } as unknown as Provider;
    try {
      aiGateway(gw, custom);
      throw new Error("should fail");
    } catch (e) {
      expect(isMiuError(e) && e.code).toBe("MIU_E_AI_UNSUPPORTED");
    }
  });
});

describe("gateway token stays out of errors (audit 2026-10-16)", () => {
  const echo = json({ error: { message: "bad auth: gateway Bearer gw-token-SECRET999 key sk-SECRETKEY123456" } }, 401);
  for (const [name, make] of [
    ["anthropic", () => aiGateway({ ...gw, token: "gw-token-SECRET999" }, anthropic({ apiKey: "sk-SECRETKEY123456" }))],
    ["openai-compatible", () => aiGateway({ ...gw, token: "gw-token-SECRET999" }, openaiCompatible({ baseUrl: "https://api.openai.com/v1", gatewaySlug: "openai", apiKey: "sk-SECRETKEY123456" }))],
  ] as const) {
    test(`${name}: both the provider key and the gateway token are redacted`, async () => {
      const err = await make().generate(req("m"), runtime({ fetch: fakeFetch(echo) })).catch((e) => e);
      const text = JSON.stringify({ m: err.message, d: err.details });
      expect(text).not.toContain("gw-token-SECRET999");
      expect(text).not.toContain("SECRETKEY123456");
    });
  }
});
