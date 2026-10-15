// Memory and exit health: detection and the bot cache stay bounded under a flood of distinct
// paths and user agents, and a process using bots() exits on its own.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { miu, route } from "miujs";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { bots, memoryBotStore } from "../src/index.ts";
import { BROWSER_HEADERS } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");
const report = (r: Parameters<typeof describeLeak>[0]) => process.env.LEAK_REPORT && console.log(describeLeak(r));

test("detection and cached serving over many distinct paths and user agents plateau", async () => {
  let now = 1_700_000_000_000;
  const store = memoryBotStore({ maxEntries: 500, maxBytes: 1024 * 1024, now: () => now });
  const plugin = bots({ now: () => now, cache: { store, ttl: 5, staleWhileRevalidate: 5 } });
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [plugin],
    routes: [route.get("/p/:id", { handler: (ctx) => ({ id: ctx.params.id, kind: ctx.visitor.kind, pad: "x".repeat(200) }) })],
  });
  await app.ready();
  const r = await leakCheck(
    "bots app",
    async (i) => {
      now += 100;
      // Distinct paths (misses), repeats (hits, stale + background refresh), distinct UAs, humans.
      const path = i % 3 === 0 ? `/p/${i}` : `/p/${i % 50}`;
      const headers = i % 5 === 0 ? BROWSER_HEADERS : { "user-agent": i % 2 ? `curl/${i}` : "Mozilla/5.0 (compatible; GPTBot/1.2)" };
      const res = await app.fetch(new Request(`https://example.com${path}?utm_source=${i}`, { headers }));
      await res.arrayBuffer();
      await app.drain();
    },
    { perRound: 3000, rounds: 5, warmup: 3000 },
  );
  report(r);
  expect(r.leaking, describeLeak(r)).toBe(false);
  const info = plugin.inspect() as any;
  expect(info.cache.entries).toBeLessThanOrEqual(500);
  expect(info.agents.memo).toBeLessThanOrEqual(1000);
  expect(info.counters.cache.hit + info.counters.cache.stale).toBeGreaterThan(0);
}, 120_000);

test("an app using bots() exits after work, and after listen + stop", async () => {
  const r = await exitCheck(
    `
    import { miu, route } from "miujs";
    import { bots } from "../src/index.ts";
    let now = Date.now();
    const app = miu({ logLevel: "silent", plugins: [bots({ now: () => now, cache: { ttl: 1, staleWhileRevalidate: 60 }, robots: true })],
      routes: [route.get("/", { handler: () => ({ ok: true }) })] });
    const bot = { headers: { "user-agent": "curl/8" } };
    await (await app.fetch(new Request("http://x/", bot))).text();
    await (await app.fetch(new Request("http://x/", bot))).text();
    now += 5000;
    await (await app.fetch(new Request("http://x/", bot))).text();
    await app.drain();
    const s = await app.listen(0, "127.0.0.1");
    await (await fetch(s.url, bot)).text();
    await (await fetch(s.url + "robots.txt")).text();
    await s.stop();
  `,
    5000,
    PKG,
  );
  expect(r.exited, r.stderr).toBe(true);
  expect(r.code, r.stderr).toBe(0);
}, 15_000);
