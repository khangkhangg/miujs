// Cloudflare Workers AI through the `env.AI` binding: `env.AI.run(model, inputs, options)`.

import { isMiuError } from "miujs";
import { aiErrors } from "../errors.ts";
import { parseSSE } from "../http.ts";
import type { GenerateResult, Provider, ProviderRequest, ProviderRuntime, StreamEvent, ToolCall, Usage } from "../types.ts";
import { OPENAI_STOP, openaiUsage, parseArgs, type GatewayRoute } from "./shared.ts";
import { toOpenAIMessages } from "./openai.ts";

export const WORKERS_AI_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_AI_DEFAULT_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

/** The part of Cloudflare's `Ai` binding this provider uses. */
export interface WorkersAIBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface WorkersAIOptions {
  /** Default chat model. */
  model?: string;
  /** Default embedding model. */
  embedModel?: string;
}

function bindingFor(name: string, env: ProviderRuntime["env"]): WorkersAIBinding {
  const b = env?.[name] as WorkersAIBinding | undefined;
  if (!b || typeof b.run !== "function") {
    throw aiErrors.binding(name, "Workers AI", `Add \`[ai] binding = "${name}"\` to wrangler.toml (Workers AI only runs on Cloudflare; use anthropic() or openaiCompatible() locally).`);
  }
  return b;
}

function wrap(err: unknown) {
  if (isMiuError(err)) return err;
  return aiErrors.provider("workers-ai", undefined, err instanceof Error ? err.message : String(err));
}

export function workersAI(binding = "AI", opts: WorkersAIOptions = {}): Provider & { readonly binding: string; withGateway(gw: GatewayRoute): Provider } {
  return make(binding, opts, undefined);
}

function make(binding: string, opts: WorkersAIOptions, gateway: GatewayRoute | undefined): Provider & { readonly binding: string; withGateway(gw: GatewayRoute): Provider } {
  const runOpts = gateway ? { gateway: { id: gateway.gatewayId } } : undefined;
  const run = async (rt: ProviderRuntime, model: string, inputs: Record<string, unknown>) => {
    const ai = bindingFor(binding, rt.env);
    try {
      return runOpts ? await ai.run(model, inputs, runOpts) : await ai.run(model, inputs);
    } catch (err) {
      throw wrap(err);
    }
  };

  const inputs = (req: ProviderRequest, stream: boolean) => {
    const body: Record<string, unknown> = { messages: toOpenAIMessages(req.system, req.messages), max_tokens: req.maxTokens };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (req.json) body.response_format = { type: "json_schema", json_schema: req.json.schema };
    if (stream) body.stream = true;
    Object.assign(body, req.extra);
    return body;
  };

  const result = (text: string, toolCalls: ToolCall[], stop: string, usage: Usage, model: string): GenerateResult => ({
    text,
    toolCalls,
    usage,
    stopReason: stop,
    model,
    message: { role: "assistant", content: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls.map((c) => ({ type: "tool_call" as const, ...c }))] },
  });

  return {
    name: "workers-ai",
    binding,
    defaultModel: opts.model ?? WORKERS_AI_DEFAULT_MODEL,
    defaultEmbedModel: opts.embedModel ?? WORKERS_AI_DEFAULT_EMBED_MODEL,
    features: { tools: true, stream: true, structured: "json_schema", embed: true, cache: false },

    async generate(req, rt) {
      const out: any = await run(rt, req.model, inputs(req, false));
      // Newer models answer in the chat-completions shape; classic ones with `response`.
      if (out?.choices) {
        const choice = out.choices[0] ?? {};
        const msg = choice.message ?? {};
        const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({ id: c.id ?? `call_${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) }));
        return result(msg.content ?? "", calls, OPENAI_STOP[choice.finish_reason] ?? (calls.length ? "tool_use" : "end_turn"), openaiUsage(out.usage), req.model);
      }
      const r = out?.response;
      const text = r === null || r === undefined ? "" : typeof r === "string" ? r : JSON.stringify(r);
      const calls: ToolCall[] = (out?.tool_calls ?? []).map((c: any, i: number) => ({
        id: c.id ?? `call_${i}`,
        name: c.name,
        args: typeof c.arguments === "string" ? parseArgs(c.arguments) : (c.arguments ?? {}),
      }));
      return result(text, calls, calls.length ? "tool_use" : "end_turn", openaiUsage(out?.usage), req.model);
    },

    async *stream(req, rt): AsyncIterable<StreamEvent> {
      const body = (await run(rt, req.model, inputs(req, true))) as ReadableStream<Uint8Array>;
      let text = "";
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      try {
        for await (const { data } of parseSSE(body)) {
          if (data === "[DONE]") break;
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (ev.usage) usage = openaiUsage(ev.usage);
          const piece = typeof ev.response === "string" ? ev.response : (ev.choices?.[0]?.delta?.content ?? "");
          if (piece) {
            text += piece;
            yield { type: "text", text: piece };
          }
        }
      } catch (err) {
        throw wrap(err);
      }
      const done = result(text, [], "end_turn", usage, req.model);
      yield { type: "finish", stopReason: "end_turn", usage, model: req.model, message: done.message };
    },

    async embed(texts, model, rt) {
      const out: any = await run(rt, model, { text: texts });
      return out?.data ?? [];
    },

    cloudflare() {
      return { ai: { binding } };
    },

    inspect() {
      const info: Record<string, unknown> = { provider: "workers-ai", binding };
      if (gateway) info.gateway = { accountId: gateway.accountId, gatewayId: gateway.gatewayId };
      return info;
    },

    withGateway(gw) {
      return make(binding, opts, gw);
    },
  };
}
