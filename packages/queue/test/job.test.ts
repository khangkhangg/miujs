import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { backoffSeconds, defineJob, manualClock, schedule } from "../src/index.ts";

describe("defineJob", () => {
  test("defaults: 3 retries, exponential backoff", () => {
    const job = defineJob("send-email", { input: t.object({ to: t.string() }), run: async () => {} });
    expect(job.name).toBe("send-email");
    expect(job.retries).toBe(3);
    expect(job.backoff).toBe("exponential");
    expect(job.maxAttempts).toBe(4);
  });

  test("rejects bad names and options", () => {
    const run = async () => {};
    const input = t.object({});
    for (const bad of [
      () => defineJob("", { input, run }),
      () => defineJob("x", { input, run, retries: -1 }),
      () => defineJob("x", { input, run, retries: 1.5 }),
      () => defineJob("x", { input, run, backoff: -1 }),
      () => defineJob("x", { input: {} as any, run }),
      () => defineJob("x", { input, run: undefined as any }),
    ]) {
      expect(bad).toThrow();
      try {
        bad();
      } catch (e) {
        expect((e as any).code).toBe("MIU_E_QUEUE_CONFIG");
        expect((e as any).fix).toBeTruthy();
      }
    }
  });
});

describe("backoffSeconds", () => {
  test("exponential doubles from 5s and caps at 1h", () => {
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    expect([1, 2, 3, 4].map((a) => backoffSeconds(job, a))).toEqual([5, 10, 20, 40]);
    expect(backoffSeconds(job, 20)).toBe(3600);
  });

  test("a number is a fixed delay", () => {
    const job = defineJob("j", { input: t.object({}), backoff: 7, run: () => {} });
    expect([1, 2, 3].map((a) => backoffSeconds(job, a))).toEqual([7, 7, 7]);
  });
});

describe("schedule", () => {
  test("parses the cron eagerly", () => {
    const job = defineJob("j", { input: t.object({}), run: () => {} });
    const s = schedule("*/5 * * * *", job, {});
    expect(s.cron.source).toBe("*/5 * * * *");
    expect(s.job).toBe(job);
    expect(() => schedule("nope", job)).toThrow();
  });

  test("validates its input against the job schema", () => {
    const job = defineJob("j", { input: t.object({ n: t.number() }), run: () => {} });
    try {
      schedule("* * * * *", job, { n: "x" } as any);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as any).code).toBe("MIU_E_VALIDATION");
    }
  });
});

describe("manualClock", () => {
  test("fires timers in due order when advanced", () => {
    const c = manualClock(1000);
    const fired: string[] = [];
    c.setTimeout(() => fired.push("b"), 200);
    c.setTimeout(() => fired.push("a"), 100);
    const h = c.setTimeout(() => fired.push("x"), 150);
    c.clearTimeout(h);
    c.advance(150);
    expect(fired).toEqual(["a"]);
    expect(c.now()).toBe(1150);
    c.advance(100);
    expect(fired).toEqual(["a", "b"]);
  });

  test("timers scheduled while firing run if due", () => {
    const c = manualClock(0);
    const fired: number[] = [];
    c.setTimeout(() => {
      fired.push(c.now());
      c.setTimeout(() => fired.push(c.now()), 10);
    }, 10);
    c.advance(100);
    expect(fired).toEqual([10, 20]);
    expect(c.now()).toBe(100);
    expect(c.pending()).toBe(0);
  });
});
