// Memory, hang and exit health of @miujs/migrate: many proxied requests, aborted and timed-out ones,
// streaming bodies both ways, and contract capture next to the proxy.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { captureMiddleware, jsonlFileSink, memorySink, migrateProxy } from "../src/index.ts";

const PKG = join(import.meta.dir, "..");
const enc = new TextEncoder();

// The fake old app. `open` counts upstream requests whose connection is still open.
let upstream: ReturnType<typeof Bun.serve>;
let base: string;
const live = { open: 0, rssAtUploadEnd: 0 };

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/echo") return Response.json({ ok: true, path: url.pathname });
      if (url.pathname === "/stream" || url.pathname === "/hang") {
        live.open++;
        let done = false;
        const close = () => {
          if (!done) live.open--;
          done = true;
        };
        req.signal.addEventListener("abort", close);
        if (url.pathname === "/hang") return new Promise<Response>(() => {});
        let timer: ReturnType<typeof setInterval>;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode("data: hello\n\n"));
              timer = setInterval(() => {
                try {
                  c.enqueue(enc.encode("data: tick\n\n"));
                } catch {
                  clearInterval(timer);
                }
              }, 5);
            },
            cancel() {
              clearInterval(timer);
              close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/upload") {
        let n = 0;
        for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) n += chunk.byteLength;
        Bun.gc(true);
        live.rssAtUploadEnd = process.memoryUsage.rss();
        return Response.json({ received: n });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${upstream.port}`;
});
afterAll(() => upstream.stop(true));

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

const proxyApp = (extra: Parameters<typeof migrateProxy>[0] extends infer O ? Partial<O> : never = {}, plugins: unknown[] = []) =>
  miu({ logLevel: "silent", dev: false, plugins: [...(plugins as never[]), migrateProxy({ upstream: base, ...extra })] });

describe("proxy", () => {
  test("many proxied requests do not leak", async () => {
    const app = proxyApp();
    const r = await leakCheck("proxy GET", async () => {
      const res = await app.fetch(new Request("http://app.test/echo"));
      await res.arrayBuffer();
    }, { perRound: 1500, rounds: 6, warmup: 1000, maxObjectsPerIteration: 0.1 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("a client that cancels a streamed response closes the upstream request", async () => {
    const app = proxyApp();
    for (let i = 0; i < 20; i++) {
      const res = await app.fetch(new Request("http://app.test/stream"));
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
    }
    expect(await waitFor(() => live.open === 0)).toBe(true);
  });

  test("a client that disconnects before the upstream answers aborts the upstream request", async () => {
    const app = proxyApp();
    const ctrl = new AbortController();
    const p = app.fetch(new Request("http://app.test/hang", { signal: ctrl.signal }));
    await waitFor(() => live.open === 1);
    ctrl.abort();
    const res: unknown = await Promise.resolve(p).catch((e: unknown) => e);
    if (res instanceof Response) await res.arrayBuffer();
    expect(await waitFor(() => live.open === 0)).toBe(true);
  });

  test("upstream timeouts answer 504 and close the upstream request", async () => {
    const app = proxyApp({ timeout: 30 });
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(new Request("http://app.test/hang"));
      expect(res.status).toBe(504);
      await res.arrayBuffer();
    }
    expect(await waitFor(() => live.open === 0)).toBe(true);
  });

  test("large request bodies stream through (capture on) instead of being buffered", async () => {
    const app = proxyApp({}, [captureMiddleware({ sink: memorySink() })]);
    const total = 96 * 1024 * 1024;
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) return c.close();
        sent += chunk.byteLength;
        c.enqueue(chunk.slice());
      },
    });
    Bun.gc(true);
    const before = process.memoryUsage.rss();
    const res = await app.fetch(new Request("http://app.test/upload", { method: "POST", body, duplex: "half" } as RequestInit));
    expect(((await res.json()) as { received: number }).received).toBe(total);
    await app.drain();
    // Buffering the whole body would add ~96 MiB.
    expect(live.rssAtUploadEnd - before).toBeLessThan(48 * 1024 * 1024);
  }, 60_000);
});

describe("capture", () => {
  test("capturing a never-ending streamed response does not hold the request open", async () => {
    const sink = memorySink();
    const app = proxyApp({}, [captureMiddleware({ sink })]);
    const res = await app.fetch(new Request("http://app.test/stream"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const drained = await Promise.race([app.drain().then(() => true), Bun.sleep(1000).then(() => false)]);
    expect(drained).toBe(true);
    expect(await waitFor(() => live.open === 0)).toBe(true);
    expect(sink.entries.length).toBe(1);
  });

  test("many captured requests do not leak (bounded sink)", async () => {
    let lines = 0;
    const app = proxyApp({}, [captureMiddleware({ sink: () => void lines++ })]);
    const r = await leakCheck("capture + proxy", async () => {
      const res = await app.fetch(new Request("http://app.test/echo?x=1", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } }));
      await res.arrayBuffer();
      await app.drain();
    }, { perRound: 1500, rounds: 6, warmup: 1000, maxObjectsPerIteration: 0.1 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(lines).toBeGreaterThan(9000);
  }, 120_000);

  test("one failed write does not stop the JSONL file sink", async () => {
    const dir = join(PKG, `.tmp-sink-${process.pid}`);
    const { mkdirSync, rmSync, readFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    try {
      const file = join(dir, "missing-dir", "cases.jsonl");
      const sink = jsonlFileSink(file) as (line: string) => Promise<void>;
      await expect(sink("first")).rejects.toThrow();
      mkdirSync(join(dir, "missing-dir"));
      await sink("second");
      expect(readFileSync(file, "utf8")).toBe("second\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("an app using the proxy exits after listen + stop and an upstream timeout", async () => {
  const r = await exitCheck(`
    import { miu } from "miujs";
    import { migrateProxy, captureMiddleware, memorySink } from "../src/index.ts";
    const old = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === "/hang" ? new Promise(() => {}) : new Response("old") });
    const app = miu({ logLevel: "silent", plugins: [captureMiddleware({ sink: memorySink() }), migrateProxy({ upstream: "http://127.0.0.1:" + old.port, timeout: 50 })] });
    await app.ready();
    const s = await app.listen(0, "127.0.0.1");
    await (await fetch(new URL("/x", s.url))).text();
    await (await fetch(new URL("/hang", s.url))).text();
    await app.drain();
    await s.stop(true);
    old.stop(true);
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
