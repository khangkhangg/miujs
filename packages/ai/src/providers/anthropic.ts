// Claude via the Anthropic Messages API (POST /v1/messages), over plain fetch.

import { aiErrors } from "../errors.ts";
import { parseSSE, send, streamError } from "../http.ts";
import type { AIMessage, GenerateResult, Provider, ProviderRequest, ProviderRuntime, StreamEvent, ToolCall, Usage } from "../types.ts";
import { gatewayUrl, parts, resolveKey, trimSlash, type GatewayRoute } from "./shared.ts";

/** The latest Claude model (Claude Opus 5.5). */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_VERSION = "2023-06-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models that accept `fallbacks: "default"` (server-side refusal fallback). */
const FALLBACK_MODELS = /^claude-(opus-5(-5)?|fable-5-1|sonnet-5-5)$/;
/** Models that reject sampling parameters such as `temperature`. */
const NO_SAMPLING = /^claude-(fable|mythos|opus-5|opus-4-[78]|sonnet-5|haiku-5)/;

export interface AnthropicOptions {
  /** API key. Prefer `apiKeyEnv` so the key stays in the environment. */
  apiKey?: string;
  /** Env var holding the key. Default `ANTHROPIC_API_KEY`. */
  apiKeyEnv?: string;
  /** Default `https://api.anthropic.com`. */
  baseUrl?: string;
  /**
   * Re-run requests the model declines on Anthropic's recommended fallback model, server-side
   * (`fallbacks: "default"`). On by default for the models that support it.
   */
  fallbacks?: boolean;
  /** Extra headers on every request (e.g. a proxy's auth). */
  headers?: Record<string, string>;
}

function toWire(messages: AIMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.raw?.provider === "anthropic" && Array.isArray(m.raw.content)) {
      return { role: "assistant", content: echoable(m.raw.content as any[]) };
    }
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: parts(m.content).map((p) => {
        if (p.type === "text") return { type: "text", text: p.text };
        if (p.type === "tool_call") return { type: "tool_use", id: p.id, name: p.name, input: p.args };
        const r: Record<string, unknown> = { type: "tool_result", tool_use_id: p.id, content: p.content };
        if (p.isError) r.is_error = true;
        return r;
      }),
    };
  });
}

/** After a mid-output refusal fallback, model-internal blocks before the boundary must not be echoed. */
function echoable(content: any[]): any[] {
  let boundary = -1;
  for (let i = 0; i < content.length; i++) if (content[i]?.type === "fallback") boundary = i;
  if (boundary === -1) return content;
  const internal = new Set(["thinking", "redacted_thinking", "tool_use"]);
  return content.filter((b, i) => i > boundary || !internal.has(b?.type));
}

function usageOf(u: any): Usage {
  const out: Usage = { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 };
  if (u?.cache_read_input_tokens !== undefined) out.cacheReadTokens = u.cache_read_input_tokens;
  if (u?.cache_creation_input_tokens !== undefined) out.cacheWriteTokens = u.cache_creation_input_tokens;
  return out;
}

function resultOf(content: any[], stopReason: string, usage: Usage, model: string): GenerateResult {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const b of content) {
    if (b?.type === "text") text += b.text;
    else if (b?.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
  }
  const msgParts = [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls.map((c) => ({ type: "tool_call" as const, ...c }))];
  return {
    text,
    toolCalls,
    usage,
    stopReason,
    model,
    message: { role: "assistant", content: msgParts, raw: { provider: "anthropic", content } },
  };
}

export function anthropic(opts: AnthropicOptions = {}): Provider & { withGateway(gw: GatewayRoute): Provider } {
  return make(opts, trimSlash(opts.baseUrl ?? "https://api.anthropic.com"), undefined);
}

