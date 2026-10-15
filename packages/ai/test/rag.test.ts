import { describe, expect, test } from "bun:test";
import { miu, route, t } from "miujs";
import { ai, anthropic, createAI, openaiCompatible } from "../src/index.ts";
import { memoryVectors, vectorize } from "../src/vectors.ts";
import { fakeFetch, json, type Recorded } from "./helpers.ts";

/** Embeds "cats…" near [1,0] and everything else near [0,1]; answers with a fixed Claude reply. */
const server = () =>
  fakeFetch((r: Recorded) => {
    if (r.url.endsWith("/embeddings")) {
      return json({ data: (r.body.input as string[]).map((s, index) => ({ index, embedding: /cat/i.test(s) ? [1, 0.05] : [0.05, 1] })) });
    }
    return json({ model: "claude-opus-5-5", content: [{ type: "text", text: "Cats sleep a lot [1]." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });

const opts = (f: typeof fetch) => ({
  provider: anthropic(),
  embeddings: { provider: openaiCompatible({ baseUrl: "https://emb.test/v1" }), model: "e" },
  fetch: f,
});

const docs = [
  { id: "cats", text: "Cats sleep 16 hours a day.", metadata: { source: "cats.md" } },
  { id: "dogs", text: "Dogs need daily walks.", metadata: { source: "dogs.md" } },
];

describe("ai.index() and ai.rag()", () => {
  test("indexes documents with their text, then answers from the nearest ones", async () => {
    const f = server();
    const client = createAI({ ...opts(f), env: { ANTHROPIC_API_KEY: "k" } });
    const store = memoryVectors();
    await client.index({ store, docs });
    expect(f.calls[0].body.input).toEqual(["Cats sleep 16 hours a day.", "Dogs need daily walks."]);

    const out = await client.rag({ query: "How much do cats sleep?", store, topK: 1 });
    expect(out.answer).toBe("Cats sleep a lot [1].");
    expect(out.sources).toEqual([{ id: "cats", score: expect.any(Number), text: "Cats sleep 16 hours a day.", metadata: { source: "cats.md", text: "Cats sleep 16 hours a day." } }]);
    const gen = f.calls.at(-1)!.body;
    const user = gen.messages.at(-1).content as string;
    expect(user).toContain("[1] Cats sleep 16 hours a day.");
    expect(user).not.toContain("Dogs");
    expect(user).toContain("How much do cats sleep?");
    expect(gen.system).toContain("sources");
  });

  test("resolves env-bound stores (Vectorize) from the request env", async () => {
    const f = server();
    const queried: unknown[] = [];
    const VEC = {
      upsert: async () => ({}),
      deleteByIds: async () => ({}),
      query: async (v: number[]) => (queried.push(v), { matches: [{ id: "cats", score: 0.99, metadata: { text: "Cats sleep 16 hours a day." } }] }),
    };
    const ask = route.post("/ask", {
      body: t.object({ q: t.string() }),
      handler: async ({ ai, body }) => {
        const out = await ai.rag({ query: body.q, store: vectorize("VEC") });
        return { answer: out.answer, ids: out.sources.map((s) => s.id) };
      },
    });
    const app = miu({ routes: [ask], plugins: [ai(opts(f))], logLevel: "silent" });
    const res = await app.dispatch(
      new Request("http://localhost/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "cats?" }) }),
      { ANTHROPIC_API_KEY: "k", VEC },
      { runtime: "workerd" },
    );
    expect(await res.json()).toEqual({ answer: "Cats sleep a lot [1].", ids: ["cats"] });
    expect(queried[0]).toEqual([1, 0.05]);
  });
});
