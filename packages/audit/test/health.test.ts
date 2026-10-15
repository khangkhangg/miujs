// Memory and exit health of @miujs/audit: many single and bulk appends (keyed chain) on sqlite and
// through the plugin; the append queue must not grow and nothing may keep the process alive.
import { expect, test } from "bun:test";
import { miu, route } from "miujs";
import { sqlite } from "@miujs/db";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { audit, dbAuditStore, verifyChain } from "../src/index.ts";

const PKG = join(import.meta.dir, "..");
const KEY = "k".repeat(40);

test("single appends on a keyed sqlite chain do not leak", async () => {
  const store = dbAuditStore(sqlite(), { key: KEY });
  const r = await leakCheck("audit append", (i) => store.append({ ts: Date.now(), action: "update", resource: "contacts", resourceId: String(i % 50), metadata: { n: i } }), {
    perRound: 2000,
    rounds: 6,
    warmup: 1000,
  });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
  expect((await verifyChain(store, { keys: KEY })).ok).toBe(true);
}, 120_000);

test("bulk appends do not leak", async () => {
  const store = dbAuditStore(sqlite(), { key: KEY });
  const batch = Array.from({ length: 10 }, (_, i) => ({ ts: Date.now(), action: "import", resource: "rows", resourceId: String(i) }));
  const r = await leakCheck("audit appendMany", () => store.appendMany!(batch), // Thresholds are per row (10 rows per iteration), like the single-append test.
  { perRound: 500, rounds: 6, warmup: 300, maxBytesPerIteration: 640, maxObjectsPerIteration: 0.5 });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 120_000);

test("concurrent appends drain the queue (no growth while waiting)", async () => {
  const store = dbAuditStore(sqlite(), { key: KEY });
  const r = await leakCheck("audit concurrent", () => Promise.all(Array.from({ length: 20 }, (_, i) => store.append({ ts: Date.now(), action: "a", resource: "r", resourceId: String(i) }))), // Per-row thresholds: 20 appends per iteration.
  {
    perRound: 200,
    rounds: 6,
    warmup: 100,
    maxBytesPerIteration: 1280,
    maxObjectsPerIteration: 1,
  });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
  expect((await verifyChain(store, { keys: KEY })).ok).toBe(true);
}, 120_000);

test("ctx.audit.log per request does not leak", async () => {
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [audit({ store: dbAuditStore(sqlite(), { key: KEY }) })],
    routes: [route.post("/x", { handler: async (c) => (await c.audit.log({ action: "update", resource: "x", before: { a: 1, password: "p" }, after: { a: 2 } }), "ok") })],
  });
  const r = await leakCheck("ctx.audit.log", async () => void (await (await app.fetch(new Request("http://x.test/x", { method: "POST" }))).arrayBuffer()), {
    perRound: 2000,
    rounds: 6,
    warmup: 1000,
  });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 120_000);

test("an app using audit() exits after appends, and after listen + stop", async () => {
  const r = await exitCheck(`
    import { miu, route } from "miujs";
    import { sqlite } from "@miujs/db";
    import { audit, dbAuditStore } from "../src/index.ts";
    const app = miu({ logLevel: "silent", plugins: [audit({ store: dbAuditStore(sqlite(), { key: "k".repeat(40) }) })],
      routes: [route.post("/x", { handler: async (c) => (await c.audit.log({ action: "a", resource: "r" }), "ok") })] });
    await app.ready();
    await (await app.fetch(new Request("http://x/x", { method: "POST" }))).text();
    await app.service("audit").logMany([{ action: "a", resource: "r" }, { action: "b", resource: "r" }]);
    const s = await app.listen(0, "127.0.0.1");
    await (await fetch(new URL("/x", s.url), { method: "POST" })).text();
    await s.stop();
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
