// Memory, handle and exit health of @miujs/web: static serving of many files and ranges (Bun and
// node:fs sources), cancelled downloads, CSP overrides, and the Vite dev proxy.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miu, route } from "miujs";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { openHandles } from "../../../scripts/lib/leak.ts";
import { bunFileSource, nodeFileSource, secureHeaders, staticFiles, vite, type FileSource } from "../src/index.ts";

const PKG = join(import.meta.dir, "..");
const FILES = 200;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "miu-web-health-"));
  mkdirSync(join(dir, "assets"));
  const big = new Uint8Array(512 * 1024).map((_, i) => i & 0xff);
  for (let i = 0; i < FILES; i++) writeFileSync(join(dir, "assets", `f${i}.txt`), `file ${i} `.repeat(200));
  writeFileSync(join(dir, "big.bin"), big);
  writeFileSync(join(dir, "big.bin.gz"), Bun.gzipSync(big));
  writeFileSync(join(dir, "index.html"), "<!doctype html><p>hi</p>");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const appFor = (source: FileSource) => miu({ logLevel: "silent", dev: false, plugins: [staticFiles({ dir, source })] });
const get = (app: ReturnType<typeof appFor>, path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://x.test${path}`, { headers }));

const sources: [string, () => FileSource][] = [
  ["bun", bunFileSource],
  ["node:fs", nodeFileSource],
];

describe.each(sources)("static files (%s source)", (_, make) => {
  test("serving many files does not leak (nothing is cached per file)", async () => {
    const app = appFor(make());
    const r = await leakCheck("static many files", async (i) => {
      const res = await get(app, `/assets/f${i % FILES}.txt`);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }, { perRound: 2000, rounds: 6, warmup: 1000 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("ranges, 304s and precompressed variants do not leak", async () => {
    const app = appFor(make());
    const etag = (await get(app, "/big.bin")).headers.get("etag")!;
    const r = await leakCheck("static ranges", async (i) => {
      const kind = i % 3;
      const res =
        kind === 0
          ? await get(app, "/big.bin", { range: `bytes=${i % 1000}-${(i % 1000) + 4095}` })
          : kind === 1
            ? await get(app, "/big.bin", { "if-none-match": etag })
            : await get(app, "/big.bin", { "accept-encoding": "gzip" });
      await res.arrayBuffer();
    }, { perRound: 1500, rounds: 6, warmup: 500 });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("downloads cancelled after the first chunk close their files", async () => {
    const app = appFor(make());
    const cancelled = async () => {
      const res = await get(app, "/big.bin");
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
    };
    for (let i = 0; i < 20; i++) await cancelled();
    const before = openHandles();
    if (before === null) return;
    for (let i = 0; i < 300; i++) await cancelled();
    await Bun.sleep(50);
    expect(openHandles()! - before).toBeLessThan(50);
  }, 60_000);
});

test("per-request frameAncestors overrides stay bounded", async () => {
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [secureHeaders({ csp: true })],
    routes: [
      route.get("/embed/:n", {
        handler: (ctx) => {
          ctx.state.frameAncestors = [`https://site${ctx.params.n}.example.com`];
          return "ok";
        },
      }),
    ],
  });
  const r = await leakCheck("unique frameAncestors", async (i) => void (await (await app.fetch(new Request(`http://x.test/embed/${i}`))).arrayBuffer()), {
    perRound: 3000,
    rounds: 14,
    warmup: 2000,
  });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 120_000);

describe("vite dev proxy", () => {
  let dev: ReturnType<typeof Bun.serve>;
  const live = { open: 0 };
  beforeAll(() => {
    dev = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/stream") {
          live.open++;
          let done = false;
          const close = () => {
            if (!done) live.open--;
            done = true;
          };
          req.signal.addEventListener("abort", close);
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("first"));
              },
              pull: () => new Promise(() => {}),
              cancel: close,
            }),
          );
        }
        if (u.pathname === "/hang") {
          live.open++;
          req.signal.addEventListener("abort", () => live.open--);
          return new Promise<Response>(() => {});
        }
        return new Response("export const x = 1;", { headers: { "content-type": "text/javascript" } });
      },
    });
  });
  afterAll(() => dev.stop(true));
  const devApp = () => miu({ logLevel: "silent", dev: true, plugins: [vite({ dev: `http://127.0.0.1:${dev.port}` })] });
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
    return cond();
  };

  test("many proxied module requests do not leak", async () => {
    const app = devApp();
    await app.ready();
    const r = await leakCheck("vite proxy", async () => void (await (await app.fetch(new Request("http://x.test/src/main.ts"))).arrayBuffer()), {
      perRound: 1500,
      rounds: 6,
      warmup: 1000,
      maxObjectsPerIteration: 0.1,
    });
    if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("a cancelled streamed response closes the request to Vite", async () => {
    const app = devApp();
    await app.ready();
    const res = await app.fetch(new Request("http://x.test/stream"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(await waitFor(() => live.open === 0)).toBe(true);
  });

  test("a client that leaves before Vite answers aborts the request to Vite", async () => {
    const app = devApp();
    await app.ready();
    const ctrl = new AbortController();
    const p = Promise.resolve(app.fetch(new Request("http://x.test/hang", { signal: ctrl.signal }))).catch(() => null);
    await waitFor(() => live.open === 1);
    ctrl.abort();
    await p;
    expect(await waitFor(() => live.open === 0)).toBe(true);
  });
});

test("an app serving static files exits after listen + stop", async () => {
  const r = await exitCheck(`
    import { miu } from "miujs";
    import { staticFiles, secureHeaders } from "../src/index.ts";
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const dir = mkdtempSync(join(tmpdir(), "miu-web-exit-"));
    writeFileSync(join(dir, "a.txt"), "x".repeat(300000));
    const app = miu({ logLevel: "silent", plugins: [secureHeaders({ csp: true }), staticFiles({ dir })] });
    await app.ready();
    await (await app.fetch(new Request("http://x/a.txt"))).text();
    const s = await app.listen(0, "127.0.0.1");
    const res = await fetch(new URL("/a.txt", s.url));
    await res.body.cancel();
    await (await fetch(new URL("/a.txt", s.url), { headers: { range: "bytes=0-9" } })).text();
    await s.stop(true);
    rmSync(dir, { recursive: true, force: true });
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
