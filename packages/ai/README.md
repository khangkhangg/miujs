# @miujs/ai

> Model calls for MiuJS: `ctx.ai` for generate, stream, typed objects, embeddings, a tool-use agent loop and RAG, over Anthropic, OpenAI-compatible APIs, Workers AI and Cloudflare AI Gateway.

`@miujs/ai` adds `ctx.ai` to every request through the `ai()` plugin, and `createAI()` gives the same client to jobs, workflows and scripts. Providers are plain `fetch` (or the Workers AI binding), so it runs on every MiuJS runtime. `appTools(app)` hands the app's own routes to the model as tools, with the caller's auth applied. Use it when routes need an LLM: chat endpoints, extraction into `t` schemas, agents, or question answering over your documents.

## Install

```bash
bun add @miujs/ai miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { ai, anthropic } from "@miujs/ai";

export const summarize = route.post("/summarize", {
  body: t.object({ text: t.string() }),
  handler: async ({ ai, body }) => {
    const out = await ai.generate({ system: "Summarize in one sentence.", prompt: body.text });
    return { summary: out.text, usage: out.usage };
  },
});

// Reads ANTHROPIC_API_KEY from the request env (process env locally, secrets on Workers).
export default miu({ routes: [summarize], plugins: [ai({ provider: anthropic() })] });
```

`generate()` returns `{ text, toolCalls, usage, stopReason, model, message }`. Append `message` to `messages` for a follow-up turn.

## Typed output

<!-- test -->
```ts
import { t } from "miujs";
import { anthropic, createAI } from "@miujs/ai";

const client = createAI({ provider: anthropic(), env: { ANTHROPIC_API_KEY: "sk-ant-..." } });

const Person = t.object({ name: t.string({ minLength: 2 }), age: t.integer({ min: 0 }), tags: t.optional(t.array(t.string())) });
const person = await client.object({ schema: Person, prompt: "Ada Lovelace, 36" });
console.log(person.name, person.age); // typed as Infer<typeof Person>
```

`object()` uses the provider's structured-output mode, validates the reply with the schema, and retries once with the validation issues. A second failure throws `MIU_E_AI_INVALID_OUTPUT`.

## Streaming

<!-- test -->
```ts
import { route, t } from "miujs";
import { toSSE } from "@miujs/ai";

export const chat = route.post("/chat", {
  body: t.object({ q: t.string() }),
  handler: ({ ai, body }) => toSSE(ai.stream({ prompt: body.q })),
});
```

`stream()` yields `{ type: "text" }`, `{ type: "tool_call" }` and a final `{ type: "finish", stopReason, usage, model, message }`. `toSSE()` sends each as a server-sent event named after its type, and an `error` event with the MiuError JSON if the stream fails.

## Tools and agents

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { ai, anthropic, appTools, tool } from "@miujs/ai";

const add = tool({
  name: "add",
  description: "Add two numbers",
  input: t.object({ a: t.number(), b: t.number() }),
  run: ({ a, b }) => ({ sum: a + b }),
});

export const listNotes = route.get("/notes", { summary: "List notes", handler: () => [{ id: "n1", text: "hi" }] });

export const agent = route.post("/agent", {
  body: t.object({ prompt: t.string() }),
  handler: async ({ ai, body }) => {
    const out = await ai.run({
      prompt: body.prompt,
      tools: [add, appTools({ include: ["listNotes"] })],
      maxSteps: 5,
      limits: { totalTokens: 50_000, timeMs: 30_000 },
    });
    return { text: out.text, stopReason: out.stopReason, calls: out.toolCalls.map((c) => c.name) };
  },
});

export default miu({ routes: [listNotes, agent], plugins: [ai({ provider: anthropic() })] });
```

`run()` calls the model, runs the tools it asks for (in parallel), feeds the results back, and stops when the model answers or a limit is hit (`stopReason` is then `max_steps`, `token_limit` or `time_limit`). Tool arguments are validated against `input`; errors, including thrown `ToolError`s and `MiuError`s, go back to the model as error results instead of failing the run. `appTools()` uses `app.tools()`: the same tools MCP serves, dispatched through the app with the current request's `authorization`, `cookie` and `x-request-id` headers. Outside a request, pass the app and headers: `appTools(app, { headers: { authorization } })`.

## Embeddings and RAG

<!-- test -->
```ts
import { anthropic, createAI, memoryVectors, openaiCompatible } from "@miujs/ai";

const client = createAI({
  provider: anthropic(),
  embeddings: { provider: openaiCompatible({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }), model: "text-embedding-3-small" },
});

const store = memoryVectors();
await client.index({ store, docs: [{ id: "cats", text: "Cats sleep 16 hours a day.", metadata: { source: "cats.md" } }] });

