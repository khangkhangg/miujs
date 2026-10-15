// The admin management section: run counts, the runs list with cancel/retry, starting a workflow
// or emitting an event by hand, and disabling workflows at run time.
import { describe, expect, test } from "bun:test";
import { t, validate, type Context, type ManageAction, type ManageList, type ManageSection } from "miujs";
import { sqlite } from "@miujs/db";
import { cron, dbRunStore, defineWorkflow, manual, NonRetryableError, on, webhook, type WorkflowsOptions } from "../src/index.ts";
import { setup, T0 } from "./helpers.ts";

const ctx = (user?: { id: string }) => ({ env: {}, user }) as unknown as Context;
const iso = (ms: number) => new Date(ms).toISOString();
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);

function section(p: { manage?(): ManageSection[] }): ManageSection {
  const s = p.manage!();
  expect(s.map((x) => x.id)).toEqual(["workflows"]);
  return s[0];
}
const list = (s: ManageSection, name: string): ManageList => s.lists!.find((x) => x.name === name)!;
const action = (actions: ManageAction[] | undefined, name: string): ManageAction => {
  const a = actions?.find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
};

const greet = defineWorkflow("greet", {
  description: "Say hi",
  trigger: [on("contact.created"), manual()],
  input: t.object({ name: t.string(), apiToken: t.optional(t.string()) }),
  run: async ({ input, step }) => await step.run("hi", () => `hi ${input.name}`),
});
const flaky = defineWorkflow("flaky", {
  trigger: manual(),
  input: t.object({ fail: t.boolean() }),
  run: async ({ input, step }) =>
    await step.run("call", () => {
      if (input.fail) throw new NonRetryableError("provider said no");
      return "ok";
    }),
});
const waiter = defineWorkflow("waiter", {
  trigger: [manual(), cron("0 9 * * 1"), webhook("/hooks/w", { secret: "whsec_topsecret" })],
  run: async ({ step }) => await step.waitForEvent("go", { event: "go.now", timeout: "1d" }),
});

async function make() {
  const s = setup([greet, flaky, waiter]);
  await s.ready();
  return { ...s, m: section(s.wf) };
}

describe("workflows manage: status", () => {
  test("counts active and failed runs, lists workflows and recent failures, no secrets", async () => {
    const { wf, settle, m } = await make();
    await wf.start("greet", { name: "Ann" });
    const f = await wf.start("flaky", { fail: true });
    await wf.start("waiter", {});
    await settle();
    const st = await m.status!(ctx());
    const byLabel = Object.fromEntries(st.stats!.map((x) => [x.label, x.value]));
    expect(byLabel).toMatchObject({ Workflows: 3, Disabled: 0, Queued: 0, Running: 0, Sleeping: 0, Waiting: 1, Failed: 1, Store: "memory", Queue: "memory" });
    expect(st.stats!.find((x) => x.label === "Failed")!.tone).toBe("critical");
    const defs = st.tables!.find((x) => x.title === "Workflows")!;
    expect(defs.rows).toEqual([
      { name: "greet", description: "Say hi", triggers: "event contact.created, manual", enabled: true },
      { name: "flaky", description: null, triggers: "manual", enabled: true },
      { name: "waiter", description: null, triggers: "manual, cron 0 9 * * 1, webhook /hooks/w (signed)", enabled: true },
    ]);
    const fails = st.tables!.find((x) => x.title === "Recent failures")!;
    expect(fails.rows).toEqual([{ id: f.id, workflow: "flaky", step: "call", error: "provider said no", at: iso(T0) }]);
    expect(JSON.stringify(st)).not.toContain("whsec_topsecret");
    wf.stop();
  });

  test("counts are capped instead of scanning every run", async () => {
    const { wf, m } = await make();
    for (let i = 0; i < 205; i++) await wf.start("waiter", {});
    const queued = (await m.status!(ctx())).stats!.find((x) => x.label === "Queued")!;
    expect(queued.value).toBe("200+");
    wf.stop();
  });
});

