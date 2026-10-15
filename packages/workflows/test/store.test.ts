import { describe, expect, test } from "bun:test";
import { d1, sqlite } from "@miujs/db";
import { dbRunStore, memoryRunStore, workflowMigrations, type RunRecord, type RunStore } from "../src/index.ts";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    workflow: "wf",
    status: "queued",
    input: { a: 1 },
    output: null,
    error: null,
    trigger: { type: "manual" },
    concurrencyKey: null,
    token: "t1",
    leaseUntil: null,
    wakeAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    finishedAt: null,
    ...over,
  };
}

const stores: [string, () => RunStore][] = [
  ["memoryRunStore", () => memoryRunStore()],
  ["dbRunStore(sqlite)", () => dbRunStore(sqlite())],
];

for (const [label, make] of stores) {
  describe(`${label} contract`, () => {
    test("create, get and update runs; values are copies", async () => {
      const s = make();
      const r = run();
      await s.createRun(r);
      r.input = "mutated";
      const got = await s.getRun("r1");
      expect(got).toEqual(run());
      await s.updateRun("r1", { status: "completed", output: { ok: true }, error: { message: "x", step: "s" }, updatedAt: 2000 });
      expect(await s.getRun("r1")).toMatchObject({ status: "completed", output: { ok: true }, error: { message: "x", step: "s" }, updatedAt: 2000, input: { a: 1 } });
      expect(await s.getRun("nope")).toBeNull();
    });

    test("casRun swaps only when the token matches and the lease is free", async () => {
      const s = make();
      await s.createRun(run());
      expect(await s.casRun("r1", { token: "other" }, { status: "running" })).toBe(false);
      expect(await s.casRun("r1", { token: "t1", leaseFreeAt: 5000 }, { status: "running", leaseUntil: 9000 })).toBe(true);
      // Leased until 9000: a second claimer at 6000 loses, one at 9000 wins.
      expect(await s.casRun("r1", { token: "t1", leaseFreeAt: 6000 }, { leaseUntil: 12000 })).toBe(false);
      expect(await s.casRun("r1", { token: "t1", leaseFreeAt: 9000 }, { leaseUntil: 12000 })).toBe(true);
      // Without leaseFreeAt only the token matters; null tokens match null.
      expect(await s.casRun("r1", { token: "t1" }, { token: null, leaseUntil: null })).toBe(true);
      expect(await s.casRun("r1", { token: null }, { token: "t2" })).toBe(true);
      expect((await s.getRun("r1"))!.token).toBe("t2");
    });

    test("listRuns filters by workflow, status and concurrency key, newest first, with limit and cursor", async () => {
      const s = make();
      await s.createRun(run({ id: "a", createdAt: 1, status: "completed", concurrencyKey: "k1" }));
      await s.createRun(run({ id: "b", createdAt: 2, status: "failed" }));
      await s.createRun(run({ id: "c", createdAt: 3, workflow: "other", status: "running", concurrencyKey: "k1" }));
      await s.createRun(run({ id: "d", createdAt: 4, status: "waiting", concurrencyKey: "k1" }));
      const ids = async (f: Parameters<RunStore["listRuns"]>[0]) => (await s.listRuns(f)).map((r) => r.id);
      expect(await ids({})).toEqual(["d", "c", "b", "a"]);
      expect(await ids({ workflow: "wf" })).toEqual(["d", "b", "a"]);
      expect(await ids({ status: "failed" })).toEqual(["b"]);
      expect(await ids({ status: ["completed", "waiting"] })).toEqual(["d", "a"]);
      expect(await ids({ workflow: "wf", concurrencyKey: "k1" })).toEqual(["d", "a"]);
      expect(await ids({ limit: 2 })).toEqual(["d", "c"]);
      expect(await ids({ before: 3 })).toEqual(["b", "a"]);
      expect(await ids({ order: "asc", limit: 2 })).toEqual(["a", "b"]);
    });

    test("steps upsert by (run, name) and come back in seq order", async () => {
      const s = make();
      await s.saveStep({ runId: "r1", name: "b", seq: 1, kind: "sleep", status: "sleeping", output: null, error: null, attempts: 0, wakeAt: 50, startedAt: 1, updatedAt: 1 });
      await s.saveStep({ runId: "r1", name: "a", seq: 0, kind: "run", status: "retrying", output: null, error: { message: "boom" }, attempts: 1, wakeAt: 10, startedAt: 1, updatedAt: 1 });
      await s.saveStep({ runId: "r1", name: "a", seq: 0, kind: "run", status: "completed", output: { n: [1, 2] }, error: null, attempts: 2, wakeAt: null, startedAt: 1, updatedAt: 2 });
      await s.saveStep({ runId: "r2", name: "a", seq: 0, kind: "run", status: "completed", output: 1, error: null, attempts: 1, wakeAt: null, startedAt: 1, updatedAt: 1 });
      const steps = await s.getSteps("r1");
      expect(steps.map((x) => [x.name, x.status])).toEqual([
        ["a", "completed"],
        ["b", "sleeping"],
      ]);
      expect(steps[0]).toMatchObject({ output: { n: [1, 2] }, attempts: 2, error: null, wakeAt: null });
    });

    test("undefined step output round-trips as undefined", async () => {
      const s = make();
      await s.saveStep({ runId: "r1", name: "a", seq: 0, kind: "run", status: "completed", output: undefined, error: null, attempts: 1, wakeAt: null, startedAt: 1, updatedAt: 1 });
      expect((await s.getSteps("r1"))[0].output).toBeUndefined();
    });

    test("waiters: find open ones by event, resolve once, delete by run", async () => {
      const s = make();
      await s.addWaiter({ id: "w1", runId: "r1", step: "reply", kind: "event", event: "email.replied", match: { "data.id": "c1" }, approvers: null, expiresAt: 100, resolution: null, createdAt: 1 });
      await s.addWaiter({ id: "w2", runId: "r2", step: "ok", kind: "approval", event: "workflow.approval", match: null, approvers: { role: ["manager"] }, expiresAt: null, resolution: null, createdAt: 2 });
      expect((await s.openWaiters("email.replied")).map((w) => w.id)).toEqual(["w1"]);
      expect(await s.openWaiters("nothing")).toEqual([]);
      expect(await s.getWaiter("r2", "ok")).toMatchObject({ id: "w2", approvers: { role: ["manager"] } });
      expect(await s.resolveWaiter("w1", { value: { data: { id: "c1" } } })).toBe(true);
      expect(await s.resolveWaiter("w1", { value: "again" })).toBe(false);
      expect((await s.getWaiter("r1", "reply"))!.resolution).toEqual({ value: { data: { id: "c1" } } });
      expect(await s.openWaiters("email.replied")).toEqual([]);
      await s.deleteWaiters("r1");
      expect(await s.getWaiter("r1", "reply")).toBeNull();
      expect(await s.getWaiter("r2", "ok")).not.toBeNull();
      await s.deleteWaiters("r2", "ok");
      expect(await s.getWaiter("r2", "ok")).toBeNull();
    });

    test("recordEvent de-duplicates by idempotency key", async () => {
      const s = make();
      const first = await s.recordEvent({ id: "e1", name: "x", data: { a: 1 }, idempotencyKey: "k", createdAt: 1 });
      expect(first).toEqual({ duplicate: false, event: { id: "e1", name: "x", data: { a: 1 }, idempotencyKey: "k", createdAt: 1 } });
      const again = await s.recordEvent({ id: "e2", name: "x", data: { a: 2 }, idempotencyKey: "k", createdAt: 2 });
      expect(again.duplicate).toBe(true);
      expect(again.event.id).toBe("e1");
      expect((await s.recordEvent({ id: "e3", name: "x", data: null, idempotencyKey: null, createdAt: 3 })).duplicate).toBe(false);
      expect((await s.recordEvent({ id: "e4", name: "x", data: null, idempotencyKey: null, createdAt: 3 })).duplicate).toBe(false);
    });
  });
}

describe("dbRunStore", () => {
  test("creates its tables through migrations, once", async () => {
    const database = sqlite();
    const s = dbRunStore(database);
    await s.getRun("x");
    const { results } = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["workflow_runs", "workflow_steps", "workflow_waiters", "workflow_events"]) expect(names).toContain(t);
    expect(workflowMigrations.map((m) => m.id)[0]).toMatch(/^workflows_/);
    const applied = await database.prepare("SELECT id FROM _miu_migrations").all<{ id: string }>();
    expect(applied.results.length).toBe(workflowMigrations.length);
  });

  test("resolves a D1 binding per env", async () => {
    const DB = sqlite();
    const s = dbRunStore(d1("DB"));
    const bound = s.forEnv!({ DB });
    await bound.createRun(run());
    expect((await bound.getRun("r1"))!.id).toBe("r1");
    expect(() => s.forEnv!({})).toThrow("DB");
    expect(s.describe()).toEqual({ adapter: "db", database: { adapter: "d1", binding: "DB" } });
  });
});
