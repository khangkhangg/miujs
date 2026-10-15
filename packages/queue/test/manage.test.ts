// The admin management section: status, job and dead-letter lists, row actions, actions and
// settings, run against every adapter that can list (memory, sqlite, redis) and Cloudflare.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { miu, t, validate, type Context, type ManageAction, type ManageList, type ManageSection } from "miujs";
import { fakeRedis } from "../../cache/test/fake-redis.ts";
import { cloudflareQueue, defineJob, manualClock, memoryQueue, queue, redisQueue, schedule, sqliteQueue, type DurableQueue, type MemoryQueue } from "../src/index.ts";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 30);
const ctx = (env: Record<string, unknown> = {}) => ({ env }) as unknown as Context;
const settle = () => new Promise((r) => setTimeout(r, 5));
const iso = (ms: number) => new Date(ms).toISOString();
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);

function section(q: { manage?(): ManageSection[] }): ManageSection {
  const s = q.manage!();
  expect(s).toHaveLength(1);
  expect(s[0].id).toBe("queue");
  return s[0];
}
const list = (s: ManageSection, name: string): ManageList => {
  const l = s.lists?.find((x) => x.name === name);
  if (!l) throw new Error(`no list ${name}`);
  return l;
};
const action = (actions: ManageAction[] | undefined, name: string): ManageAction => {
  const a = actions?.find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
};
const stat = async (s: ManageSection, label: string, c = ctx()) => (await s.status!(c)).stats!.find((x) => x.label === label);

type Made = { adapter: MemoryQueue | DurableQueue; clock: ReturnType<typeof manualClock> };
const ADAPTERS: [string, () => Made][] = [
  ["memory", () => {
    const clock = manualClock(T0);
    return { clock, adapter: memoryQueue({ clock }) };
  }],
  ["sqlite", () => {
    const clock = manualClock(T0);
    return { clock, adapter: sqliteQueue(new Database(":memory:"), { clock }) };
  }],
  ["redis", () => {
    const clock = manualClock(T0);
    return { clock, adapter: redisQueue(fakeRedis({ now: clock.now }).client, { clock }) };
  }],
];

const ok = defineJob("send-welcome", { input: t.object({ to: t.string() }), run: () => {} });
const boom = defineJob("boom", {
  input: t.object({ resetToken: t.string(), n: t.integer() }),
  retries: 0,
  run: () => {
    throw new Error("smtp down");
  },
});

