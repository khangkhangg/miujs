import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { cron, defineWorkflow, manual, NonRetryableError, on, StepFailedError, webhook, type WorkflowContext } from "../src/index.ts";
import { setup, T0 } from "./helpers.ts";

const DAY = 86_400_000;

describe("defineWorkflow", () => {
  test("normalizes triggers and defaults", () => {
    const wf = defineWorkflow("w", { trigger: on("contact.created"), input: t.object({ id: t.string() }), run: async () => null });
    expect(wf.kind).toBe("miu.workflow");
    expect(wf.name).toBe("w");
    expect(wf.triggers).toEqual([{ type: "event", event: "contact.created" }]);
    const multi = defineWorkflow("m", { trigger: [cron("0 9 * * 1"), manual(), webhook("/hooks/form")], run: async () => null });
    expect(multi.triggers.map((x) => x.type)).toEqual(["cron", "manual", "webhook"]);
    expect(defineWorkflow("none", { run: async () => null }).triggers).toEqual([{ type: "manual" }]);
  });

  test("bad config throws MIU_E_WORKFLOW_CONFIG with a fix", () => {
    const bad: (() => unknown)[] = [
      () => defineWorkflow("", { run: async () => null }),
      () => defineWorkflow("x", { run: "nope" as any }),
      () => defineWorkflow("x", { input: { not: "a schema" } as any, run: async () => null }),
      () => defineWorkflow("x", { concurrency: { key: () => "k", limit: 0 }, run: async () => null }),
      () => on(""),
      () => webhook("no-slash"),
    ];
    for (const fn of bad) {
      let err: any;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("MIU_E_WORKFLOW_CONFIG");
      expect(err.fix).toBeTruthy();
    }
    expect(() => cron("nope")).toThrow(); // the queue's cron parser explains
  });
});

