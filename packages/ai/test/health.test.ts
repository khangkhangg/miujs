// Memory, cancellation and exit health of @miujs/ai: SSE streams cancelled mid-way must release the
// provider connection, retries must stop on abort, and nothing may keep the process alive.
import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { ai, anthropic, createAI, toSSE } from "../src/index.ts";
import { send } from "../src/http.ts";
import { runtime } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");
const enc = new TextEncoder();
const frame = (type: string, data: unknown) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);

/** A provider that sends one text delta, then keeps the stream open until it is cancelled. */
function stalledProvider() {
  const stats = { opened: 0, cancelled: 0, aborted: 0 };
  const fetchFn = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    stats.opened++;
    init?.signal?.addEventListener("abort", () => stats.aborted++);
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frame("message_start", { message: { model: "m", usage: { input_tokens: 1, output_tokens: 0 } } }));
        c.enqueue(frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } }));
        // A real connection errors its body when the request is aborted.
        init?.signal?.addEventListener("abort", () => {
          if (!closed) c.error(init.signal!.reason);
          closed = true;
        });
      },
      pull() {
        return new Promise(() => {}); // the model is "thinking" forever
      },
      cancel() {
        closed = true;
        stats.cancelled++;
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { stats, fetch: fetchFn };
}

function chatApp(fetchFn: typeof fetch) {
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [ai({ provider: anthropic({ apiKey: "sk-test" }), model: "m", fetch: fetchFn })],
    routes: [route.get("/chat", { handler: ({ ai }) => toSSE(ai.stream({ prompt: "hi" })) })],
  });
  return app;
}

async function readFirstChunkThenCancel(app: ReturnType<typeof chatApp>) {
  const res = await app.fetch(new Request("http://x.test/chat"));
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("Hel");
  await reader.cancel();
}

describe("cancelled SSE streams", () => {
  test("cancelling the response releases the provider connection", async () => {
    const p = stalledProvider();
    const app = chatApp(p.fetch);
    await readFirstChunkThenCancel(app);
    await Bun.sleep(20);
    expect(p.stats.opened).toBe(1);
    // Either the upstream body was cancelled or its request aborted: the socket is released.
    expect(p.stats.cancelled + p.stats.aborted).toBeGreaterThanOrEqual(1);
  });

  test("an aborted client request aborts the provider call", async () => {
    const p = stalledProvider();
    const app = chatApp(p.fetch);
    const ctrl = new AbortController();
    const res = await app.fetch(new Request("http://x.test/chat", { signal: ctrl.signal }));
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await Bun.sleep(20);
    expect(p.stats.aborted + p.stats.cancelled).toBeGreaterThanOrEqual(1);
    await reader.cancel().catch(() => {});
  });

  test("many cancelled streams do not leak", async () => {
    const p = stalledProvider();
    const app = chatApp(p.fetch);
    const r = await leakCheck("cancelled SSE", () => readFirstChunkThenCancel(app), { perRound: 2000, rounds: 6, warmup: 1000 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(p.stats.cancelled + p.stats.aborted).toBeGreaterThanOrEqual(p.stats.opened);
  }, 120_000);

  test("a stream the consumer stops early (break) releases the provider connection", async () => {
    const p = stalledProvider();
    const client = createAI({ provider: anthropic({ apiKey: "sk-test" }), model: "m", fetch: p.fetch, env: {} });
    for await (const ev of client.stream({ prompt: "hi" })) {
      expect(ev.type).toBe("text");
      break;
    }
    expect(p.stats.cancelled + p.stats.aborted).toBeGreaterThanOrEqual(1);
  });
});

describe("retries", () => {
  test("an abort during the retry back-off stops at once and sends no further request", async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const rt = runtime({
      retries: 3,
      fetch: (async () => {
        calls++;
        return new Response("busy", { status: 503 });
      }) as unknown as typeof fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const t0 = performance.now();
    const p = send(rt, "test", "http://x.test", { method: "POST", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new DOMException("client left", "AbortError")), 20);
    await expect(p).rejects.toThrow();
    expect(performance.now() - t0).toBeLessThan(400);
    expect(calls).toBe(1);
  });
});

test("an app using ai() exits after a cancelled stream", async () => {
  // A provider that sends one delta and then stalls until its request is aborted.
  const r = await exitCheck(`
    import { miu, route } from "miujs";
    import { ai, anthropic, toSSE } from "../src/index.ts";
    const ev = (type, data) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";
    const first = ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } });
    const fetchFn = async (_u, init) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(first));
        init?.signal?.addEventListener("abort", () => c.error(init.signal.reason));
      },
      pull: () => new Promise(() => {}),
    }), { headers: { "content-type": "text/event-stream" } });
    const app = miu({ logLevel: "silent", plugins: [ai({ provider: anthropic({ apiKey: "k" }), model: "m", fetch: fetchFn, retries: 0 })],
      routes: [route.get("/chat", { handler: ({ ai }) => toSSE(ai.stream({ prompt: "hi" })) })] });
    await app.ready();
    const s = await app.listen(0, "127.0.0.1");
    const res = await fetch(new URL("/chat", s.url));
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await s.stop(true);
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
