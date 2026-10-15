// Operator view of @miujs/ai (rendered by @miujs/admin through `Plugin.manage()`): provider and
// model names, request / token / tool-call counters and errors, runtime defaults (model, max
// tokens, temperature) and a rate-limited test prompt. Keys, prompts and replies of app traffic
// are never shown; only the operator's own test prompt returns text.

import { createLogger, errors, t, type Context, type ManageSection, type ManageSettings, type Schema } from "miujs";
import { DEFAULT_MAX_TOKENS, makeClient, type AIOptions } from "./client.ts";
import type { AIMetrics } from "./metrics.ts";

/** Runtime overrides of the ai() defaults (`null`: use the configured default). */
export interface AISettings {
  model: string | null;
  maxTokens: number;
  temperature: number | null;
}

/** Test prompts allowed per minute (per process). */
export const TEST_PER_MINUTE = 5;
const REPLY_CHARS = 2_000;

export interface AIManageDeps {
  /** The configured options (no env / log). */
  base: Omit<AIOptions, "env" | "log">;
  /** The options with the operator's overrides applied. */
  effective(): Omit<AIOptions, "env" | "log">;
  overrides: { model?: string; maxTokens?: number; temperature?: number };
  metrics: AIMetrics;
}

export function aiManage(d: AIManageDeps): ManageSection[] {
  const recent: number[] = [];

  const settings: ManageSettings<AISettings> = {
    schema: t.object({
      model: t.nullable(t.string({ minLength: 1, maxLength: 200, description: "Default model; null for the configured default" })),
      maxTokens: t.integer({ min: 1, max: 1_000_000, description: "Default max_tokens for generate / object / run / rag" }),
      temperature: t.nullable(t.number({ min: 0, max: 2, description: "Default temperature; null for the provider's" })),
    }) as Schema<AISettings>,
    get() {
      const e = d.effective();
      return { model: e.model ?? e.provider.defaultModel ?? null, maxTokens: e.maxTokens ?? DEFAULT_MAX_TOKENS, temperature: e.temperature ?? null };
    },
    set(v) {
      for (const k of ["model", "maxTokens", "temperature"] as const) delete d.overrides[k];
      if (v.model !== null && v.model !== (d.base.model ?? d.base.provider.defaultModel)) d.overrides.model = v.model;
      if (v.maxTokens !== (d.base.maxTokens ?? DEFAULT_MAX_TOKENS)) d.overrides.maxTokens = v.maxTokens;
      if (v.temperature !== null) d.overrides.temperature = v.temperature;
    },
  };

  return [
    {
      id: "ai",
      title: "AI",
      description: "Provider, models, usage counters and a test prompt.",
      status() {
        const e = d.effective();
        const m = d.metrics;
        const scope = "Counted in this process (per isolate on Workers) since it started.";
        const emb = e.embeddings ? `${(e.embeddings.provider ?? e.provider).name} / ${e.embeddings.model ?? (e.embeddings.provider ?? e.provider).defaultEmbedModel ?? "?"}` : "none";
        return {
          stats: [
            { label: "Provider", value: e.provider.name },
            { label: "Model", value: e.model ?? e.provider.defaultModel ?? null },
            { label: "Embeddings", value: emb },
            { label: "Requests", value: m.requests, hint: `Completed model calls. ${scope}` },
            { label: "Input tokens", value: m.inputTokens },
            { label: "Output tokens", value: m.outputTokens },
            { label: "Tool calls", value: m.toolCalls, hint: m.toolErrors ? `${m.toolErrors} returned an error.` : undefined },
            { label: "Embedding calls", value: m.embedCalls },
            { label: "Errors", value: m.errors, tone: m.errors ? "warning" : undefined, hint: "Failed provider calls (after retries)." },
            { label: "Last error", value: m.lastError?.code ?? null, hint: m.lastError ? `At ${new Date(m.lastError.at).toISOString()}` : undefined },
          ],
          tables: [
            {
              title: "By model",
              columns: [
                { key: "model", label: "Model", type: "code" },
                { key: "requests", label: "Requests", type: "number" },
                { key: "inputTokens", label: "Input tokens", type: "number" },
                { key: "outputTokens", label: "Output tokens", type: "number" },
                { key: "errors", label: "Errors", type: "number" },
              ],
              rows: m.byModel().map((x) => ({ ...x })),
            },
          ],
        };
      },
      settings: settings as ManageSettings,
      actions: [
        {
          name: "testPrompt",
          title: "Send a test prompt",
          description: `Send a short prompt with the current settings and show the reply (at most ${TEST_PER_MINUTE} per minute).`,
          input: t.object({
            prompt: t.string({ minLength: 1, maxLength: 4_000 }),
            maxTokens: t.optional(t.integer({ min: 1, max: 1_024, description: "Default 256" })),
          }),
          async run(input: { prompt: string; maxTokens?: number }, ctx: Context) {
            const now = Date.now();
            while (recent.length && recent[0] <= now - 60_000) recent.shift();
            if (recent.length >= TEST_PER_MINUTE) {
              throw errors.custom({ code: "MIU_E_AI_TEST_RATE_LIMITED", status: 429, message: "Too many test prompts", fix: `Wait a minute; at most ${TEST_PER_MINUTE} test prompts per minute are allowed.` });
            }
            recent.push(now);
            const client = makeClient(d.effective(), { env: ctx.env ?? {}, log: ctx.log ?? createLogger("silent"), metrics: d.metrics });
            const out = await client.generate({ prompt: input.prompt, maxTokens: input.maxTokens ?? 256 });
            const text = out.text.length > REPLY_CHARS ? `${out.text.slice(0, REPLY_CHARS)}…` : out.text;
            return { text, model: out.model, usage: out.usage, stopReason: out.stopReason };
          },
        },
      ],
    },
  ];
}