function make(opts: AnthropicOptions, baseUrl: string, gateway: GatewayRoute | undefined): Provider & { withGateway(gw: GatewayRoute): Provider } {
  const keyEnv = opts.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const useFallbacks = opts.fallbacks ?? true;

  const build = (req: ProviderRequest, rt: ProviderRuntime, stream: boolean) => {
    if (req.temperature !== undefined && NO_SAMPLING.test(req.model)) {
      throw aiErrors.unsupported(
        "anthropic",
        `temperature on ${req.model}`,
        `${req.model} rejects sampling parameters. Remove \`temperature\`; steer output with the prompt instead, or use a model that accepts it (e.g. claude-haiku-4-5).`,
      );
    }
    const key = resolveKey("anthropic", opts.apiKey, keyEnv, rt.env);
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens, messages: toWire(req.messages) };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    if (req.cache) body.cache_control = req.cache === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    if (req.json) body.output_config = { format: { type: "json_schema", schema: req.json.schema } };
    const headers: Record<string, string> = {
      ...opts.headers,
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (useFallbacks && FALLBACK_MODELS.test(req.model)) {
      body.fallbacks = "default";
      headers["anthropic-beta"] = FALLBACK_BETA;
    }
    if (gateway?.token) headers["cf-aig-authorization"] = `Bearer ${gateway.token}`;
    if (stream) body.stream = true;
    Object.assign(body, req.extra);
    return { key: [key, gateway?.token], init: { method: "POST", headers, body: JSON.stringify(body), signal: req.signal } as RequestInit };
  };

  return {
    name: "anthropic",
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    features: { tools: true, stream: true, structured: "json_schema", embed: false, cache: true },

    async generate(req, rt) {
      const { key, init } = build(req, rt, false);
      const res = await send(rt, "anthropic", `${baseUrl}/v1/messages`, init, key);
      const data: any = await res.json();
      return resultOf(data.content ?? [], data.stop_reason ?? "end_turn", usageOf(data.usage), data.model ?? req.model);
    },

    async *stream(req, rt): AsyncIterable<StreamEvent> {
      const { key, init } = build(req, rt, true);
      const res = await send(rt, "anthropic", `${baseUrl}/v1/messages`, init, key);
      const blocks: any[] = [];
      const json: string[] = [];
      let model = req.model;
      let stopReason = "end_turn";
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      try {
        for await (const { data } of parseSSE(res.body!)) {
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          switch (ev.type) {
            case "message_start":
              model = ev.message?.model ?? model;
              usage = usageOf(ev.message?.usage);
              break;
            case "content_block_start":
              blocks[ev.index] = { ...ev.content_block };
              if (ev.content_block?.type === "tool_use") json[ev.index] = "";
              break;
            case "content_block_delta": {
              const b = blocks[ev.index];
              const d = ev.delta;
              if (!b || !d) break;
              if (d.type === "text_delta") {
                b.text = (b.text ?? "") + d.text;
                yield { type: "text", text: d.text };
              } else if (d.type === "input_json_delta") json[ev.index] += d.partial_json;
              else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
              else if (d.type === "signature_delta") b.signature = d.signature;
              break;
            }
            case "content_block_stop": {
              const b = blocks[ev.index];
              if (b?.type === "tool_use") {
                let input: Record<string, unknown> = {};
                try {
                  input = json[ev.index] ? JSON.parse(json[ev.index]) : {};
                } catch {}
                b.input = input;
                yield { type: "tool_call", id: b.id, name: b.name, args: input };
              }
              break;
            }
            case "message_delta":
              if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
              // Cumulative counts; input/cache fields appear here only when they changed.
              if (ev.usage) usage = { ...usage, ...usageOf({ input_tokens: usage.inputTokens, ...ev.usage }) };
              break;
            case "error": {
              const t = ev.error?.type;
              if (t === "rate_limit_error") throw aiErrors.rateLimited("anthropic");
              throw aiErrors.provider("anthropic", undefined, String(ev.error?.message ?? t ?? "stream error"));
            }
          }
        }
      } catch (err) {
        throw streamError("anthropic", err, key);
      }
      const done = resultOf(blocks.filter(Boolean), stopReason, usage, model);
      yield { type: "finish", stopReason, usage, model, message: done.message };
    },

    inspect() {
      const info: Record<string, unknown> = { provider: "anthropic", baseUrl, keyEnv: opts.apiKey ? "(explicit apiKey)" : keyEnv, fallbacks: useFallbacks };
      if (gateway) info.gateway = { accountId: gateway.accountId, gatewayId: gateway.gatewayId };
      return info;
    },

    withGateway(gw) {
      return make(opts, gatewayUrl(gw, "anthropic"), gw);
    },
  };
}
