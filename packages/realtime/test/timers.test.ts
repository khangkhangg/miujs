import { expect, test } from "bun:test";
import { FakeClock, createRoomInstance, defineRoom, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const bomb = defineRoom("bomb", {
  state: t.object({ booms: t.array(t.string()), n: t.number() }),
  client: { arm: t.object({ ms: t.number(), label: t.string() }), disarm: t.object({ id: t.string() }) },
  init: () => ({ booms: [], n: 0 }),
  timers: {
    boom: ({ room, data, now }) => {
      room.state.booms = [...room.state.booms, `${(data as { label: string }).label}@${now}`];
    },
    fail: ({ room }) => {
      room.state.n = 99;
      throw new Error("timer kaboom");
    },
  },
  on: {
    arm: ({ room, msg }) => {
      room.schedule("boom", msg.ms, { label: msg.label });
    },
    disarm: ({ room, msg }) => {
      room.cancel(msg.id);
    },
  },
});

function say(inst: any, s: any, type: string, data: unknown) {
  return inst.receive(s, JSON.stringify({ t: "msg", type, data }));
}

test("schedule() runs the named handler with its data after the delay and flushes state", () => {
  const clock = new FakeClock(1_000);
  const inst = createRoomInstance(bomb, { id: "B", clock });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  say(inst, a, "arm", { ms: 500, label: "x" });
  clock.advance(499);
  expect(inst.room.state.booms).toEqual([]);
  clock.advance(1);
  expect(inst.room.state.booms).toEqual(["x@1500"]);
  expect(a.take()).toEqual([{ t: "patch", ops: [{ op: "replace", path: "/booms", value: ["x@1500"] }] }]);
});

test("timers fire in due order, including ones scheduled by other timers", () => {
  const clock = new FakeClock(0);
  const chain = defineRoom("chain", {
    state: t.object({ seen: t.array(t.number()) }),
    init: () => ({ seen: [] }),
    timers: {
      step: ({ room, now }) => {
        room.state.seen = [...room.state.seen, now];
        if (room.state.seen.length < 3) room.schedule("step", 10);
      },
    },
  });
  const inst = createRoomInstance(chain, { id: "C", clock });
  inst.room.schedule("step", 30);
  inst.room.schedule("step", 5);
  clock.advance(100);
  expect(inst.room.state.seen).toEqual([5, 15, 25, 30]);
});

test("schedule() returns an id; cancel(id) stops the timer and reports whether it existed", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(bomb, { id: "B", clock });
  const id = inst.room.schedule("boom", 100, { label: "a" });
  expect(typeof id).toBe("string");
  expect(inst.room.cancel(id)).toBe(true);
  expect(inst.room.cancel(id)).toBe(false);
  clock.advance(1_000);
  expect(inst.room.state.booms).toEqual([]);
  expect(clock.pending).toBe(0);
});

test("scheduling an undeclared timer is a MiuError that names the declared ones", () => {
  const inst = createRoomInstance(bomb, { id: "B", clock: new FakeClock() });
  let err: any;
  try {
    inst.room.schedule("nope", 10);
  } catch (e) {
    err = e;
  }
  expect(err?.code).toBe("MIU_E_ROOM_TIMER_UNKNOWN");
  expect(err.fix).toContain("boom");
});

test("a failing timer handler is logged, rolled back, and does not stop later timers", () => {
  const clock = new FakeClock(0);
  const logged: unknown[] = [];
  const inst = createRoomInstance(bomb, { id: "B", clock, hooks: { onError: (e) => logged.push(e) } });
  inst.room.schedule("fail", 10);
  inst.room.schedule("boom", 10, { label: "after" });
  clock.advance(10);
  expect(String(logged[0])).toContain("timer kaboom");
  expect(inst.room.state).toEqual({ booms: ["after@10"], n: 0 });
});

test("named timers are part of the snapshot and fire at their original time after a restore", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(bomb, { id: "B", clock });
  inst.room.schedule("boom", 1_000, { label: "late" });
  clock.advance(400);
  const snap = JSON.parse(JSON.stringify(inst.snapshot()));
  expect(snap.timers).toEqual([{ id: expect.any(String), at: 1_000, name: "boom", data: { label: "late" } }]);
  inst.close();

  const copy = createRoomInstance(bomb, { id: "B", clock, restore: snap });
  clock.advance(599);
  expect(copy.room.state.booms).toEqual([]);
  clock.advance(1);
  expect(copy.room.state.booms).toEqual(["late@1000"]);
});

test("close() cancels named timers", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(bomb, { id: "B", clock });
  inst.room.schedule("boom", 10, { label: "x" });
  inst.close();
  expect(clock.pending).toBe(0);
});

// ---- durable mode (Durable Object alarms drive the clock) ----------------------------------

test("durable rooms never touch the clock's timers: the transport reads nextDue() and calls runDue()", async () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(bomb, { id: "B", clock, durable: true });
  expect(inst.nextDue()).toBeNull();
  inst.room.schedule("boom", 300, { label: "b" });
  inst.room.schedule("boom", 100, { label: "a" });
  expect(clock.pending).toBe(0);
  expect(inst.nextDue()).toBe(100);
  clock.advance(100);
  expect(inst.room.state.booms).toEqual([]); // nothing fires by itself
  await inst.runDue();
  expect(inst.room.state.booms).toEqual(["a@100"]);
  expect(inst.nextDue()).toBe(300);
  clock.advance(500);
  await inst.runDue();
  expect(inst.room.state.booms).toEqual(["a@100", "b@600"]);
  expect(inst.nextDue()).toBeNull();
});

test("after() and tick() on a durable room throw a MiuError pointing to schedule()", () => {
  const inst = createRoomInstance(bomb, { id: "B", clock: new FakeClock(), durable: true });
  for (const call of [() => inst.room.after(10, () => {}), () => inst.room.tick(10, () => {})]) {
    let err: any;
    try {
      call();
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_ROOM_TIMER_NOT_DURABLE");
    expect(err.fix).toContain("schedule(");
  }
});

test("the reconnect grace period is a due time too, and survives a restore", async () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(bomb, { id: "B", clock, durable: true });
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.connect(b, { name: "Bob" });
  clock.advance(1_000);
  inst.disconnect(b); // Bob's seat is kept until 31 000
  expect(inst.nextDue()).toBe(31_000);
  clock.advance(10_000);
  const snap = JSON.parse(JSON.stringify(inst.snapshot()));

  clock.advance(10_000); // the object was evicted for a while
  const woken = createRoomInstance(bomb, { id: "B", clock, durable: true, restore: snap });
  woken.attach(fakeSocket(), a.last("welcome").me.id); // Ann's socket survived hibernation
  expect(woken.nextDue()).toBe(31_000);
  clock.advance(9_999);
  await woken.runDue();
  expect(woken.room.players.map((p) => p.name)).toEqual(["Ann", "Bob"]);
  clock.advance(1);
  await woken.runDue();
  expect(woken.room.players.map((p) => p.name)).toEqual(["Ann"]);
  expect(woken.nextDue()).toBeNull();
});

test("players connected at snapshot time but not re-attached get a fresh grace period", async () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(bomb, { id: "B", clock, durable: true });
  inst.connect(fakeSocket(), { name: "Ann" });
  const snap = JSON.parse(JSON.stringify(inst.snapshot()));
  clock.advance(5_000);
  const woken = createRoomInstance(bomb, { id: "B", clock, durable: true, restore: snap });
  expect(woken.nextDue()).toBe(35_000);
});
