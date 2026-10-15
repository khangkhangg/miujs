// The AI client behind `ctx.ai` (per request) and `createAI()` (jobs, workflows, scripts).

import { createLogger, processEnv, validate, type App, type Context, type Env, type Infer, type Issue, type Logger, type ObjectSchema } from "miujs";
import { runLoop, type RunOptions, type RunResult } from "./agent.ts";
import { answer, indexDocs, type IndexOptions, type RagOptions, type RagResult } from "./rag.ts";
import { aiErrors } from "./errors.ts";
import { jsonInstruction } from "./providers/openai.ts";
import { closedSchema, feedback, parseJsonOutput } from "./structured.ts";
import type { AIMessage, GenerateResult, Provider, ProviderRequest, ProviderRuntime, StreamEvent, ToolSpec, Usage } from "./types.ts";

export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_STREAM_MAX_TOKENS = 64_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRIES = 2;

export interface AIOptions {
  /** Where requests go: anthropic(), openaiCompatible(), workersAI(), or aiGateway(...) around one. */
  provider: Provider;
  /** Default model. Defaults to the provider's default (Claude Opus 5.5 for anthropic()). */
  model?: string;
  /** A separate provider/model for `embed()` and RAG, e.g. Workers AI embeddings with Claude for answers. */
  embeddings?: { provider?: Provider; model?: string };
  /** Default `max_tokens` for generate/object/run/rag. Default 16000 (64000 for stream). */
  maxTokens?: number;
  /** Milliseconds to wait for a response (for streams: for the headers). Default 120000. */
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors, with backoff honoring `retry-after`. Default 2. */
  retries?: number;
  /** Injected fetch (tests, proxies). Default global fetch. */
  fetch?: typeof fetch;
  /** `createAI` only: env vars and bindings. Default: the process environment. */
  env?: Env;
  /** `createAI` only: where usage is logged (debug level). */
  log?: Logger;
  /** @internal Injectable backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** A tool the model may call. Build with `tool()`, or expose routes with `appTools()`. */
export interface GenerateOptions {
  system?: string;
  /** A user message, appended after `messages`. */
  prompt?: string;
  messages?: AIMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Tools the model may call. `generate` only reports calls; `run()` executes them. */
  tools?: ToolSpec[];
  /** Prompt caching (Anthropic): `true` caches the prompt prefix for 5 minutes, `"1h"` for an hour. */
  cache?: boolean | "5m" | "1h";
  signal?: AbortSignal;
  /** Provider-specific fields merged into the request body. */
  extra?: Record<string, unknown>;
}

export interface ObjectOptions<S extends ObjectSchema<any>> extends Omit<GenerateOptions, "tools"> {
  schema: S;
}

/** Request-scoped services. */
export interface Scope {
  env: Env;
  log: Logger;
  ctx?: Context;
  /** The app, for `appTools()` without an explicit app. */
  app?: App;
}

export interface AIClient {
  generate(opts: GenerateOptions): Promise<GenerateResult>;
  stream(opts: GenerateOptions): AsyncIterable<StreamEvent>;
  object<S extends ObjectSchema<any>>(opts: ObjectOptions<S>): Promise<Infer<S>>;
  embed(texts: string | string[], opts?: { model?: string }): Promise<number[][]>;
  /** Tool-use loop: the model calls tools until it answers or a limit is hit. */
  run(opts: RunOptions): Promise<RunResult>;
  /** Embeds documents into a vector store (text kept in `metadata.text`) for `rag()`. */
  index(opts: IndexOptions): Promise<void>;
  /** Answers `query` from the `topK` nearest chunks in `store`, citing them. */
  rag(opts: RagOptions): Promise<RagResult>;
  inspect(): Record<string, unknown>;
}

export interface Internals {
  opts: AIOptions;
  scope: Scope;
  runtime(): ProviderRuntime;
  modelFor(m?: string): string;
  request(o: GenerateOptions, defaultMax: number): ProviderRequest;
  logUsage(op: string, model: string, usage: Usage, started: number): void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function internals(opts: AIOptions, scope: Scope): Internals {
  const p = opts.provider;
  const self: Internals = {
    opts,
    scope,
    runtime: () => ({
      env: scope.env,
      fetch: opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch,
      log: scope.log,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retries: opts.retries ?? DEFAULT_RETRIES,
      sleep: opts.sleep ?? realSleep,
    }),
    modelFor(m) {
      const model = m ?? opts.model ?? p.defaultModel;
      if (!model) {
        throw aiErrors.config(`No model set for the ${p.name} provider`, `Pass a model: ai({ provider, model: "..." }), the provider's \`model\` option, or { model } per call.`);
      }
      return model;
    },
    request(o, defaultMax) {
      const messages: AIMessage[] = [...(o.messages ?? [])];
      if (o.prompt !== undefined) messages.push({ role: "user", content: o.prompt });
      if (!messages.length) throw aiErrors.config("No input for the model", "Pass `prompt` (a string) or `messages` (an array of { role, content }).");
      const req: ProviderRequest = { model: self.modelFor(o.model), messages, maxTokens: o.maxTokens ?? opts.maxTokens ?? defaultMax };
      if (o.system) req.system = o.system;
      if (o.temperature !== undefined) req.temperature = o.temperature;
      if (o.tools?.length) req.tools = o.tools;
      if (o.cache) req.cache = o.cache;
      if (o.signal) req.signal = o.signal;
      if (o.extra) req.extra = o.extra;
      return req;
    },
    logUsage(op, model, usage, started) {
      scope.log.debug("ai.usage", { provider: p.name, model, op, ...usage, ms: Math.round(performance.now() - started) });
    },
  };
  return self;
}

export function makeClient(opts: AIOptions, scope: Scope): AIClient {
  const p = opts.provider;
  const it = internals(opts, scope);

  const generate = async (o: GenerateOptions): Promise<GenerateResult> => {
    const req = it.request(o, DEFAULT_MAX_TOKENS);
    const started = performance.now();
    const out = await p.generate(req, it.runtime());
    it.logUsage("generate", out.model, out.usage, started);
    return out;
  };

  async function* stream(o: GenerateOptions): AsyncIterable<StreamEvent> {
    const req = it.request(o, DEFAULT_STREAM_MAX_TOKENS);
    const started = performance.now();
    for await (const ev of p.stream(req, it.runtime())) {
      if (ev.type === "finish") it.logUsage("stream", ev.model, ev.usage, started);
      yield ev;
    }
  }

  async function object<S extends ObjectSchema<any>>(o: ObjectOptions<S>): Promise<Infer<S>> {
    const { schema, ...rest } = o;
    if (schema?.json?.type !== "object") {
      throw aiErrors.config("object() needs a t.object(...) schema", "Wrap the value in an object, e.g. schema: t.object({ items: t.array(...) }).");
    }
    const base = it.request(rest, DEFAULT_MAX_TOKENS);
    const mode = p.features.structured;
    const strict = mode === "json_schema" ? closedSchema(schema.json) : null;
    if (mode === "prompt" || (mode === "json_schema" && !strict)) {
      base.system = [base.system, jsonInstruction(schema.json)].filter(Boolean).join("\n\n");
    } else {
      base.json = { name: "respond", schema: strict ?? schema.json, strict: false };
    }
    let messages = base.messages;
    let lastText = "";
    let issues: Issue[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now();
      const out = await p.generate({ ...base, messages }, it.runtime());
      it.logUsage("object", out.model, out.usage, started);
      if (out.stopReason === "refusal") throw aiErrors.refused(p.name);
      lastText = out.text;
      const parsed = parseJsonOutput(out.text);
      if (parsed.ok) {
        const check = validate(schema, parsed.value);
        if (check.ok) return check.value as Infer<S>;
        issues = check.issues;
      } else {
        issues = parsed.issues;
      }
      const said: AIMessage = out.message.raw || out.message.content.length ? out.message : { role: "assistant", content: out.text || "(empty reply)" };
      messages = [...messages, said, { role: "user", content: feedback(issues) }];
    }
    throw aiErrors.invalidOutput(issues, lastText);
  }

  async function embed(texts: string | string[], eo: { model?: string } = {}): Promise<number[][]> {
    const ep = opts.embeddings?.provider ?? p;
    if (!ep.embed || !ep.features.embed) {
      throw aiErrors.unsupported(
        ep.name,
        "embeddings",
        'Set an embeddings provider: ai({ provider, embeddings: { provider: workersAI() } }) or openaiCompatible({ baseUrl, embedModel: "text-embedding-3-small" }).',
      );
    }
    const model = eo.model ?? opts.embeddings?.model ?? ep.defaultEmbedModel;
    if (!model) throw aiErrors.config(`No embedding model set for the ${ep.name} provider`, "Pass ai({ embeddings: { model } }) or the provider's `embedModel` option.");
    const list = typeof texts === "string" ? [texts] : texts;
    if (!list.length) return [];
    const started = performance.now();
    const out = await ep.embed(list, model, it.runtime());
    scope.log.debug("ai.usage", { provider: ep.name, model, op: "embed", inputs: list.length, ms: Math.round(performance.now() - started) });
    return out;
  }

  return {
    generate,
    stream,
    object,
    embed,
    run: (o) => runLoop(it, o, scope.app),
    index: (o) => indexDocs((xs) => embed(xs), scope.env, o),
    rag: (o) => answer((xs) => embed(xs), generate, scope.env, o),
    inspect() {
      const info: Record<string, unknown> = { provider: p.name, model: opts.model ?? p.defaultModel ?? null, features: p.features, providerInfo: p.inspect() };
      if (opts.embeddings) info.embeddings = { provider: (opts.embeddings.provider ?? p).name, model: opts.embeddings.model ?? (opts.embeddings.provider ?? p).defaultEmbedModel ?? null };
      return info;
    },
  };
}

/**
 * An AI client outside a request: jobs, queue consumers, workflows, scripts. Reads keys from
 * `opts.env` (default: the process environment).
 */
export function createAI(opts: AIOptions): AIClient {
  return makeClient(opts, { env: opts.env ?? processEnv(), log: opts.log ?? createLogger("info", { battery: "ai" }) });
}