describe("engine: replay with a step journal", () => {
  test("runs to completion and records output and step results", async () => {
    const wf = defineWorkflow("hello", {
      input: t.object({ name: t.string() }),
      run: async ({ input, step }) => {
        const greeting = await step.run("greet", async () => `hi ${input.name}`);
        return { greeting };
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id, status } = await s.wf.start("hello", { name: "Ann" });
    expect(status).toBe("queued");
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ greeting: "hi Ann" });
    expect(run.finishedAt).toBe(T0);
    expect(run.steps.map((x) => [x.name, x.status, x.attempts])).toEqual([["greet", "completed", 1]]);
    expect(run.steps[0].output).toBe("hi Ann");
  });

  test("completed steps are never re-executed; the body replays from the top", async () => {
    let bodies = 0;
    const calls: string[] = [];
    const wf = defineWorkflow("replay", {
      run: async ({ step }) => {
        bodies++;
        const a = await step.run("a", () => (calls.push("a"), 1));
        const b = await step.run("b", () => (calls.push("b"), a + 1));
        const c = await step.run("c", () => (calls.push("c"), b + 1));
        return c;
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect(calls).toEqual(["a", "b", "c"]);
    expect(bodies).toBe(4); // one invocation per new step, then one that finishes
    expect((await s.wf.getRun(id)).output).toBe(3);
  });

  test("step results are JSON round-tripped, so replays see the same values", async () => {
    const seen: unknown[] = [];
    const wf = defineWorkflow("json", {
      run: async ({ step }) => {
        const v = await step.run("date", () => ({ when: new Date(0), skip: undefined }));
        seen.push(v);
        return v;
      },
    });
    const s = setup([wf]);
    await s.ready();
    await s.wf.start(wf, {});
    await s.mq.drain();
    expect(seen).toEqual([{ when: "1970-01-01T00:00:00.000Z" }]);
  });

  test("the run gets input, env, log and run info", async () => {
    let ctx: WorkflowContext<any> | undefined;
    const wf = defineWorkflow("ctx", { input: t.object({ n: t.number() }), run: async (c) => void (ctx = c) });
    const s = setup([wf], { env: { SECRET: "s" } });
    await s.ready();
    const { id } = await s.wf.start(wf, { n: 1 });
    await s.mq.drain();
    expect(ctx!.input).toEqual({ n: 1 });
    expect(ctx!.env.SECRET).toBe("s");
    expect(typeof ctx!.log.info).toBe("function");
    expect(ctx!.run).toMatchObject({ id, workflow: "ctx", trigger: { type: "manual" } });
  });

  test("invalid input is rejected at start with MIU_E_VALIDATION; unknown workflows with MIU_E_WORKFLOW_UNKNOWN", async () => {
    const wf = defineWorkflow("typed", { input: t.object({ n: t.number() }), run: async () => null });
    const s = setup([wf]);
    await s.ready();
    await expect(s.wf.start(wf, { n: "x" })).rejects.toMatchObject({ code: "MIU_E_VALIDATION" });
    await expect(s.wf.start("nope", {})).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_UNKNOWN" });
  });

  test("two workflows with one name throw MIU_E_WORKFLOW_DUPLICATE", () => {
    const a = defineWorkflow("same", { run: async () => null });
    const b = defineWorkflow("same", { run: async () => null });
    expect(() => setup([a, b])).toThrow(expect.objectContaining({ code: "MIU_E_WORKFLOW_DUPLICATE" }));
  });

  test("a duplicate step name fails the run with MIU_E_WORKFLOW_STEP_DUPLICATE", async () => {
    const wf = defineWorkflow("dup", {
      run: async ({ step }) => {
        await step.run("x", () => 1);
        await step.run("x", () => 2);
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "MIU_E_WORKFLOW_STEP_DUPLICATE", step: "x" });
  });

  test("an error thrown outside steps fails the run without retries", async () => {
    let bodies = 0;
    const wf = defineWorkflow("throws", {
      run: async () => {
        bodies++;
        throw new Error("bad code");
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect(bodies).toBe(1);
    expect((await s.wf.getRun(id)).error).toEqual({ message: "bad code", name: "Error" });
  });

  test("parallel new steps (Promise.all) each run once, across invocations", async () => {
    const calls: string[] = [];
    const wf = defineWorkflow("parallel", {
      run: async ({ step }) => {
        const [a, b] = await Promise.all([step.run("a", () => (calls.push("a"), "A")), step.run("b", () => (calls.push("b"), "B"))]);
        return a + b;
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect(calls).toEqual(["a", "b"]);
    expect((await s.wf.getRun(id)).output).toBe("AB");
  });
});

describe("engine: determinism helpers", () => {
  test("step.now() and step.uuid() are journaled and identical on replay", async () => {
    const seen: [number, string][] = [];
    const wf = defineWorkflow("det", {
      run: async ({ step }) => {
        const now = await step.now();
        const id = await step.uuid();
        seen.push([now, id]);
        await step.sleep("pause", "1h");
        return { now, id };
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0][0]).toBe(T0);
    expect(seen[0][1]).toMatch(/^[0-9a-f-]{36}$/);
    const run = await s.wf.getRun(id);
    expect(run.steps.map((x) => x.kind)).toEqual(["now", "uuid", "sleep"]);
  });
});

describe("engine: durable sleep", () => {
  test("sleeps until the wake-up time, then continues", async () => {
    const after: number[] = [];
    const wf = defineWorkflow("sleeper", {
      run: async ({ step }) => {
        await step.sleep("wait-a-day", "1d");
        after.push(await step.now());
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.settle();
    let run = await s.wf.getRun(id);
    expect(run.status).toBe("sleeping");
    expect(run.wakeAt).toBe(T0 + DAY);
    expect(run.steps[0]).toMatchObject({ name: "wait-a-day", status: "sleeping", wakeAt: T0 + DAY });
    s.clock.advance(DAY - 1000);
    await s.settle();
    expect((await s.wf.getRun(id)).status).toBe("sleeping");
    await s.mq.drain();
    run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(after).toEqual([T0 + DAY]);
  });

  test("delays longer than the adapter maximum are chained", async () => {
    const wf = defineWorkflow("long", { run: async ({ step }) => void (await step.sleep("nap", "3h")) });
    const s = setup([wf], { maxDelaySeconds: 3600 });
    const delays: (number | undefined)[] = [];
    const send = s.mq.send.bind(s.mq);
    s.mq.send = (msg, o, env) => (delays.push(o.delay), send(msg, o, env));
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect(delays).toEqual([undefined, 3600, 3600, 3600]);
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.finishedAt).toBe(T0 + 3 * 3_600_000);
  });

  test("an invalid duration fails the run with MIU_E_WORKFLOW_DURATION", async () => {
    const wf = defineWorkflow("baddur", { run: async ({ step }) => void (await step.sleep("x", "soon")) });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect((await s.wf.getRun(id)).error?.code).toBe("MIU_E_WORKFLOW_DURATION");
  });
});

describe("engine: waitForEvent", () => {
  const waiter = defineWorkflow("waiter", {
    input: t.object({ contactId: t.string() }),
    run: async ({ input, step }) => {
      const reply = await step.waitForEvent("reply", { event: "email.replied", match: { "data.contactId": input.contactId }, timeout: "3d" });
      const followed = reply ? null : await step.run("send-follow-up", () => "sent");
      return { reply, followed };
    },
  });

  test("a matching event resumes the run with the event", async () => {
    const s = setup([waiter]);
    await s.ready();
    const { id } = await s.wf.start(waiter, { contactId: "c1" });
    await s.settle();
    expect((await s.wf.getRun(id)).status).toBe("waiting");
    const other = await s.wf.emit("email.replied", { contactId: "c2" });
    expect(other.resumed).toEqual([]);
    await s.settle();
    expect((await s.wf.getRun(id)).status).toBe("waiting");
    s.clock.advance(60_000);
    const res = await s.wf.emit("email.replied", { contactId: "c1", text: "thanks" });
    expect(res.resumed).toEqual([id]);
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ reply: { id: res.id, name: "email.replied", data: { contactId: "c1", text: "thanks" }, ts: T0 + 60_000 }, followed: null });
  });

  test("the timeout resumes the run with null", async () => {
    const s = setup([waiter]);
    await s.ready();
    const { id } = await s.wf.start(waiter, { contactId: "c1" });
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ reply: null, followed: "sent" });
    expect(run.finishedAt).toBe(T0 + 3 * DAY);
    // A late event finds no waiter.
    expect((await s.wf.emit("email.replied", { contactId: "c1" })).resumed).toEqual([]);
  });

  test("the timeout message left behind by an event is a no-op", async () => {
    let bodies = 0;
    const wf = defineWorkflow("w2", {
      run: async ({ step }) => {
        bodies++;
        return await step.waitForEvent("e", { event: "ping", timeout: "1h" });
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.settle();
    await s.wf.emit("ping", { n: 1 });
    await s.settle();
    expect(bodies).toBe(2);
    await s.mq.drain(); // fires the stale 1h timeout message
    expect(bodies).toBe(2);
    expect((await s.wf.getRun(id)).output).toMatchObject({ data: { n: 1 } });
  });

  test("without a timeout the run waits forever", async () => {
    const wf = defineWorkflow("forever", { run: async ({ step }) => await step.waitForEvent("e", { event: "never" }) });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("waiting");
    expect(run.wakeAt).toBeNull();
  });
});

describe("engine: step retries", () => {
  test("a failing step retries with backoff, then succeeds", async () => {
    let n = 0;
    const wf = defineWorkflow("flaky", {
      run: async ({ step }) =>
        await step.run(
          "call",
          async () => {
            if (++n < 3) throw new Error(`fail ${n}`);
            return "ok";
          },
          { retries: 3, backoff: 10 },
        ),
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.settle();
    let run = await s.wf.getRun(id);
    expect(run.steps[0]).toMatchObject({ status: "retrying", attempts: 1, error: { message: "fail 1" }, wakeAt: T0 + 10_000 });
    await s.mq.drain();
    run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toBe("ok");
    expect(run.steps[0]).toMatchObject({ status: "completed", attempts: 3, error: null });
    expect(run.finishedAt).toBe(T0 + 20_000);
  });

  test("exponential backoff is the default (5s, 10s, 20s)", async () => {
    const wf = defineWorkflow("exp", {
      run: async ({ step }) =>
        await step.run("x", () => {
          throw new Error("always");
        }),
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toEqual({ message: "always", name: "StepFailedError", step: "x" });
    expect(run.steps[0]).toMatchObject({ status: "failed", attempts: 4 });
    expect(run.finishedAt).toBe(T0 + 35_000);
  });

  test("workflow code can catch a step that failed every attempt", async () => {
    const wf = defineWorkflow("catcher", {
      run: async ({ step }) => {
        try {
          await step.run("x", () => {
            throw new Error("nope");
          }, { retries: 0 });
        } catch (e) {
          return { caught: e instanceof StepFailedError, step: (e as StepFailedError).step };
        }
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect((await s.wf.getRun(id)).output).toEqual({ caught: true, step: "x" });
  });

  test("NonRetryableError fails the step at once", async () => {
    let n = 0;
    const wf = defineWorkflow("nr", {
      run: async ({ step }) =>
        await step.run("x", () => {
          n++;
          throw new NonRetryableError("invalid email");
        }),
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect(n).toBe(1);
    expect((await s.wf.getRun(id)).error).toMatchObject({ message: "invalid email", step: "x" });
  });
});

describe("engine: run control", () => {
  test("cancel stops a waiting run and removes its waiter", async () => {
    const wf = defineWorkflow("c", { run: async ({ step }) => await step.waitForEvent("e", { event: "go", timeout: "1d" }) });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.settle();
    const cancelled = await s.wf.cancel(id);
    expect(cancelled.status).toBe("cancelled");
    expect((await s.wf.emit("go", {})).resumed).toEqual([]);
    await s.mq.drain();
    expect((await s.wf.getRun(id)).status).toBe("cancelled");
    await expect(s.wf.cancel(id)).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_RUN_STATE", status: 409 });
    await expect(s.wf.cancel("missing")).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_RUN_NOT_FOUND" });
  });

  test("retry resumes a failed run from the failed step", async () => {
    const calls: string[] = [];
    let healthy = false;
    const wf = defineWorkflow("r", {
      run: async ({ step }) => {
        await step.run("first", () => void calls.push("first"));
        return await step.run("second", () => {
          calls.push("second");
          if (!healthy) throw new Error("down");
          return "done";
        }, { retries: 1, backoff: 1 });
      },
    });
    const s = setup([wf]);
    await s.ready();
    const { id } = await s.wf.start(wf, {});
    await s.mq.drain();
    expect((await s.wf.getRun(id)).status).toBe("failed");
    await expect(s.wf.retry("missing")).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_RUN_NOT_FOUND" });
    healthy = true;
    const r = await s.wf.retry(id);
    expect(r.status).toBe("queued");
    await s.mq.drain();
    const run = await s.wf.getRun(id);
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(calls).toEqual(["first", "second", "second", "second"]);
    await expect(s.wf.retry(id)).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_RUN_STATE" });
  });
});

describe("engine: concurrency", () => {
  test("runs over the per-key limit wait in queued until a slot frees", async () => {
    const order: string[] = [];
    const wf = defineWorkflow("per-contact", {
      input: t.object({ contactId: t.string(), n: t.number() }),
      concurrency: { key: (input) => input.contactId, limit: 1 },
      run: async ({ input, step }) => {
        await step.run("start", () => void order.push(`start ${input.n}`));
        await step.sleep("wait", "1h");
        await step.run("end", () => void order.push(`end ${input.n}`));
      },
    });
    const s = setup([wf]);
    await s.ready();
    const a = await s.wf.start(wf, { contactId: "c1", n: 1 });
    const b = await s.wf.start(wf, { contactId: "c1", n: 2 });
    const c = await s.wf.start(wf, { contactId: "c2", n: 3 });
    expect(a.status).toBe("queued");
    await s.settle();
    expect((await s.wf.getRun(a.id)).status).toBe("sleeping");
    expect((await s.wf.getRun(b.id)).status).toBe("queued");
    expect((await s.wf.getRun(c.id)).status).toBe("sleeping");
    await s.mq.drain();
    expect(order).toEqual(["start 1", "start 3", "end 1", "end 3", "start 2", "end 2"]);
    expect((await s.wf.getRun(b.id)).status).toBe("completed");
  });
});

describe("engine: events", () => {
  const onCreated = defineWorkflow("on-created", {
    trigger: on("contact.created"),
    input: t.object({ contactId: t.string() }),
    run: async ({ input }) => input.contactId,
  });
  const bigDeals = defineWorkflow("big-deals", {
    trigger: on("deal.updated", { match: { "data.stage": "won" }, input: (e) => ({ dealId: (e.data as any).id }) }),
    input: t.object({ dealId: t.string() }),
    run: async ({ input }) => input.dealId,
  });

  test("emit starts matching workflows with the event data as input", async () => {
    const s = setup([onCreated, bigDeals]);
    await s.ready();
    const res = await s.wf.emit("contact.created", { contactId: "c1" });
    expect(res.duplicate).toBe(false);
    expect(res.started.length).toBe(1);
    await s.mq.drain();
    const run = await s.wf.getRun(res.started[0].id);
    expect(run).toMatchObject({ workflow: "on-created", status: "completed", output: "c1", trigger: { type: "event", event: "contact.created", eventId: res.id } });
  });

  test("trigger match and input mapping", async () => {
    const s = setup([onCreated, bigDeals]);
    await s.ready();
    expect((await s.wf.emit("deal.updated", { id: "d1", stage: "open" })).started).toEqual([]);
    const res = await s.wf.emit("deal.updated", { id: "d2", stage: "won" });
    expect(res.started.map((x) => x.workflow)).toEqual(["big-deals"]);
    await s.mq.drain();
    expect((await s.wf.getRun(res.started[0].id)).output).toBe("d2");
  });

  test("an idempotency key de-duplicates emits", async () => {
    const s = setup([onCreated]);
    await s.ready();
    const a = await s.wf.emit("contact.created", { contactId: "c1" }, { idempotencyKey: "k1" });
    const b = await s.wf.emit("contact.created", { contactId: "c1" }, { idempotencyKey: "k1" });
    expect(b).toEqual({ id: a.id, duplicate: true, started: [], resumed: [], skipped: [] });
    expect((await s.wf.listRuns({})).length).toBe(1);
  });

  test("events whose data does not fit a workflow's input are skipped and reported", async () => {
    const s = setup([onCreated]);
    await s.ready();
    const res = await s.wf.emit("contact.created", { nope: true });
    expect(res.started).toEqual([]);
    expect(res.skipped).toEqual([{ workflow: "on-created", code: "MIU_E_VALIDATION", message: expect.stringContaining("contactId") }]);
  });

  test("listRuns filters", async () => {
    const s = setup([onCreated, bigDeals]);
    await s.ready();
    await s.wf.emit("contact.created", { contactId: "c1" });
    s.clock.advance(1000);
    await s.wf.emit("deal.updated", { id: "d", stage: "won" });
    await s.mq.drain();
    expect((await s.wf.listRuns({ workflow: "big-deals" })).map((r) => r.workflow)).toEqual(["big-deals"]);
    expect((await s.wf.listRuns({ status: "completed" })).length).toBe(2);
    expect((await s.wf.listRuns({ limit: 1 }))[0].workflow).toBe("big-deals");
  });
});

describe("engine: cron triggers", () => {
  test("a cron workflow starts when its schedule matches (UTC)", async () => {
    const wf = defineWorkflow("weekly", { trigger: cron("0 9 * * 1"), run: async ({ step }) => await step.now() });
    const s = setup([wf]);
    await s.ready();
    s.clock.advance(59 * 60_000);
    await s.settle();
    expect(await s.wf.listRuns({})).toEqual([]);
    s.clock.advance(60_000); // 09:00 Monday
    await s.mq.drain();
    const runs = await s.wf.listRuns({});
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ status: "completed", output: T0 + 3_600_000, trigger: { type: "cron", cron: "0 9 * * 1" } });
    s.wf.stop();
  });
});

describe("inspect", () => {
  test("lists workflows, triggers, store and queue", async () => {
    const wf = defineWorkflow("insp", {
      description: "d",
      trigger: [on("a.b"), cron("0 9 * * 1"), webhook("/hooks/i", { secret: "s" })],
      concurrency: { key: () => "k", limit: 2 },
      run: async () => null,
    });
    const s = setup([wf]);
    await s.ready();
    const info = s.app.inspect().plugins.find((p) => p.name === "workflows")!.info as any;
    expect(info.store).toMatchObject({ adapter: "memory" });
    expect(info.queue).toEqual({ adapter: "memory", maxDelaySeconds: null });
    expect(info.workflows[0]).toMatchObject({
      name: "insp",
      description: "d",
      json: false,
      concurrency: { limit: 2 },
      triggers: [{ type: "event", event: "a.b" }, { type: "cron", cron: "0 9 * * 1" }, { type: "webhook", path: "/hooks/i", signed: true }],
    });
    expect(info.routes).toContain("POST /hooks/i");
    expect(info.routes).toContain("GET /workflows/runs/:id");
    s.wf.stop();
  });
});