for (const [name, make] of ADAPTERS) {
  describe(`queue manage (${name})`, () => {
    async function setup(opts: { start?: boolean } = {}) {
      const m = make();
      const q = queue({ jobs: [ok, boom], adapter: m.adapter, schedules: [schedule("0 3 * * *", ok, { to: "cron@example.com" })] });
      const s = section(q);
      if (opts.start !== false) await miu({ logLevel: "silent", plugins: [q] }).ready();
      // Not started: durable queues run nothing, but the memory queue would, so hold it.
      else await action(s.actions, "pause").run({}, ctx());
      return { ...m, q, s };
    }

    test("status counts pending, delayed and dead jobs and lists jobs and schedules", async () => {
      const { q, s, adapter } = await setup({ start: false });
      await q.dispatch(ok, { to: "a@example.com" });
      await q.dispatch(ok, { to: "b@example.com" }, { delay: 60 });
      await settle();
      const st = await s.status!(ctx());
      const byLabel = Object.fromEntries(st.stats!.map((x) => [x.label, x.value]));
      expect(byLabel).toMatchObject({ Adapter: adapter.name, Pending: 1, Delayed: 1, Running: 0, "Dead letters": 0, Paused: true, Concurrency: 1 });
      const jobs = st.tables!.find((x) => x.title === "Jobs")!;
      expect(jobs.rows.map((r) => r.name)).toEqual(["send-welcome", "boom"]);
      const sch = st.tables!.find((x) => x.title === "Schedules")!;
      expect(sch.rows).toEqual([{ cron: "0 3 * * *", job: "send-welcome", lastRun: null }]);
      q.stop();
    });

    test("status records the last run of each job", async () => {
      const { q, s, adapter } = await setup();
      await q.dispatch(ok, { to: "a@example.com" });
      await q.dispatch(boom, { resetToken: "tok", n: 1 });
      await adapter.drain();
      const jobs = (await s.status!(ctx())).tables!.find((x) => x.title === "Jobs")!;
      const row = (n: string) => jobs.rows.find((r) => r.name === n)!;
      expect(row("send-welcome")).toMatchObject({ lastRun: iso(T0), lastResult: "ok" });
      expect(row("boom")).toMatchObject({ lastRun: iso(T0), lastResult: "failed: smtp down" });
      expect((await stat(s, "Dead letters"))?.value).toBe(1);
      expect((await stat(s, "Dead letters"))?.tone).toBe("critical");
      q.stop();
    });

    test("jobs list pages by state; delete removes a waiting job", async () => {
      const { q, s } = await setup({ start: false });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await q.dispatch(ok, { to: `${i}@example.com` }, { delay: 60 + i })).id);
      const now1 = (await q.dispatch(ok, { to: "now1@example.com" })).id;
      const now2 = (await q.dispatch(ok, { to: "now2@example.com" })).id;
      const jobs = list(s, "jobs");
      expect(jobs.idKey).toBe("id");
      expect(jobs.filters).toEqual([{ key: "state", label: "State", options: ["pending", "delayed", "running"] }]);
      const p1 = await jobs.list({ limit: 2, filters: { state: "delayed" } }, ctx());
      expect(p1.rows.map((r) => r.id)).toEqual(ids.slice(0, 2));
      expect(p1.rows[0]).toMatchObject({ job: "send-welcome", state: "delayed", attempt: 1, runAt: iso(T0 + 60_000) });
      expect(p1.next).toBeString();
      const p2 = await jobs.list({ limit: 2, cursor: p1.next, filters: { state: "delayed" } }, ctx());
      expect(p2.rows.map((r) => r.id)).toEqual([ids[2]]);
      expect(p2.next).toBeUndefined();
      const pending = await jobs.list({ limit: 10 }, ctx());
      expect(pending.rows.map((r) => [r.id, r.state])).toEqual([[now1, "pending"], [now2, "pending"]]); // next due first
      expect((await jobs.list({ limit: 2 }, ctx())).next).toBeUndefined(); // a full last page has no next

      const del = action(jobs.rowActions, "delete");
      expect(del.danger).toBe(true);
      expect(await del.run({ id: ids[0] }, ctx())).toMatch(/deleted/i);
      expect(await del.run({ id: ids[0] }, ctx())).toMatch(/not waiting/i); // idempotent
      expect((await jobs.list({ limit: 10, filters: { state: "delayed" } }, ctx())).rows).toHaveLength(2);
      q.stop();
    });

    test("jobs list shows running jobs", async () => {
      let release = () => {};
      const gate = defineJob("gate", { input: t.object({}), run: () => new Promise<void>((r) => (release = r)) });
      const m = make();
      const q = queue({ jobs: [gate], adapter: m.adapter });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      const { id } = await q.dispatch(gate, {});
      for (let i = 0; i < 5; i++) await settle();
      const rows = (await list(section(q), "jobs").list({ limit: 10, filters: { state: "running" } }, ctx())).rows;
      expect(rows).toEqual([{ id, job: "gate", state: "running", attempt: 1, runAt: null, input: "{}" }]);
      release();
      await m.adapter.drain();
      q.stop();
    });

    test("an unknown state filter and a bad cursor are rejected", async () => {
      const { q, s } = await setup({ start: false });
      const jobs = list(s, "jobs");
      await expect(attempt(() => jobs.list({ limit: 10, filters: { state: "weird" } }, ctx()))).rejects.toThrow(/state/);
      await expect(attempt(() => jobs.list({ limit: 10, cursor: "abc" }, ctx()))).rejects.toThrow(/cursor/);
      await expect(attempt(() => jobs.list({ limit: 10, cursor: "99999999" }, ctx()))).rejects.toThrow(/cursor/);
      await expect(attempt(() => list(s, "dead").list({ limit: 10, cursor: "-1" }, ctx()))).rejects.toThrow(/cursor/);
      q.stop();
    });

    test("dead letters: newest first, secrets redacted from the input preview, retry and delete", async () => {
      const { q, s, adapter } = await setup();
      const a = await q.dispatch(boom, { resetToken: "s3cr3t-reset", n: 1 });
      const b = await q.dispatch(boom, { resetToken: "s3cr3t-reset", n: 2 });
      await adapter.drain();
      const dead = list(s, "dead");
      const page = await dead.list({ limit: 10 }, ctx());
      expect(page.rows.map((r) => r.id)).toEqual([b.id, a.id]);
      expect((await dead.list({ limit: 2 }, ctx())).next).toBeUndefined();
      expect(page.rows[0]).toMatchObject({ job: "boom", attempts: 1, error: "smtp down", failedAt: iso(T0) });
      expect(JSON.stringify(page.rows)).not.toContain("s3cr3t");
      expect(page.rows[0].input).toContain('"n":2');

      const one = await dead.list({ limit: 1 }, ctx());
      expect(one.rows.map((r) => r.id)).toEqual([b.id]);
      expect((await dead.list({ limit: 1, cursor: one.next }, ctx())).rows.map((r) => r.id)).toEqual([a.id]);

      const retry = action(dead.rowActions, "retry");
      expect(await retry.run({ id: a.id }, ctx())).toMatch(/queued again/i);
      expect(await retry.run({ id: a.id }, ctx())).toMatch(/no dead letter/i);
      await adapter.drain(); // fails again
      expect((await dead.list({ limit: 10 }, ctx())).rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

      const del = action(dead.rowActions, "delete");
      expect(del.danger).toBe(true);
      expect(await del.run({ id: b.id }, ctx())).toMatch(/deleted/i);
      expect(await del.run({ id: b.id }, ctx())).toMatch(/no dead letter/i);
      expect((await dead.list({ limit: 10 }, ctx())).rows.map((r) => r.id)).toEqual([a.id]);
      q.stop();
    });

    test("pause stops this instance from starting jobs; resume continues", async () => {
      const seen: string[] = [];
      const track = defineJob("track", { input: t.object({ v: t.string() }), run: ({ input }) => void seen.push(input.v) });
      const m = make();
      const q = queue({ jobs: [track], adapter: m.adapter });
      await miu({ logLevel: "silent", plugins: [q] }).ready();
      const s = section(q);
      expect(await action(s.actions, "pause").run({}, ctx())).toMatch(/paused/i);
      expect(await action(s.actions, "pause").run({}, ctx())).toMatch(/already paused/i);
      expect((await stat(s, "Paused"))?.value).toBe(true);
      expect((await stat(s, "Paused"))?.tone).toBe("warning");
      await q.dispatch(track, { v: "x" });
      await settle();
      await settle();
      expect(seen).toEqual([]);
      expect(await action(s.actions, "resume").run({}, ctx())).toMatch(/resumed/i);
      expect(await action(s.actions, "resume").run({}, ctx())).toMatch(/not paused/i);
      await m.adapter.drain();
      expect(seen).toEqual(["x"]);
      q.stop();
    });

    test("settings: concurrency is read and applied at run time, and validated", async () => {
      const { q, s } = await setup();
      const set = s.settings!;
      expect(await set.get(ctx())).toEqual({ concurrency: 1 });
      expect(validate(set.schema, { concurrency: 0 }).ok).toBe(false);
      expect(validate(set.schema, { concurrency: 1.5 }).ok).toBe(false);
      expect(validate(set.schema, { concurrency: 1001 }).ok).toBe(false);
      expect(validate(set.schema, { concurrency: 4 }).ok).toBe(true);
      await set.set({ concurrency: 4 }, ctx());
      expect(await set.get(ctx())).toEqual({ concurrency: 4 });
      expect((q.inspect() as unknown as { concurrency: number }).concurrency).toBe(4);
      q.stop();
    });
  });
}

