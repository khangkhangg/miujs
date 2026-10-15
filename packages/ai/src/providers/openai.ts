// OpenAI-style chat completions (`POST {baseUrl}/chat/completions`): OpenAI, OpenRouter,
// Groq, Together, vLLM, Ollama, LM Studio and anything else speaking that shape.

import { aiErrors } from "../errors.ts";
import { parseSSE, send, streamError } from "../http.ts";
import type { AIMessage, GenerateResult, Provider, ProviderRequest, ProviderRuntime, StreamEvent, ToolCall, Usage } from "../types.ts";
import { gatewayUrl, OPENAI_STOP, openaiUsage, parseArgs, parts, resolveKey, textOf, trimSlash, type GatewayRoute } from "./shared.ts";

export interface OpenAICompatibleOptions {
  /** API root including the version, e.g. `https://openrouter.ai/api/v1` or `http://localhost:11434/v1`. */
  baseUrl: string;
  /** API key. Omit for local servers that need none. */
  apiKey?: string;
  /** Env var holding the key, read per request. */
  apiKeyEnv?: string;
  /** Default chat model for this provider. */
  model?: string;
  /** Default embedding model. */
  embedModel?: string;
  /**
   * How `object()` gets JSON: force a tool call (`"tool"`, default, the most widely supported),
   * `response_format: json_schema`, or plain JSON mode with the schema in the system prompt.
   */
  structured?: "tool" | "json_schema" | "json_object";
  /** Name shown in errors and `inspect()`. Default `"openai-compatible"`. */
  name?: string;
  /** AI Gateway provider slug used by `aiGateway()`. Default `"openai"`. */
  gatewaySlug?: string;
  headers?: Record<string, string>;
}