describe("workflows manage: runs list", () => {
  test("pages newest first through runs created in the same millisecond, filters, and never shows tokens", async () => {
    const { wf, settle, m } = await make();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await wf.start("greet", { name: `n${i}`, apiToken: "tok_secret" })).id);
    await wf.start("flaky", { fail: false });
    await settle();
    const runs = list(m, "runs");
    expect(runs.idKey).toBe("id");
    expect(runs.searchable).toBe(true);
    expect(runs.filters!.map((x) => x.key)).toEqual(["workflow", "status"]);
    expect(runs.filters![0].options).toEqual(["greet", "flaky", "waiter"]);

    const p1 = await runs.list({ limit: 2, filters: { workflow: "greet" } }, ctx());
    expect(p1.rows.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    const p2 = await runs.list({ limit: 2, cursor: p1.next, filters: { workflow: "greet" } }, ctx());
    expect(p2.rows.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const p3 = await runs.list({ limit: 2, cursor: p2.next, filters: { workflow: "greet" } }, ctx());
    expect(p3.rows.map((r) => r.id)).toEqual([ids[0]]);
    expect(p3.next).toBeUndefined();

    expect(p1.rows[0]).toMatchObject({ workflow: "greet", status: "completed", trigger: "manual", error: null, createdAt: iso(T0), finishedAt: iso(T0) });
    const all = JSON.stringify([p1, p2, p3]);
    expect(all).not.toContain("tok_secret");
    expect(all).not.toContain('"token"');

    const byStatus = await runs.list({ limit: 10, filters: { status: "completed", workflow: "flaky" } }, ctx());
    expect(byStatus.rows).toHaveLength(1);
    expect((await runs.list({ limit: 10, search: ids[2] }, ctx())).rows.map((r) => r.id)).toEqual([ids[2]]);
    expect((await runs.list({ limit: 10, search: "nope" }, ctx())).rows).toEqual([]);
    wf.stop();
  });

  test("bad filters and cursors are rejected", async () => {
    const { wf, m } = await make();
    const runs = list(m, "runs");
    await expect(attempt(() => runs.list({ limit: 10, filters: { status: "zombie" } }, ctx()))).rejects.toThrow(/status/);
    await expect(attempt(() => runs.list({ limit: 10, cursor: "x" }, ctx()))).rejects.toThrow(/cursor/);
    wf.stop();
  });

  test("cancel and retry row actions, idempotent with clear messages", async () => {
    const { wf, settle, m } = await make();
    const w = await wf.start("waiter", {});
    const f = await wf.start("flaky", { fail: true });
    await settle();
    const runs = list(m, "runs");
    const cancel = action(runs.rowActions, "cancel");
    expect(cancel.danger).toBe(true);
    expect(validate(cancel.input!, {}).ok).toBe(false);
    expect(await cancel.run({ id: w.id }, ctx())).toMatch(/cancelled/i);
    expect((await wf.getRun(w.id)).status).toBe("cancelled");
    expect(await cancel.run({ id: w.id }, ctx())).toMatch(/already cancelled/i);

    const retry = action(runs.rowActions, "retry");
    expect(await retry.run({ id: w.id }, ctx())).toMatch(/only failed runs/i);
    expect(await retry.run({ id: f.id }, ctx())).toMatch(/retrying/i);
    await settle();
    expect((await wf.getRun(f.id)).status).toBe("failed"); // still fails, but it ran again
    await expect(attempt(() => cancel.run({ id: "missing" }, ctx()))).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_RUN_NOT_FOUND" });
    wf.stop();
  });
});

describe("workflows manage: actions", () => {
  test("start runs a workflow with JSON input as the operator", async () => {
    const { wf, settle, m } = await make();
    const start = action(m.actions, "start");
    expect(validate(start.input!, {}).ok).toBe(false);
    expect(validate(start.input!, { workflow: "" }).ok).toBe(false);
    const r = (await start.run({ workflow: "greet", input: '{"name":"Bo"}' }, ctx({ id: "op1" }))) as { id: string; message: string };
    expect(r.message).toMatch(/greet/);
    await settle();
    const run = await wf.getRun(r.id);
    expect(run).toMatchObject({ status: "completed", output: "hi Bo", trigger: { type: "manual", by: "op1" } });
    await expect(attempt(() => start.run({ workflow: "greet", input: { name: 5 } }, ctx()))).rejects.toMatchObject({ code: "MIU_E_VALIDATION" });
    await expect(attempt(() => start.run({ workflow: "greet", input: "{bad" }, ctx()))).rejects.toThrow(/JSON/);
    await expect(attempt(() => start.run({ workflow: "ghost" }, ctx()))).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_UNKNOWN" });
    wf.stop();
  });

  test("emit sends an event that starts and resumes runs", async () => {
    const { wf, settle, m } = await make();
    const w = await wf.start("waiter", {});
    await settle();
    const emit = action(m.actions, "emit");
    expect(validate(emit.input!, { event: "" }).ok).toBe(false);
    const r = (await emit.run({ event: "go.now" }, ctx())) as { message: string; resumed: string[] };
    expect(r.resumed).toEqual([w.id]);
    expect(r.message).toMatch(/resumed 1/);
    await settle();
    expect((await wf.getRun(w.id)).status).toBe("completed");
    const r2 = (await emit.run({ event: "contact.created", data: { name: "Cy" } }, ctx())) as { started: unknown[] };
    expect(r2.started).toHaveLength(1);
    wf.stop();
  });
});

