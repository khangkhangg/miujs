// Join/leave storms: the state changes that joins and leaves cause (`onJoin` / `onLeave`) are
// coalesced into one patch per `presenceBatchMs` window, so seating N players costs O(N) frames
// per window instead of one patch to everyone per join (O(N²)).
import { expect, test } from "bun:test";
import { FakeClock, applyPatch, createRoomInstance, defineRoom, t, type RoomType } from "../src/index.ts";
import { fakeSocket, type FakeSocket } from "./helpers.ts";

const lobby = (opts: { presenceBatchMs?: number; view?: boolean } = {}) =>
  defineRoom("lobby", {
    state: t.object({ names: t.record(t.string()), count: t.number() }),
    client: { inc: t.object({}), boom: t.object({}) },
    init: () => ({ names: {}, count: 0 }),
    presenceBatchMs: opts.presenceBatchMs,
    view: opts.view ? (s, p) => ({ me: s.names[p.id] ?? null, count: s.count, n: Object.keys(s.names).length }) : undefined,
    onJoin: ({ room, player }) => {
      room.state.names[player.id] = player.name;
    },
    onLeave: ({ room, player }) => {
      delete room.state.names[player.id];
    },
    on: {
      inc: ({ room }) => {
        room.state.count++;
      },
      boom: ({ room }) => {
        room.state.count = 999;
        throw new Error("kaboom");
      },
    },
  });

/** A client that keeps its own copy of the state from `state` + `patch` frames. */
interface Client extends FakeSocket {
  doc: any;
  patches: number;
}
function client(): Client {
  const s = fakeSocket() as Client;
  s.patches = 0;
  const send = s.send;
  s.send = (m) => {
    send(m);
    const f = s.frames[s.frames.length - 1];
    if (f.t === "state") s.doc = f.state;
    if (f.t === "patch") {
      s.patches++;
      s.doc = applyPatch(s.doc, f.ops);
    }
  };
  return s;
}