const { answer, sources } = await client.rag({ query: "How much do cats sleep?", store, topK: 1 });
console.log(answer, sources.map((s) => s.id));
```

Vector stores: `memoryVectors()` (in-process), `sqliteVectors(db, { table })` (float32 blobs in SQLite/D1, default table `miu_vectors`, brute-force cosine for small sets), `vectorize(binding, { indexName })` (Cloudflare Vectorize). `rag()` answers with `RAG_SYSTEM` unless you pass `system`, and cites sources as `[n]`.

## Providers

- `anthropic({ apiKey, apiKeyEnv, baseUrl, fallbacks, headers })`: Claude Messages API. Default model `ANTHROPIC_DEFAULT_MODEL` (`claude-opus-5-5`). Supports prompt caching (`cache: true | "5m" | "1h"`). No embeddings.
- `openaiCompatible({ baseUrl, apiKey, apiKeyEnv, model, embedModel, structured, name, gatewaySlug, headers })`: any `/chat/completions` API (OpenAI, OpenRouter, Groq, Together, vLLM, Ollama, LM Studio). Has embeddings.
- `workersAI(binding = "AI", { model, embedModel })`: Workers AI through `env.AI`. Defaults `WORKERS_AI_DEFAULT_MODEL` and `WORKERS_AI_DEFAULT_EMBED_MODEL`.
- `aiGateway({ accountId, gatewayId, token }, provider)`: routes one of the above through Cloudflare AI Gateway.

## Options

`ai(options)` and `createAI(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `Provider` | required | `anthropic()`, `openaiCompatible()`, `workersAI()` or `aiGateway(...)`. |
| `model` | `string` | the provider's default | Default model for every call. |
| `embeddings` | `{ provider?, model? }` | the main provider | Separate provider/model for `embed()`, `index()` and `rag()`. |
| `maxTokens` | `number` | `16000` (`64000` for `stream`) | Default `max_tokens`. |
| `timeoutMs` | `number` | `120000` | Request timeout (for streams: until headers arrive). |
| `retries` | `number` | `2` | Retries on 429, 5xx and network errors, honoring `retry-after`. |
| `fetch` | `typeof fetch` | global `fetch` | Injected fetch (tests, proxies). |
| `env` | `Env` | process env | `createAI` only: where API keys and bindings are read. |
| `log` | `Logger` | a `createLogger("info")` | `createAI` only: usage is logged at debug level. |
| `stores` | `VectorStore[]` | `[]` | `ai()` only: stores whose bindings `miu deploy cloudflare` should declare. |

Per-call options for `generate` / `stream` / `object`: `system`, `prompt`, `messages`, `model`, `maxTokens`, `temperature`, `tools`, `cache`, `signal`, `extra`. `run` adds `tools` (required), `maxSteps` (default 10) and `limits: { totalTokens, timeMs }`. `rag` takes `query`, `store`, `topK` (default 4) and `filter`.

## Errors

- `MIU_E_AI_MISSING_KEY`: the provider's API key env var is not set ([docs](../../docs/errors.md#miu_e_ai_missing_key)).
- `MIU_E_AI_AUTH`: the provider rejected the key.
- `MIU_E_AI_RATE_LIMITED`: still rate limited after retries.
- `MIU_E_AI_BAD_REQUEST`: the provider rejected the request (model id, options).
- `MIU_E_AI_PROVIDER_ERROR`: the provider failed (5xx, network) after retries.
- `MIU_E_AI_TIMEOUT`: no answer within `timeoutMs`.
- `MIU_E_AI_INVALID_OUTPUT`: `object()` could not get JSON matching the schema.
- `MIU_E_AI_REFUSED`: the model declined the request.
- `MIU_E_AI_UNSUPPORTED`: the provider lacks a feature (for example embeddings on `anthropic()`).
- `MIU_E_AI_BINDING`: a Workers AI or Vectorize binding is missing from `env`.
- `MIU_E_AI_CONFIG`: invalid options (no model, no input, bad tool name).

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

Keys are read from the request `env` per call, so set them with `wrangler secret put ANTHROPIC_API_KEY`. `workersAI()` uses the `AI` binding by default and declares `[ai] binding = "AI"` through the plugin's `cloudflare()` (also when it is only the embeddings provider). `vectorize("DOCS", { indexName: "docs" })` listed in `ai({ stores })` declares a `[[vectorize]]` binding; without `indexName`, add it to `wrangler.toml` yourself. `miu deploy cloudflare` writes both. Workers AI and Vectorize exist only on Cloudflare; locally use `anthropic()` or `openaiCompatible()` with `memoryVectors()` or `sqliteVectors(db)`. `sqliteVectors(d1("DB"))` from `@miujs/db` resolves the D1 binding per request.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [miujs](../miujs/README.md), [@miujs/db](../db/README.md), [@miujs/queue](../queue/README.md), [@miujs/workflows](../workflows/README.md)