describe("workflows manage: settings (disable workflows)", () => {
  test("disabled workflows start no new runs from any trigger; existing runs go on", async () => {
    const { wf, settle, m, clock, mq } = await make();
    const delayed = () => (mq.inspect!() as { delayed: number }).delayed;
    const existing = await wf.start("waiter", {});
    await settle();
    const set = m.settings!;
    expect(await set.get(ctx())).toEqual({ disabled: [] });
    expect(validate(set.schema, { disabled: "greet" }).ok).toBe(false);
    expect(validate(set.schema, { disabled: [1] }).ok).toBe(false);
    await set.set({ disabled: ["greet", "waiter"] }, ctx());
    expect(await set.get(ctx())).toEqual({ disabled: ["greet", "waiter"] });

    await expect(wf.start("greet", { name: "x" })).rejects.toMatchObject({ code: "MIU_E_CONFLICT", status: 409 });
    await expect(attempt(() => action(m.actions, "start").run({ workflow: "waiter" }, ctx()))).rejects.toThrow(/disabled/);
    const emitted = await wf.emit("contact.created", { name: "x" });
    expect(emitted.started).toEqual([]);
    expect(emitted.skipped[0]).toMatchObject({ workflow: "greet", code: "MIU_E_CONFLICT" });
    const before = delayed();
    clock.advanceTo(Date.UTC(2026, 0, 5, 9, 0, 0)); // the waiter's cron fires: skipped, not failed and retried
    await settle();
    expect((await wf.listRuns({ workflow: "waiter" })).length).toBe(1);
    expect(delayed()).toBe(before);

    await wf.emit("go.now", {}); // the run started before disabling still finishes
    await settle();
    expect((await wf.getRun(existing.id)).status).toBe("completed");

    const st = await m.status!(ctx());
    expect(st.stats!.find((x) => x.label === "Disabled")!.value).toBe(2);
    expect(st.tables![0].rows.find((r) => r.name === "greet")!.enabled).toBe(false);

    await set.set({ disabled: [] }, ctx());
    expect((await wf.start("greet", { name: "y" })).status).toBe("queued");
    wf.stop();
  });
});

