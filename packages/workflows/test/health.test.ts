// Memory, exit and throughput health of the workflow engine. Each leak check runs thousands of
// runs or events and fails if live memory keeps growing once retention limits are reached.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { t } from "miujs";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { cron, defineWorkflow, manual, memoryRunStore, webhook } from "../src/index.ts";
import { setup } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");

// Bun frees fired timer objects (the memory queue's pump timers) only when the event loop gets
// back to its timer phase, so yield one real macrotask now and then; otherwise those show up as
// growth even though they are bounded.
const macrotask = (i: number) => (i % 100 === 0 ? new Promise((r) => setTimeout(r, 1)) : undefined);

const lifecycle = defineWorkflow("lifecycle", {
  input: t.object({ n: t.integer() }),
  run: async ({ input, step }) => {
    const a = await step.run("a", async () => input.n + 1);
    const b = await step.run("b", async () => a * 2);
    await step.sleep("nap", "1h");
    const evt = await step.waitForEvent("paid", { event: "invoice.paid", match: { "data.n": input.n } });
    const ok = await step.waitForApproval("ok", { approvers: { role: "manager" } });
    return { b, paid: evt !== null, decision: ok?.decision };
  },
});

describe("workflow engine memory plateaus", () => {
  test("runs through steps, sleep, waitForEvent and approval to completion", async () => {
    const s = setup([lifecycle], { store: memoryRunStore({ maxFinishedRuns: 200 }) });
    await s.ready();
    const boss = { id: "m1", roles: ["manager"] };
    const r = await leakCheck(
      "workflow lifecycle",
      async (i) => {
        const { id } = await s.wf.start("lifecycle", { n: i });
        await s.mq.drain(); // steps + sleep, parks on the event
        await s.wf.emit("invoice.paid", { n: i });
        await s.mq.drain(); // parks on the approval
        await s.wf.decide(id, "ok", boss, "approve");
        await s.mq.drain();
        await macrotask(i);
      },
      { warmup: 500, perRound: 1000, rounds: 5 },
    );
    expect(r.leaking, describeLeak(r)).toBe(false);
    const runs = await s.wf.listRuns({ limit: 1000 });
    expect(runs.length).toBeLessThanOrEqual(200);
    expect(runs.every((x) => x.status === "completed")).toBe(true);
  }, 120_000);

  test("the default retention keeps the newest finished runs and bounds the rest", async () => {
    const store = memoryRunStore({ maxFinishedRuns: 50 });
    const quick = defineWorkflow("quick", { run: async ({ step }) => step.run("x", () => 1) });
    const s = setup([quick], { store });
    await s.ready();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push((await s.wf.start("quick")).id);
    await s.mq.drain();
    expect(store.describe()).toMatchObject({ runs: 50 });
    // The newest are kept, the oldest are gone.
    expect((await s.wf.getRun(ids[119])).status).toBe("completed");
    await expect(s.wf.getRun(ids[0])).rejects.toThrow();
  });

  test("events with idempotency keys", async () => {
    const s = setup([], { store: memoryRunStore({ maxIdempotencyKeys: 500 }) });
    await s.ready();
    const r = await leakCheck("emit with idempotency keys", async (i) => void (await s.wf.emit("ping", { i }, { idempotencyKey: `k${i}` })), { perRound: 2000, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("idempotency keys still dedupe within their window", async () => {
    const s = setup([], { store: memoryRunStore({ maxIdempotencyKeys: 3 }) });
    await s.ready();
    expect((await s.wf.emit("e", 1, { idempotencyKey: "a" })).duplicate).toBe(false);
    expect((await s.wf.emit("e", 1, { idempotencyKey: "a" })).duplicate).toBe(true);
    for (const k of ["b", "c", "d"]) await s.wf.emit("e", 1, { idempotencyKey: k });
    // "a" fell out of the bounded window.
    expect((await s.wf.emit("e", 1, { idempotencyKey: "a" })).duplicate).toBe(false);
  });

  test("register / unregister cycles (cron + webhook + event triggers)", async () => {
    const s = setup([]);
    await s.ready();
    const r = await leakCheck(
      "register/unregister",
      (i) => {
        s.wf.register(defineWorkflow(`w${i}`, { trigger: [cron("0 9 * * 1"), webhook(`/hooks/w${i}`), manual()], run: async () => i }));
        s.wf.unregister(`w${i}`);
      },
      { perRound: 2000, rounds: 5 },
    );
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect((s.wf.inspect() as { routes: string[] }).routes.some((x) => x.includes("/hooks/"))).toBe(false);
  }, 60_000);
});

describe("workflow apps exit", () => {
  test("after ready() and a few runs on the memory queue", async () => {
    const r = await exitCheck(
      `
      import { miu } from "miujs";
      import { defineWorkflow, workflows } from "../src/index.ts";
      const wf = workflows({ workflows: [defineWorkflow("w", { run: async ({ step }) => step.run("a", () => 1) })] });
      const app = miu({ logLevel: "silent", plugins: [wf] });
      await app.ready();
      for (let i = 0; i < 5; i++) await wf.start("w");
      await wf.emit("anything", { x: 1 }, { idempotencyKey: "k" });
      await new Promise((r) => setTimeout(r, 50));
      `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  }, 10_000);

  test("after listen() and stop()", async () => {
    const r = await exitCheck(
      `
      import { miu } from "miujs";
      import { defineWorkflow, workflows } from "../src/index.ts";
      const wf = workflows({ workflows: [defineWorkflow("w", { run: async ({ step }) => step.run("a", () => 1) })] });
      const app = miu({ logLevel: "silent", plugins: [wf] });
      const s = await app.listen(0, "127.0.0.1");
      await wf.start("w");
      await fetch(new URL("/workflows/runs", s.url));
      await s.stop();
      `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  }, 10_000);
});

describe("workflow throughput", () => {
  test("step throughput (report)", async () => {
    const steps = defineWorkflow("steps", {
      run: async ({ step }) => {
        let x = 0;
        for (let k = 0; k < 10; k++) x = await step.run(`s${k}`, () => x + 1);
        return x;
      },
    });
    const s = setup([steps]);
    await s.ready();
    const runs = 300;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) await s.wf.start("steps");
    await s.mq.drain();
    const ms = performance.now() - t0;
    console.log(`workflow steps: ${Math.round((runs * 10) / (ms / 1000))} steps/s (${runs} runs x 10 steps in ${ms.toFixed(0)} ms)`);
    expect((await s.wf.listRuns({ status: "completed", limit: 1000 })).length).toBe(runs);
  }, 60_000);
});
