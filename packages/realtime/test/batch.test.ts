// patchBatchMs: state changes from messages and timers reach the members as at most one patch per
// window (the first in a quiet period at once). Fewer frames for real-time games at 20-60 Hz.
import { expect, test } from "bun:test";
import { FakeClock, applyPatch, createRoomInstance, defineRoom, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const arena = defineRoom("arena", {
  state: t.object({ pos: t.record(t.number()), hits: t.integer() }),
  client: { move: t.object({ x: t.number() }), bad: t.object({}) },
  init: () => ({ pos: {}, hits: 0 }),
  patchBatchMs: 50,
  presenceBatchMs: 0,
  rateLimit: false,
  onJoin: ({ room, player }) => {
    room.state.pos[player.id] = 0;
  },
  on: {
    move: ({ room, sender, msg }) => {
      room.state.pos[sender.id] = msg.x;
      room.state.hits++;
    },
    bad: ({ room }) => {
      room.state.hits = 999;
      throw new Error("nope");
    },
  },
});

function setup() {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(arena, { id: "a", clock, hooks: { onError() {} } });
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "A" });
  inst.connect(b, { name: "B" });
  clock.advance(100);
  a.take();
  b.take();
  const mirror = { b: undefined as any };
  mirror.b = b.frames.filter((f) => f.t === "state").at(-1).state;
  const say = (s: typeof a, type: string, data: unknown) => inst.receive(s, JSON.stringify({ t: "msg", type, data }));
  const view = () => {
    for (const f of b.take()) if (f.t === "patch") mirror.b = applyPatch(mirror.b, f.ops);
    return mirror.b;
  };
  return { clock, inst, a, b, say, view };
}

test("moves inside the window are coalesced into one patch; the first goes out at once", () => {
  const { clock, inst, a, b, say, view } = setup();
  say(a, "move", { x: 1 });
  expect(b.frames.filter((f) => f.t === "patch").length).toBeGreaterThan(0); // immediate
  const before = b.frames.length;
  for (let x = 2; x <= 20; x++) {
    clock.advance(1);
    say(a, "move", { x });
  }
  expect(b.frames.length).toBe(before); // held back inside the window
  clock.advance(50);
  const patches = b.frames.slice(before).filter((f) => f.t === "patch");
  expect(patches).toHaveLength(1);
  const me = a.frames.find((f) => f.t === "welcome").me.id;
  expect(view().pos[me]).toBe(20);
  expect(view().hits).toBe(20);
  expect(inst.describe().state.hits).toBe(20);
});

test("a failing handler inside the window rolls back only itself, not the batched moves before it", () => {
  const { clock, inst, a, say, view } = setup();
  say(a, "move", { x: 1 });
  clock.advance(1);
  say(a, "move", { x: 2 });
  say(a, "bad", {});
  expect(a.last("error").code).toBe("MIU_E_ROOM_HANDLER_FAILED");
  clock.advance(60);
  expect(inst.describe().state.hits).toBe(2);
  expect(view().hits).toBe(2);
});

test("a player joining inside the window gets the latest state, then the patches from there", () => {
  const { clock, inst, a, say } = setup();
  say(a, "move", { x: 1 });
  clock.advance(1);
  say(a, "move", { x: 2 });
  const c = fakeSocket();
  inst.connect(c, { name: "C" });
  const me = a.frames.find((f) => f.t === "welcome").me.id;
  const st = c.frames.find((f) => f.t === "state").state;
  expect(st.pos[me]).toBe(2);
  clock.advance(1);
  say(a, "move", { x: 3 });
  clock.advance(60);
  let doc = st;
  for (const f of c.frames) if (f.t === "patch") doc = applyPatch(doc, f.ops);
  expect(doc).toEqual(inst.describe().state);
});

test("events and direct sends flush pending patches first (ordering is kept)", () => {
  const inst = createRoomInstance(
    defineRoom("ev", {
      state: t.object({ n: t.integer() }),
      client: { inc: t.object({}) },
      init: () => ({ n: 0 }),
      patchBatchMs: 50,
      on: {
        inc: ({ room }) => {
          room.state.n++;
          if (room.state.n === 3) room.broadcast("three", { n: room.state.n });
        },
      },
    }),
    { id: "e", clock: new FakeClock(0) },
  );
  const a = fakeSocket();
  inst.connect(a, { name: "A" });
  a.take();
  for (let i = 0; i < 3; i++) inst.receive(a, JSON.stringify({ t: "msg", type: "inc", data: {} }));
  const out = a.take();
  const ev = out.findIndex((f) => f.t === "event");
  let doc = { n: 0 } as any;
  for (const f of out.slice(0, ev)) if (f.t === "patch") doc = applyPatch(doc, f.ops);
  expect(doc.n).toBe(3); // the patch with n = 3 arrived before the event
});

// ---- memory: rooms free seats as soon as players say goodbye ------------------------------------

test("a clean close (1000, client.close()) leaves at once; a dropped connection keeps the seat for the grace period", () => {
  const clock = new FakeClock(0);
  const left: string[] = [];
  const inst = createRoomInstance(
    defineRoom("bye", { state: t.object({}), init: () => ({}), onLeave: ({ player }) => void left.push(player.name) }),
    { id: "b", clock },
  );
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "A" });
  inst.connect(b, { name: "B" });
  inst.disconnect(a, 1000);
  expect(left).toEqual(["A"]);
  inst.disconnect(b, 1006);
  expect(left).toEqual(["A"]);
  expect(inst.inGrace).toBe(1);
  clock.advance(30_000);
  expect(left).toEqual(["A", "B"]);
});

test("the registry passes the close code: a finished game whose players all said bye is disposed after emptyMs, not grace + emptyMs", async () => {
  const { LocalRooms } = await import("../src/index.ts");
  const clock = new FakeClock(0);
  const reg = new LocalRooms([defineRoom("g", { state: t.object({}), init: () => ({}) })], { clock, emptyMs: 1_000 });
  const room = reg.open("g", "x")!;
  const a = fakeSocket();
  room.connect(a, { name: "A" });
  reg.disconnected(room, a, 1000);
  clock.advance(1_000);
  expect(reg.get("g", "x")).toBeUndefined();
});