/** Messages in the chat-completions shape (shared with Workers AI). */
export function toOpenAIMessages(system: string | undefined, messages: AIMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const ps = parts(m.content);
    if (m.role === "assistant") {
      const calls = ps.filter((p) => p.type === "tool_call") as Extract<(typeof ps)[number], { type: "tool_call" }>[];
      const msg: Record<string, unknown> = { role: "assistant", content: textOf(ps) || null };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      out.push(msg);
      continue;
    }
    const text = textOf(ps);
    for (const p of ps) if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.id, content: p.content });
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export function jsonInstruction(schema: unknown): string {
  return `Reply with only a JSON value (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

export function openaiCompatible(opts: OpenAICompatibleOptions): Provider & { withGateway(gw: GatewayRoute): Provider } {
  if (!opts?.baseUrl) {
    throw aiErrors.config("openaiCompatible() needs a baseUrl", 'Pass the API root, e.g. openaiCompatible({ baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }).');
  }
  return make(opts, trimSlash(opts.baseUrl), undefined);
}

function make(opts: OpenAICompatibleOptions, baseUrl: string, gateway: GatewayRoute | undefined): Provider & { withGateway(gw: GatewayRoute): Provider } {
  const name = opts.name ?? "openai-compatible";
  const structured = opts.structured ?? "tool";

  const auth = (rt: ProviderRuntime) => {
    const key = opts.apiKey || opts.apiKeyEnv ? resolveKey(name, opts.apiKey, opts.apiKeyEnv ?? "", rt.env) : undefined;
    const headers: Record<string, string> = { ...opts.headers, "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    if (gateway?.token) headers["cf-aig-authorization"] = `Bearer ${gateway.token}`;
    return { key, headers };
  };

  const build = (req: ProviderRequest, rt: ProviderRuntime, stream: boolean) => {
    const { key, headers } = auth(rt);
    let system = req.system;
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    const tools = (req.tools ?? []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (req.json) {
      if (structured === "tool") {
        tools.push({ type: "function", function: { name: req.json.name, description: "Return the final answer by calling this function.", parameters: req.json.schema } });
        body.tool_choice = { type: "function", function: { name: req.json.name } };
      } else if (structured === "json_schema") {
        body.response_format = { type: "json_schema", json_schema: { name: req.json.name, schema: req.json.schema, strict: req.json.strict } };
      } else {
        body.response_format = { type: "json_object" };
        system = [system, jsonInstruction(req.json.schema)].filter(Boolean).join("\n\n");
      }
    }
    body.messages = toOpenAIMessages(system, req.messages);
    if (tools.length) body.tools = tools;
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    Object.assign(body, req.extra);
    return { key, init: { method: "POST", headers, body: JSON.stringify(body), signal: req.signal } as RequestInit };
  };

  /** In forced-tool JSON mode the answer is the tool call's arguments. */
  const finish = (req: ProviderRequest, text: string, toolCalls: ToolCall[], stopReason: string, usage: Usage, model: string): GenerateResult => {
    if (req.json && structured === "tool") {
      const forced = toolCalls.find((c) => c.name === req.json!.name);
      if (forced) {
        text = JSON.stringify(forced.args);
        toolCalls = toolCalls.filter((c) => c !== forced);
        if (stopReason === "tool_use") stopReason = "end_turn";
      }
    }
    const msgParts = [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls.map((c) => ({ type: "tool_call" as const, ...c }))];
    return { text, toolCalls, usage, stopReason, model, message: { role: "assistant", content: msgParts } };
  };

  return {
    name,
    defaultModel: opts.model,
    defaultEmbedModel: opts.embedModel,
    features: { tools: true, stream: true, structured, embed: true, cache: false },

    async generate(req, rt) {
      const { key, init } = build(req, rt, false);
      const res = await send(rt, name, `${baseUrl}/chat/completions`, init, key);
      const data: any = await res.json();
      const choice = data.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments) }));
      const stop = OPENAI_STOP[choice.finish_reason] ?? choice.finish_reason ?? "end_turn";
      return finish(req, typeof msg.content === "string" ? msg.content : "", toolCalls, stop, openaiUsage(data.usage), data.model ?? req.model);
    },

    async *stream(req, rt): AsyncIterable<StreamEvent> {
      const { key, init } = build(req, rt, true);
      const res = await send(rt, name, `${baseUrl}/chat/completions`, init, key);
      let text = "";
      let stop = "end_turn";
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let model = req.model;
      const pending: { id: string; name: string; args: string }[] = [];
      try {
        for await (const { data } of parseSSE(res.body!)) {
          if (data === "[DONE]") break;
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (ev.error) throw aiErrors.provider(name, undefined, String(ev.error.message ?? ev.error));
          if (ev.model) model = ev.model;
          if (ev.usage) usage = openaiUsage(ev.usage);
          const choice = ev.choices?.[0];
          if (!choice) continue;
          const d = choice.delta ?? {};
          if (typeof d.content === "string" && d.content) {
            text += d.content;
            yield { type: "text", text: d.content };
          }
          for (const tc of d.tool_calls ?? []) {
            const slot = (pending[tc.index ?? 0] ??= { id: "", name: "", args: "" });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
          if (choice.finish_reason) stop = OPENAI_STOP[choice.finish_reason] ?? choice.finish_reason;
        }
      } catch (err) {
        throw streamError(name, err, key);
      }
      const calls = pending.filter(Boolean).map((p) => ({ id: p.id, name: p.name, args: parseArgs(p.args) }));
      const done = finish(req, text, calls, stop, usage, model);
      if (done.text !== text) yield { type: "text", text: done.text };
      for (const c of done.toolCalls) yield { type: "tool_call", ...c };
      yield { type: "finish", stopReason: done.stopReason, usage, model, message: done.message };
    },

    async embed(texts, model, rt) {
      const { key, headers } = auth(rt);
      const res = await send(rt, name, `${baseUrl}/embeddings`, { method: "POST", headers, body: JSON.stringify({ model, input: texts }) }, key);
      const data: any = await res.json();
      const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return rows.map((r) => r.embedding as number[]);
    },

    inspect() {
      const info: Record<string, unknown> = { provider: name, baseUrl, structured };
      if (opts.apiKeyEnv) info.keyEnv = opts.apiKeyEnv;
      else if (opts.apiKey) info.keyEnv = "(explicit apiKey)";
      if (gateway) info.gateway = { accountId: gateway.accountId, gatewayId: gateway.gatewayId };
      return info;
    },

    withGateway(gw) {
      return make(opts, gatewayUrl(gw, opts.gatewaySlug ?? "openai"), gw);
    },
  };
}
