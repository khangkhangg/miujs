// Retrieval-augmented generation: embed the question, fetch the nearest chunks, answer from them.

import type { Env } from "miujs";
import type { GenerateOptions } from "./client.ts";
import type { GenerateResult, Usage } from "./types.ts";
import { DEFAULT_TOP_K, type VectorStore } from "./vectors.ts";

export interface RagDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface IndexOptions {
  store: VectorStore;
  docs: RagDoc[];
}

export interface RagOptions extends Omit<GenerateOptions, "prompt" | "messages" | "tools"> {
  query: string;
  store: VectorStore;
  /** Chunks to retrieve. Default 4. */
  topK?: number;
  filter?: Record<string, unknown>;
}

export interface RagSource {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RagResult {
  answer: string;
  sources: RagSource[];
  usage: Usage;
}

export const RAG_SYSTEM =
  "Answer the question using only the numbered sources provided. Cite sources inline as [n]. " +
  "If the sources do not contain the answer, say you don't know.";

export function storeFor(store: VectorStore, env: Env): VectorStore {
  return store.forEnv ? store.forEnv(env) : store;
}

/** Embeds `docs` and stores them, keeping each doc's text in `metadata.text`. */
export async function indexDocs(embed: (texts: string[]) => Promise<number[][]>, env: Env, o: IndexOptions): Promise<void> {
  if (!o.docs.length) return;
  const vectors = await embed(o.docs.map((d) => d.text));
  await storeFor(o.store, env).upsert(o.docs.map((d, i) => ({ id: d.id, values: vectors[i], metadata: { ...d.metadata, text: d.text } })));
}

export async function answer(
  embed: (texts: string[]) => Promise<number[][]>,
  generate: (o: GenerateOptions) => Promise<GenerateResult>,
  env: Env,
  o: RagOptions,
): Promise<RagResult> {
  const { query, store, topK = DEFAULT_TOP_K, filter, system, ...gen } = o;
  const [vector] = await embed([query]);
  const matches = await storeFor(store, env).query(vector, { topK, ...(filter ? { filter } : {}) });
  const sources: RagSource[] = matches.map((m) => ({
    id: m.id,
    score: m.score,
    text: typeof m.metadata?.text === "string" ? m.metadata.text : "",
    ...(m.metadata ? { metadata: m.metadata } : {}),
  }));
  // Sources go in the user turn so the system prompt stays stable (and cacheable).
  const context = sources.length ? sources.map((s, i) => `[${i + 1}] ${s.text}`).join("\n\n") : "(no sources found)";
  const prompt = `Sources:\n\n${context}\n\nQuestion: ${query}`;
  const out = await generate({ ...gen, system: system ?? RAG_SYSTEM, prompt });
  return { answer: out.text, sources, usage: out.usage };
}