function setup(def: RoomType) {
  const clock = new FakeClock(1_000);
  const errs: unknown[] = [];
  const inst = createRoomInstance(def, { id: "L", clock, hooks: { onError: (e) => errs.push(e) } });
  const join = (name: string) => {
    const c = client();
    inst.connect(c, { name });
    return c;
  };
  const say = (c: Client, type: string) => inst.receive(c, JSON.stringify({ t: "msg", type, data: {} }));
  return { clock, inst, join, say, errs };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("a join storm sends members one coalesced patch per window, not one per join", () => {
  const { clock, inst, join } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const others: Client[] = [];
  for (let i = 0; i < 40; i++) others.push(join(`p${i}`));
  // Nobody already seated heard about the 40 joins yet...
  expect(host.patches).toBe(0);
  // ...but every joiner's first state already includes themselves.
  for (const c of others) expect(c.doc.names[c.last("welcome").me.id]).toBe(c.last("welcome").me.name);
  clock.advance(50);
  expect(host.patches).toBe(1);
  // Everyone converges on the server state, with at most one catch-up patch each.
  for (const c of [host, ...others]) {
    expect(c.doc).toEqual(plain(inst.room.state));
    expect(c.patches).toBeLessThanOrEqual(1);
  }
  const frames = [host, ...others].reduce((n, c) => n + c.frames.length, 0);
  expect(frames).toBeLessThan(41 * 3 + 1); // welcome + state + ≤1 patch each
});

test("sparse joins (further apart than the window) still go out at once", () => {
  const { clock, join } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  clock.advance(60);
  const ann = join("Ann");
  expect(host.doc.names[ann.last("welcome").me.id]).toBe("Ann");
  clock.advance(60);
  const bob = join("Bob");
  expect(host.patches).toBe(2);
  expect(ann.doc.names[bob.last("welcome").me.id]).toBe("Bob");
});

test("presenceBatchMs: 0 patches everyone on every join (the old behaviour)", () => {
  const { join } = setup(lobby({ presenceBatchMs: 0 }));
  const host = join("Host");
  join("Ann");
  join("Bob");
  expect(host.patches).toBe(2);
  expect(Object.keys(host.doc.names)).toHaveLength(3);
});

test("the default batches join storms (50 ms)", () => {
  const { clock, join } = setup(lobby());
  const host = join("Host");
  join("Ann");
  join("Bob");
  expect(host.patches).toBe(0);
  clock.advance(49);
  expect(host.patches).toBe(0);
  clock.advance(1);
  expect(host.patches).toBe(1);
  expect(Object.keys(host.doc.names)).toHaveLength(3);
});

test("a message inside the window flushes pending presence with it, in order", () => {
  const { inst, join, say } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const ann = join("Ann");
  const bob = join("Bob");
  say(ann, "inc");
  for (const c of [host, ann, bob]) expect(c.doc).toEqual(plain(inst.room.state));
  expect(host.patches).toBe(1);
  expect(inst.room.state.count).toBe(1);
});

test("an event inside the window arrives after the pending presence patch", () => {
  const { inst, join } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const ann = join("Ann");
  inst.room.broadcast("hello", 1);
  const kinds = host.take().map((f) => f.t);
  expect(kinds.slice(-2)).toEqual(["patch", "event"]);
  expect(host.doc.names[ann.last("welcome").me.id]).toBe("Ann");
});

test("a failing handler inside the window does not roll back a pending join", () => {
  const { clock, inst, join, say, errs } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const ann = join("Ann");
  say(host, "boom");
  expect(errs).toHaveLength(1);
  expect(inst.room.state.count).toBe(0);
  expect(inst.room.state.names[ann.last("welcome").me.id]).toBe("Ann");
  clock.advance(50);
  for (const c of [host, ann]) expect(c.doc).toEqual(plain(inst.room.state));
});

test("leaves are batched too and members converge", () => {
  const { clock, inst, join } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const cs = [join("a"), join("b"), join("c")];
  clock.advance(50);
  host.take();
  for (const c of cs) inst.room.kick(c.last("welcome").me.id);
  expect(host.take().filter((f) => f.t === "patch").length).toBeLessThanOrEqual(1);
  clock.advance(50);
  expect(host.doc).toEqual(plain(inst.room.state));
  expect(Object.keys(host.doc.names)).toHaveLength(1);
});

test("a joiner is caught up from the state it was sent, even when an earlier change is undone", () => {
  const { clock, inst, join } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const ann = join("Ann"); // inside the window
  const bob = join("Bob"); // Bob's first state includes Ann
  inst.room.kick(ann.last("welcome").me.id); // Ann leaves before anyone else heard of her
  clock.advance(50);
  expect(bob.doc).toEqual(plain(inst.room.state));
  expect(host.doc).toEqual(plain(inst.room.state));
  expect(Object.keys(bob.doc.names)).toHaveLength(2);
});

test("a joiner that disconnects inside the window gets nothing more", () => {
  const { clock, inst, join } = setup(lobby({ presenceBatchMs: 50 }));
  const host = join("Host");
  const ann = join("Ann");
  const bob = join("Bob");
  inst.disconnect(ann);
  const before = ann.frames.length;
  clock.advance(50);
  expect(ann.frames.length).toBe(before);
  expect(bob.doc).toEqual(plain(inst.room.state));
  expect(host.doc).toEqual(plain(inst.room.state));
});

test("views: a joiner's first view includes them; members catch up once per window", () => {
  const { clock, inst, join } = setup(lobby({ presenceBatchMs: 50, view: true }));
  const host = join("Host");
  const cs = [join("a"), join("b"), join("c")];
  for (const c of cs) expect(c.doc.me).toBe(c.last("welcome").me.name);
  expect(host.patches).toBe(0);
  clock.advance(50);
  expect(host.patches).toBe(1);
  for (const c of [host, ...cs]) expect(c.doc.n).toBe(4);
  expect(Object.keys(inst.room.state.names)).toHaveLength(4);
});

test("close() cancels a pending presence flush", () => {
  const { clock, inst, join } = setup(lobby({ presenceBatchMs: 50 }));
  join("Host");
  join("Ann");
  expect(clock.pending).toBe(1);
  inst.close();
  expect(clock.pending).toBe(0);
});

test("seating 300 players costs O(N) frames with batching, O(N²) without", () => {
  const count = (ms: number, perTick: number) => {
    const { clock, join } = setup(lobby({ presenceBatchMs: ms }));
    const cs: Client[] = [];
    for (let i = 0; i < 300; i++) {
      cs.push(join(`p${i}`));
      if (i % perTick === perTick - 1) clock.advance(1);
    }
    clock.advance(100);
    return cs.reduce((n, c) => n + c.frames.length, 0);
  };
  const batched = count(50, 10);
  const eager = count(0, 10);
  expect(eager).toBeGreaterThan(40_000); // ~N²/2
  expect(batched).toBeLessThan(5_000);
});