describe("workflows manage: wake a run now", () => {
  const DAY = 86_400_000;
  const stores: [string, () => Partial<WorkflowsOptions>][] = [
    ["memory store", () => ({})],
    ["db store (sqlite)", () => ({ store: dbRunStore(sqlite()) })],
  ];
  for (const [label, over] of stores) {
    describe(label, () => {
      test("a sleeping run continues now; the old wake-up message is a no-op", async () => {
        const after: number[] = [];
        const nap = defineWorkflow("nap", {
          trigger: manual(),
          run: async ({ step }) => {
            await step.sleep("long-nap", "1d");
            after.push(await step.now("woke"));
            return "rested";
          },
        });
        const s = setup([nap], over());
        await s.ready();
        const m = section(s.wf);
        const wake = action(list(m, "runs").rowActions, "wakeNow");
        expect(wake.danger).toBeFalsy();
        expect(validate(wake.input!, { id: "x" }).ok).toBe(true);
        const { id } = await s.wf.start("nap", {});
        await s.settle();
        expect((await s.wf.getRun(id)).status).toBe("sleeping");
        expect(String(await wake.run({ id }, ctx()))).toMatch(/woke/i);
        await s.settle(); // no clock movement
        const run = await s.wf.getRun(id);
        expect(run).toMatchObject({ status: "completed", output: "rested" });
        expect(run.steps.find((x) => x.name === "long-nap")).toMatchObject({ status: "completed", wakeAt: null });
        expect(after).toEqual([T0]);
        await s.mq.drain(); // the original message fires a day later
        expect(after).toEqual([T0]);
        s.wf.stop();
      });

      test("waking twice wakes once (idempotent); a finished run is left alone", async () => {
        let runs = 0;
        const nap = defineWorkflow("nap2", {
          trigger: manual(),
          run: async ({ step }) => {
            await step.sleep("zz", "2h");
            await step.run("after", () => ++runs);
          },
        });
        const s = setup([nap], over());
        await s.ready();
        const wake = action(list(section(s.wf), "runs").rowActions, "wakeNow");
        const { id } = await s.wf.start("nap2", {});
        await s.settle();
        // The public client wakes the same way: once.
        expect(await s.wf.wakeNow(id)).toMatchObject({ runId: id, woke: true });
        expect(String(await wake.run({ id }, ctx()))).toMatch(/nothing to do/i);
        await s.settle();
        expect(String(await wake.run({ id }, ctx()))).toMatch(/completed; nothing to do/i);
        await s.mq.drain();
        expect(runs).toBe(1);
        expect((await s.wf.getRun(id)).status).toBe("completed");
        await expect(attempt(() => wake.run({ id: "missing" }, ctx()))).rejects.toMatchObject({ code: "MIU_E_WORKFLOW_RUN_NOT_FOUND" });
        s.wf.stop();
      });

      test("a run waiting for an event resumes with timeout semantics (null); a later event finds no waiter", async () => {
        const w = defineWorkflow("w", {
          trigger: manual(),
          run: async ({ step }) => {
            const a = await step.waitForEvent("go", { event: "go.now", timeout: "1d" });
            const b = await step.waitForEvent("forever", { event: "never.comes" });
            return { a, b };
          },
        });
        const s = setup([w], over());
        await s.ready();
        const wake = action(list(section(s.wf), "runs").rowActions, "wakeNow");
        const { id } = await s.wf.start("w", {});
        await s.settle();
        expect((await s.wf.getRun(id)).status).toBe("waiting");
        expect(String(await wake.run({ id }, ctx()))).toMatch(/woke/i);
        await s.settle();
        let run = await s.wf.getRun(id);
        expect(run.steps.find((x) => x.name === "go")).toMatchObject({ status: "completed", output: null });
        expect((await s.wf.emit("go.now", {})).resumed).toEqual([]);
        // A wait without a timeout can be woken too.
        expect(run.status).toBe("waiting");
        expect(String(await wake.run({ id }, ctx()))).toMatch(/woke/i);
        await s.settle();
        run = await s.wf.getRun(id);
        expect(run).toMatchObject({ status: "completed", output: { a: null, b: null } });
        s.clock.advance(2 * DAY);
        await s.mq.drain();
        expect((await s.wf.getRun(id)).status).toBe("completed");
        s.wf.stop();
      });

      test("an event that arrives before the woken run resumes still wins", async () => {
        const w = defineWorkflow("race", {
          trigger: manual(),
          run: async ({ step }) => await step.waitForEvent("go", { event: "go.now" }),
        });
        const s = setup([w], over());
        await s.ready();
        const wake = action(list(section(s.wf), "runs").rowActions, "wakeNow");
        const { id } = await s.wf.start("race", {});
        await s.settle();
        s.mq.pause!(); // hold the resume message
        expect(String(await wake.run({ id }, ctx()))).toMatch(/woke/i);
        await s.wf.emit("go.now", { n: 1 });
        s.mq.resume!();
        await s.settle();
        expect((await s.wf.getRun(id)).output).toMatchObject({ name: "go.now", data: { n: 1 } });
        s.wf.stop();
      });

      test("an approval wait is not woken: decide it instead", async () => {
        const w = defineWorkflow("appr", {
          trigger: manual(),
          run: async ({ step }) => await step.waitForApproval("ok", { approvers: { role: ["manager"] } }),
        });
        const s = setup([w], over());
        await s.ready();
        const wake = action(list(section(s.wf), "runs").rowActions, "wakeNow");
        const { id } = await s.wf.start("appr", {});
        await s.settle();
        await expect(attempt(() => wake.run({ id }, ctx()))).rejects.toMatchObject({ status: 409, fix: expect.stringContaining("approv") });
        expect((await s.wf.getRun(id)).status).toBe("waiting");
        s.wf.stop();
      });
    });
  }
});
