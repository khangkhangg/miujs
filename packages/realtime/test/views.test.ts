import { expect, test } from "bun:test";
import { FakeClock, applyPatch, createRoomInstance, defineRoom, t } from "../src/index.ts";
import { fakeSocket, type FakeSocket } from "./helpers.ts";

// A card table: every hand is in shared server state, but each player only sees their own.
const table = defineRoom("table", {
  state: t.object({ pot: t.number(), hands: t.record(t.array(t.string())) }),
  client: { draw: t.object({ card: t.string() }), bet: t.object({ n: t.number() }), whisper: t.object({ to: t.string() }) },
  init: () => ({ pot: 0, hands: {} }),
  view: (state, player) => ({
    pot: state.pot,
    mine: state.hands[player.id] ?? [],
    counts: Object.fromEntries(Object.entries(state.hands).map(([id, h]) => [id, h.length])),
  }),
  onJoin: ({ room, player }) => {
    if (player.role !== "spectator") room.state.hands[player.id] = [];
  },
  on: {
    draw: ({ room, sender, msg }) => {
      room.state.hands[sender.id] = [...room.state.hands[sender.id], msg.card];
    },
    bet: ({ room, msg }) => {
      room.state.pot += msg.n;
    },
    whisper: ({ room, sender, msg }) => {
      room.broadcast("psst", { from: sender.name }, { to: (p) => p.name === msg.to || p.role === "spectator" });
    },
  },
});

function setup() {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(table, { id: "T", clock });
  const [ann, bob] = [fakeSocket(), fakeSocket()];
  inst.connect(ann, { name: "Ann" });
  inst.connect(bob, { name: "Bob" });
  clock.advance(50); // let the presence window close
  const id = (s: FakeSocket) => s.last("welcome").me.id;
  const say = (s: FakeSocket, type: string, data: unknown) => inst.receive(s, JSON.stringify({ t: "msg", type, data }));
  return { clock, inst, ann, bob, id, say };
}

/** Rebuild what a client sees from its frames. */
function view(s: FakeSocket): any {
  let v: any;
  for (const f of s.frames) {
    if (f.t === "state") v = f.state;
    if (f.t === "patch") v = applyPatch(v, f.ops);
  }
  return v;
}

test("each player's full state is their own view", () => {
  const { ann, bob, id } = setup();
  expect(ann.last("state").state).toEqual({ pot: 0, mine: [], counts: { [id(ann)]: 0 } });
  expect(view(bob)).toEqual({ pot: 0, mine: [], counts: { [id(ann)]: 0, [id(bob)]: 0 } });
});

test("patches are computed per view: a private change only reaches its owner", () => {
  const { ann, bob, id, say } = setup();
  ann.take();
  bob.take();
  say(ann, "draw", { card: "A♠" });
  expect(ann.take()).toEqual([
    {
      t: "patch",
      ops: [
        { op: "replace", path: "/mine", value: ["A♠"] },
        { op: "replace", path: `/counts/${id(ann)}`, value: 1 },
      ],
    },
  ]);
  expect(bob.take()).toEqual([{ t: "patch", ops: [{ op: "replace", path: `/counts/${id(ann)}`, value: 1 }] }]);
  expect(JSON.stringify(bob.frames)).not.toContain("A♠");
});

test("a change that leaves a view unchanged sends that player nothing", () => {
  const inst = createRoomInstance(
    defineRoom("fog", {
      state: t.object({ x: t.number(), secretBase: t.number() }),
      client: { move: t.object({}) },
      init: () => ({ x: 0, secretBase: 0 }),
      view: (s) => ({ x: s.x }),
      on: { move: ({ room }) => void (room.state.secretBase += 1) },
    }),
    { id: "F", clock: new FakeClock() },
  );
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  inst.receive(a, JSON.stringify({ t: "msg", type: "move", data: {} }));
  expect(a.take()).toEqual([]);
});

test("shared changes reach everyone, each as a patch against their own view", () => {
  const { ann, bob, say } = setup();
  say(ann, "draw", { card: "K♥" });
  say(bob, "bet", { n: 5 });
  expect(ann.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/pot", value: 5 }] });
  expect(view(ann).mine).toEqual(["K♥"]);
  expect(view(bob)).toMatchObject({ pot: 5, mine: [] });
});

test("a resumed player gets their view as full state", () => {
  const { inst, ann, say } = setup();
  say(ann, "draw", { card: "Q♦" });
  inst.disconnect(ann);
  const again = fakeSocket();
  inst.connect(again, { resume: ann.last("welcome").resumeToken });
  expect(again.last("state").state.mine).toEqual(["Q♦"]);
});

test("broadcast({ to }) sends an event only to the players the filter picks", () => {
  const { inst, ann, bob, say } = setup();
  const tv = fakeSocket();
  inst.connect(tv, { name: "Tv", role: "spectator" });
  for (const s of [ann, bob, tv]) s.take();
  say(ann, "whisper", { to: "Bob" });
  expect(bob.take()).toEqual([{ t: "event", event: "psst", data: { from: "Ann" } }]);
  expect(tv.take()).toEqual([{ t: "event", event: "psst", data: { from: "Ann" } }]);
  expect(ann.take()).toEqual([]);
});

test("broadcast({ to, except }) applies both", () => {
  const { inst, ann, bob, id } = setup();
  ann.take();
  bob.take();
  inst.room.broadcast("x", 1, { to: () => true, except: id(ann) });
  expect(ann.take()).toEqual([]);
  expect(bob.take()).toEqual([{ t: "event", event: "x", data: 1 }]);
});

test("describe() (agents, MCP) still shows the full server state", () => {
  const { inst, ann, say } = setup();
  say(ann, "draw", { card: "2♣" });
  expect(Object.values(inst.describe().state.hands)).toContainEqual(["2♣"]);
});

test("a view may hand out parts of the state: in-place changes to them still reach every player", () => {
  const board = defineRoom("board", {
    state: t.object({ cells: t.object({ a: t.string(), b: t.string() }), meta: t.object({ turn: t.integer() }) }),
    client: { set: t.object({ cell: t.enum(["a", "b"] as const), v: t.string() }), turn: t.object({}) },
    init: () => ({ cells: { a: "", b: "" }, meta: { turn: 0 } }),
    // Returns references into the state (no copies): the engine must not let later changes
    // mutate what it remembers each player saw.
    view: (s, p) => (p.role === "host" ? s : { cells: s.cells, turn: s.meta.turn }),
    on: {
      set: ({ room, msg }) => void (room.state.cells[msg.cell] = msg.v),
      turn: ({ room }) => void room.state.meta.turn++,
    },
  });
  const clock = new FakeClock(0);
  const inst = createRoomInstance(board, { id: "B", clock });
  const [host, ann] = [fakeSocket(), fakeSocket()];
  inst.connect(host, { name: "Host" });
  clock.advance(100);
  inst.connect(ann, { name: "Ann" });
  const say = (s: FakeSocket, type: string, data: unknown = {}) => inst.receive(s, JSON.stringify({ t: "msg", type, data }));
  for (let i = 0; i < 3; i++) {
    say(ann, "set", { cell: "a", v: `x${i}` });
    say(host, "turn");
    say(host, "set", { cell: "b", v: `y${i}` });
  }
  clock.advance(100);
  expect(view(host)).toEqual(JSON.parse(JSON.stringify(inst.room.state)));
  expect(view(ann)).toEqual({ cells: { a: "x2", b: "y2" }, turn: 3 });
});
