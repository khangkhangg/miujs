import type { CloudflareNeeds, Env, JsonSchema, Logger, Schema } from "miujs";

/** One piece of a message. Providers translate these to and from their own shapes. */
export type AIPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name?: string; content: string; isError?: boolean };

export interface AIMessage {
  role: "user" | "assistant";
  content: string | AIPart[];
  /**
   * The provider's own content for an assistant turn (e.g. Anthropic thinking blocks), echoed back
   * unchanged on the next request to the same provider. Treat as opaque.
   */
  raw?: { provider: string; content: unknown };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Why generation stopped. Anthropic's names are the common vocabulary: OpenAI-style
 * `stop` → `end_turn`, `length` → `max_tokens`, `tool_calls` → `tool_use`, `content_filter` → `refusal`.
 */
export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal" | "pause_turn" | (string & {});

/** A tool definition as sent to a model. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** What a provider is asked to do. Built by the client from the public options. */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: AIMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: ToolSpec[];
  /** Prompt caching: `true` = default TTL, `"1h"` = one hour. Ignored by providers without it. */
  cache?: boolean | "5m" | "1h";
  /** Constrain the reply to JSON matching this schema (structured output). */
  json?: { name: string; schema: JsonSchema; strict: boolean };
  /** Provider-specific extras merged into the request body. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  model: string;
  /** The assistant turn, ready to append to `messages` for a follow-up request. */
  message: AIMessage;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "finish"; stopReason: StopReason; usage: Usage; model: string; message: AIMessage };

/** Per-call runtime services handed to providers. */
export interface ProviderRuntime {
  env: Env;
  fetch: typeof fetch;
  log: Logger;
  /** Milliseconds before a request (or, for streams, the response headers) times out. */
  timeoutMs: number;
  /** Retries on 429, 5xx and network errors. */
  retries: number;
  /** Injectable for tests. */
  sleep: (ms: number) => Promise<void>;
}

export interface ProviderFeatures {
  tools: boolean;
  stream: boolean;
  /** How `object()` constrains output: native JSON schema, a forced tool call, or not at all. */
  structured: "json_schema" | "tool" | "json_object" | "prompt";
  embed: boolean;
  cache: boolean;
}

export interface Provider {
  readonly name: string;
  readonly defaultModel?: string;
  readonly defaultEmbedModel?: string;
  readonly features: ProviderFeatures;
  generate(req: ProviderRequest, rt: ProviderRuntime): Promise<GenerateResult>;
  stream(req: ProviderRequest, rt: ProviderRuntime): AsyncIterable<StreamEvent>;
  embed?(texts: string[], model: string, rt: ProviderRuntime): Promise<number[][]>;
  /** Safe description for `inspect()`. Never includes keys. */
  inspect(): Record<string, unknown>;
  /** Cloudflare bindings the provider needs on Workers (e.g. Workers AI's `[ai]`). */
  cloudflare?(): CloudflareNeeds;
}

export type { Schema };
