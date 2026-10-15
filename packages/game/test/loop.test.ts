import { expect, test } from "bun:test";
import { FakeClock, RoomInstance, defineRoom, t } from "@miujs/realtime";
import { acceptInput, ackedSeqs, createInputState, fixedStep, predictor, processInputs, snapshotInterpolation, lerpState } from "../src/loop.ts";

// ---- fixedStep ---------------------------------------------------------------------------------

function loopRoom(opts: { hz?: number; maxCatchUp?: number; stopAt?: number } = {}) {
  const seen: { tick: number; dt: number; now: number }[] = [];
  const loop = fixedStep.define("step", {
    hz: opts.hz ?? 10,
    maxCatchUp: opts.maxCatchUp,
    update: ({ room, dt, tick, now }) => {
      seen.push({ tick, dt, now });
      room.state.ticks = tick;
      if (opts.stopAt !== undefined && tick >= opts.stopAt) return false;
    },
  });
  const type = defineRoom("loopy", { state: t.object({ ticks: t.number() }), init: () => ({ ticks: 0 }), timers: { ...loop.timers } });
  return { loop, type, seen };
}

test("fixedStep.define runs update hz times per second via room.schedule, with a fixed dt", async () => {
  const { loop, type, seen } = loopRoom();
  const clock = new FakeClock(0);
  const inst = new RoomInstance(type, { id: "r", clock });
  await inst.update((room) => loop.start(room));
  clock.advance(1_000);
  await Promise.resolve();
  expect(inst.describe().state.ticks).toBe(10);
  expect(seen.map((s) => s.dt)).toEqual(Array(10).fill(100));
  expect(seen.map((s) => s.now)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  expect(inst.snapshot().timers).toEqual([expect.objectContaining({ name: "step", at: 1100, data: { tick: 10, at: 1100, step: 100 } })]);
});

test("on a durable room a late alarm catches up missed steps, capped by maxCatchUp", async () => {
  const { loop, type, seen } = loopRoom({ maxCatchUp: 3 });
  const clock = new FakeClock(0);
  const inst = new RoomInstance(type, { id: "r", clock, durable: true });
  await inst.update((room) => loop.start(room));
  clock.advance(350);
  await inst.runDue();
  expect(seen.map((s) => s.now)).toEqual([100, 200, 300]);
  expect(inst.nextDue()).toBe(400);
  clock.advance(10_000); // the object slept a long time: run 3 steps, drop the rest, keep the cadence
  await inst.runDue();
  expect(seen.map((s) => s.tick)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(inst.nextDue()).toBe(10_400);
});

test("returning false from update stops the loop; stop(room) cancels it; start twice is a no-op", async () => {
  const a = loopRoom({ stopAt: 3 });
  const clock = new FakeClock(0);
  const inst = new RoomInstance(a.type, { id: "r", clock });
  await inst.update((room) => a.loop.start(room));
  clock.advance(1_000);
  expect(a.seen.map((s) => s.tick)).toEqual([1, 2, 3]);
  expect(inst.snapshot().timers).toEqual([]);

  const b = loopRoom();
  const inst2 = new RoomInstance(b.type, { id: "r2", clock });
  await inst2.update((room) => {
    b.loop.start(room);
    b.loop.start(room);
  });
  clock.advance(250);
  await inst2.update((room) => void expect(b.loop.stop(room)).toBe(true));
  clock.advance(1_000);
  expect(b.seen.map((s) => s.tick)).toEqual([1, 2]);
});

test("fixedStep(room, hz, update) works on local rooms and refuses durable ones with a fix", async () => {
  const type = defineRoom("loose", { state: t.object({ n: t.number() }), init: () => ({ n: 0 }) });
  const clock = new FakeClock(0);
  const inst = new RoomInstance(type, { id: "r", clock });
  let stop!: () => void;
  await inst.update((room) => {
    stop = fixedStep(room, 20, ({ room, dt }) => {
      room.state.n += dt;
    });
  });
  clock.advance(200);
  expect(inst.describe().state.n).toBe(200);
  stop();
  clock.advance(200);
  expect(inst.describe().state.n).toBe(200);
  const durable = new RoomInstance(type, { id: "d", clock, durable: true });
  let code = "";
  await durable.update((room) => {
    try {
      fixedStep(room, 20, () => {});
    } catch (e: any) {
      code = e.code;
    }
  });
  expect(code).toBe("MIU_E_GAME_LOOP_NOT_DURABLE");
});

test("fixedStep.define validates hz and name", () => {
  expect(() => fixedStep.define("x", { hz: 0, update: () => {} })).toThrow(/hz/);
  expect(() => fixedStep.define("x", { hz: 1000, update: () => {} })).toThrow(/hz/);
});

// ---- snapshot interpolation ----------------------------------------------------------------------

test("lerpState interpolates numbers deeply and keeps the rest from the older snapshot", () => {
  const a = { units: { u1: { x: 0, y: 10, name: "a" } }, arr: [0, 10], phase: "play" };
  const b = { units: { u1: { x: 10, y: 20, name: "b" }, u2: { x: 5, y: 5, name: "c" } }, arr: [10, 20], phase: "end" };
  expect(lerpState<unknown>(a, b, 0.25)).toEqual({ units: { u1: { x: 2.5, y: 12.5, name: "a" }, u2: { x: 5, y: 5, name: "c" } }, arr: [2.5, 12.5], phase: "play" });
});

test("angles listed in options take the shortest way round", () => {
  const r = lerpState({ rot: 3.0 }, { rot: -3.0 }, 0.5, { angles: ["rot"] }) as { rot: number };
  expect(Math.abs(Math.abs(r.rot) - Math.PI)).toBeLessThan(0.01);
});

test("snapshotInterpolation renders delayMs in the past between buffered snapshots", () => {
  const si = snapshotInterpolation<{ x: number }>({ delayMs: 100 });
  expect(si.sample(0)).toBeUndefined();
  si.push(1000, { x: 0 });
  expect(si.sample(1050)).toEqual({ x: 0 }); // before the second snapshot: hold the first
  si.push(1100, { x: 10 });
  si.push(1200, { x: 30 });
  expect(si.sample(1150)).toEqual({ x: 5 });
  expect(si.sample(1250)).toEqual({ x: 20 });
  expect(si.sample(5000)).toEqual({ x: 30 }); // no extrapolation past the newest
  si.push(1150, { x: 999 }); // out-of-order snapshots are ignored
  expect(si.sample(1250)).toEqual({ x: 20 });
  expect(si.size).toBe(3);
});

test("snapshotInterpolation keeps at most maxSnapshots", () => {
  const si = snapshotInterpolation<{ x: number }>({ delayMs: 0, maxSnapshots: 3 });
  for (let i = 0; i < 10; i++) si.push(i * 10, { x: i });
  expect(si.size).toBe(3);
});

// ---- inputs ----------------------------------------------------------------------------------------

test("server inputs: in order, duplicates and stale seqs dropped, last seq acked", () => {
  const inputs = createInputState();
  expect(acceptInput(inputs, "p1", 2, { dx: 2 })).toBe("accepted");
  expect(acceptInput(inputs, "p1", 1, { dx: 1 })).toBe("accepted");
  expect(acceptInput(inputs, "p1", 1, { dx: 1 })).toBe("duplicate");
  expect(acceptInput(inputs, "p2", 7, { dx: 7 })).toBe("accepted");
  const applied: [string, number, unknown][] = [];
  expect(processInputs(inputs, (player, input, seq) => applied.push([player, seq, input]))).toBe(3);
  expect(applied).toEqual([["p1", 1, { dx: 1 }], ["p1", 2, { dx: 2 }], ["p2", 7, { dx: 7 }]]);
  expect(ackedSeqs(inputs)).toEqual({ p1: 2, p2: 7 });
  expect(acceptInput(inputs, "p1", 2, { dx: 2 })).toBe("stale");
  expect(acceptInput(inputs, "p1", -1, {})).toBe("invalid");
  expect(acceptInput(inputs, "p1", 1.5, {})).toBe("invalid");
  expect(JSON.parse(JSON.stringify(inputs))).toEqual(inputs); // plain JSON: keep it in room.secret
});

test("server inputs: a full buffer refuses more (overflow) and maxPerStep spreads work", () => {
  const inputs = createInputState({ maxBuffered: 3 });
  for (let s = 1; s <= 3; s++) acceptInput(inputs, "p", s, s);
  expect(acceptInput(inputs, "p", 4, 4)).toBe("overflow");
  const seen: number[] = [];
  processInputs(inputs, (_p, input) => seen.push(input as number), { maxPerStep: 2 });
  expect(seen).toEqual([1, 2]);
  processInputs(inputs, (_p, input) => seen.push(input as number), { maxPerStep: 2 });
  expect(seen).toEqual([1, 2, 3]);
});

test("client predictor: applies inputs at once, then replays the unacked ones on server state", () => {
  const p = predictor<{ x: number }, { dx: number }>({ initial: { x: 0 }, apply: (s, i) => ({ x: s.x + i.dx }) });
  expect(p.input({ dx: 1 })).toEqual({ seq: 1, input: { dx: 1 } });
  p.input({ dx: 2 });
  p.input({ dx: 3 });
  expect(p.state).toEqual({ x: 6 });
  expect(p.pending).toBe(3);
  // Server processed seq 1 but also applied a knock-back (x = 0 instead of 1).
  expect(p.reconcile({ x: 0 }, 1)).toEqual({ x: 5 });
  expect(p.pending).toBe(2);
  expect(p.reconcile({ x: 5 }, 3)).toEqual({ x: 5 });
  expect(p.pending).toBe(0);
});