describe("queue manage: concurrency setting takes effect", () => {
  test("memory queue runs more jobs at once after raising concurrency", async () => {
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const slow = defineJob("slow", {
      input: t.object({}),
      run: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
      },
    });
    const mq = memoryQueue({ clock: manualClock(T0) });
    const q = queue({ jobs: [slow], adapter: mq });
    await miu({ logLevel: "silent", plugins: [q] }).ready();
    await q.manage!()[0].settings!.set({ concurrency: 3 }, ctx());
    for (let i = 0; i < 3; i++) await q.dispatch(slow, {});
    await settle();
    expect(peak).toBe(3);
    for (const g of gates) g();
    await mq.drain();
    q.stop();
  });
});

describe("queue manage: actions", () => {
  async function setup() {
    const mq = memoryQueue({ clock: manualClock(T0) });
    const seen: unknown[] = [];
    const rec = defineJob("rec", { input: t.object({ n: t.integer() }), run: ({ input }) => void seen.push(input) });
    const internal = defineJob("miu.internal", { input: t.object({}), run: () => {} });
    const q = queue({
      jobs: [rec, internal],
      adapter: mq,
      schedules: [schedule("0 3 * * *", rec, { n: 3 }), schedule("0 4 * * *", rec, { n: 4 }), schedule("*/5 * * * *", ok, { to: "x@example.com" })],
    });
    await miu({ logLevel: "silent", plugins: [q] }).ready();
    return { q, mq, seen, s: section(q) };
  }

  test("dispatch enqueues a job with JSON input (object or JSON text) and validates it", async () => {
    const { q, mq, seen, s } = await setup();
    const d = action(s.actions, "dispatch");
    expect(validate(d.input!, {}).ok).toBe(false);
    expect(validate(d.input!, { job: "rec", delay: -1 }).ok).toBe(false);
    expect(validate(d.input!, { job: "x".repeat(201) }).ok).toBe(false);
    const r = (await d.run({ job: "rec", input: { n: 1 } }, ctx())) as { id: string; message: string };
    expect(r.id).toBeString();
    expect(r.message).toMatch(/rec/);
    await d.run({ job: "rec", input: '{"n":2}' }, ctx());
    await mq.drain();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    await expect(attempt(() => d.run({ job: "rec", input: { n: "no" } }, ctx()))).rejects.toMatchObject({ code: "MIU_E_VALIDATION" });
    await expect(attempt(() => d.run({ job: "rec", input: "{not json" }, ctx()))).rejects.toThrow(/JSON/);
    await expect(attempt(() => d.run({ job: "nope", input: {} }, ctx()))).rejects.toMatchObject({ code: "MIU_E_QUEUE_UNKNOWN_JOB" });
    await expect(attempt(() => d.run({ job: "miu.internal", input: {} }, ctx()))).rejects.toThrow(/internal/);
    q.stop();
  });

  test("runSchedule dispatches a schedule's job with its input now", async () => {
    const { q, mq, seen, s } = await setup();
    const run = action(s.actions, "runSchedule");
    expect(validate(run.input!, {}).ok).toBe(false);
    await expect(attempt(() => run.run({ job: "rec" }, ctx()))).rejects.toThrow(/0 3 \* \* \*.*0 4 \* \* \*/);
    const r = (await run.run({ job: "rec", cron: "0 4 * * *" }, ctx())) as { id: string; message: string };
    expect(r.message).toMatch(/rec/);
    await mq.drain();
    expect(seen).toEqual([{ n: 4 }]);
    await expect(attempt(() => run.run({ job: "rec", cron: "1 1 * * *" }, ctx()))).rejects.toThrow(/No schedule/);
    await expect(attempt(() => run.run({ job: "ghost" }, ctx()))).rejects.toThrow(/No schedule/);
    q.stop();
  });

  test("the scheduled tick records the last run time per schedule", async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1, 2, 59, 30));
    const seen: unknown[] = [];
    const rec = defineJob("rec", { input: t.object({ n: t.integer() }), run: ({ input }) => void seen.push(input) });
    const mq = memoryQueue({ clock });
    const q = queue({ jobs: [rec], adapter: mq, schedules: [schedule("0 3 * * *", rec, { n: 3 })] });
    await miu({ logLevel: "silent", plugins: [q] }).ready();
    clock.advance(31_000);
    await mq.drain();
    expect(seen).toEqual([{ n: 3 }]);
    const sch = (await section(q).status!(ctx())).tables!.find((x) => x.title === "Schedules")!;
    expect(sch.rows[0]).toMatchObject({ cron: "0 3 * * *", job: "rec", lastRun: iso(Date.UTC(2026, 0, 1, 3, 0, 0)) });
    q.stop();
  });
});

describe("queue manage: Cloudflare Queues", () => {
  test("status says counts are unavailable instead of faking them; no lists, pause or settings", async () => {
    const sent: unknown[] = [];
    const binding = { send: async (b: unknown) => void sent.push(b) };
    const q = queue({ jobs: [ok], adapter: cloudflareQueue({ binding: "JOBS" }), schedules: [schedule("0 3 * * *", ok, { to: "c@example.com" })] });
    const s = section(q);
    const st = await s.status!(ctx({ JOBS: binding }));
    const pending = st.stats!.find((x) => x.label === "Pending")!;
    expect(pending.value).toBeNull();
    expect(pending.hint).toMatch(/Cloudflare/);
    expect(s.lists ?? []).toEqual([]);
    expect(s.settings).toBeUndefined();
    expect(s.actions!.map((a) => a.name).sort()).toEqual(["dispatch", "runSchedule"]);
    await action(s.actions, "runSchedule").run({ job: "send-welcome" }, ctx({ JOBS: binding }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ job: "send-welcome", input: { to: "c@example.com" } });
  });
});
