import { expect, test } from "bun:test";
import { errors } from "miujs";
import { FakeClock } from "../src/clock.ts";
import { createRoomInstance, defineRoom, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const counter = defineRoom("counter", {
  state: t.object({ count: t.number(), names: t.array(t.string()), nested: t.object({ by: t.string() }) }),
  client: {
    inc: t.object({ by: t.number() }),
    boom: t.object({}),
    deny: t.object({}),
    bad: t.object({}),
    ping: t.object({}),
  },
  init: () => ({ count: 0, names: [], nested: { by: "" } }),
  onJoin: ({ room, player }) => {
    room.state.names = [...room.state.names, player.name];
  },
  onLeave: ({ room, player }) => {
    room.state.names = room.state.names.filter((n) => n !== player.name);
  },
  on: {
    inc: ({ room, sender, msg }) => {
      room.state.count += msg.by;
      room.state.nested.by = sender.name;
    },
    boom: ({ room }) => {
      room.state.count = 999;
      throw new Error("kaboom");
    },
    deny: () => {
      throw errors.forbidden("Only the host can do that", "Ask the host.");
    },
    bad: ({ room }) => {
      (room.state as any).count = "not a number";
    },
    ping: ({ room, sender, now }) => {
      room.send(sender.id, "pong", { now });
      room.broadcast("pinged", { by: sender.name });
    },
  },
});

function setup() {
  const clock = new FakeClock(1_000);
  const logged: unknown[] = [];
  const inst = createRoomInstance(counter, { id: "R1", clock, hooks: { onError: (e) => logged.push(e) } });
  return { clock, inst, logged };
}

function send(inst: ReturnType<typeof setup>["inst"], s: any, type: string, data: unknown = {}) {
  return inst.receive(s, JSON.stringify({ t: "msg", type, data }));
}

test("join sends welcome then full state; first joiner is host", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  const [welcome, state] = a.take();
  expect(welcome.t).toBe("welcome");
  expect(welcome.me).toEqual({ id: expect.any(String), name: "Ann", role: "host" });
  expect(welcome.room).toEqual({ type: "counter", id: "R1" });
  expect(typeof welcome.resumeToken).toBe("string");
  expect(typeof welcome.hostKey).toBe("string");
  expect(state).toEqual({ t: "state", state: { count: 0, names: ["Ann"], nested: { by: "" } } });
  const b = fakeSocket();
  inst.connect(b, { name: "Bob" });
  expect(b.take()[0].me.role).toBe("player");
  expect(b.last("welcome").hostKey).toBeUndefined();
  expect(inst.room.players.map((p) => [p.name, p.role])).toEqual([
    ["Ann", "host"],
    ["Bob", "player"],
  ]);
});

test("onJoin changes are broadcast to existing players as a patch (after the presence window)", () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  inst.connect(fakeSocket(), { name: "Bob" });
  expect(a.take()).toEqual([]); // a join right after another waits for the 50 ms presence window
  clock.advance(50);
  expect(a.take()).toEqual([{ t: "patch", ops: [{ op: "replace", path: "/names", value: ["Ann", "Bob"] }] }]);
});

test("a join frame works when the query had no name", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, {});
  expect(a.take()).toEqual([]);
  inst.receive(a, JSON.stringify({ t: "join", name: "Ann" }));
  expect(a.take().map((f) => f.t)).toEqual(["welcome", "state"]);
});

test("typed messages run handlers and broadcast a minimal patch", () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.connect(b, { name: "Bob" });
  clock.advance(50);
  a.take();
  b.take();
  send(inst, a, "inc", { by: 2 });
  const expected = {
    t: "patch",
    ops: [
      { op: "replace", path: "/count", value: 2 },
      { op: "replace", path: "/nested/by", value: "Ann" },
    ],
  };
  expect(a.take()).toEqual([expected]);
  expect(b.take()).toEqual([expected]);
});

test("send() and broadcast() deliver events", () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.connect(b, { name: "Bob" });
  clock.advance(50);
  a.take();
  b.take();
  send(inst, b, "ping");
  expect(b.take()).toEqual([
    { t: "event", event: "pong", data: { now: clock.now() } },
    { t: "event", event: "pinged", data: { by: "Bob" } },
  ]);
  expect(a.take()).toEqual([{ t: "event", event: "pinged", data: { by: "Bob" } }]);
});

test("invalid frames get error frames with MIU_E_* codes and never crash the room", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  inst.receive(a, "not json");
  expect(a.last().code).toBe("MIU_E_ROOM_BAD_FRAME");
  expect(a.last().fix).toBeString();
  inst.receive(a, JSON.stringify({ t: "nope" }));
  expect(a.last().code).toBe("MIU_E_ROOM_BAD_FRAME");
  inst.receive(a, new Uint8Array([1, 2]));
  expect(a.last().code).toBe("MIU_E_ROOM_BAD_FRAME");
  inst.receive(a, JSON.stringify({ t: "msg", type: "fly", data: {} }));
  expect(a.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_UNKNOWN_MESSAGE" });
  expect(a.last().fix).toContain("inc");
  inst.receive(a, JSON.stringify({ t: "msg", type: "inc", data: { by: "x" }, id: 7 }));
  expect(a.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_MESSAGE_INVALID", id: 7 });
  expect(a.last().details.issues[0].path).toBe("by");
  send(inst, a, "inc", { by: 1 });
  expect(inst.room.state.count).toBe(1);
});

test("messages before joining are rejected", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, {});
  send(inst, a, "inc", { by: 1 });
  expect(a.last().code).toBe("MIU_E_ROOM_NOT_JOINED");
  inst.receive(a, JSON.stringify({ t: "join" }));
  expect(a.last().code).toBe("MIU_E_ROOM_JOIN_INVALID");
});

test("a throwing handler rolls state back and reports MIU_E_ROOM_HANDLER_FAILED", () => {
  const { inst, logged } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  send(inst, a, "boom");
  expect(inst.room.state.count).toBe(0);
  expect(String(logged[0])).toContain("kaboom");
  expect(a.take()).toEqual([expect.objectContaining({ t: "error", code: "MIU_E_ROOM_HANDLER_FAILED" })]);
});

test("a MiuError thrown by a handler is forwarded with its own code and fix", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  send(inst, a, "deny");
  expect(a.take()).toEqual([{ t: "error", code: "MIU_E_FORBIDDEN", message: "Only the host can do that", fix: "Ask the host." }]);
});

test("state that breaks the schema is rolled back with MIU_E_ROOM_STATE_INVALID", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  send(inst, a, "bad");
  expect(inst.room.state.count).toBe(0);
  expect(a.take()).toEqual([expect.objectContaining({ code: "MIU_E_ROOM_STATE_INVALID" })]);
});

test("ping gets pong", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  inst.receive(a, JSON.stringify({ t: "ping" }));
  expect(a.take()).toEqual([{ t: "pong" }]);
});

test("disconnect keeps the player for the grace period; resume restores the same id", () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.connect(b, { name: "Bob" });
  const welcome = b.last("welcome");
  inst.disconnect(b);
  expect(inst.room.players.find((p) => p.name === "Bob")?.connected).toBe(false);
  clock.advance(29_000);
  const b2 = fakeSocket();
  inst.connect(b2, { resume: welcome.resumeToken });
  const [w2, s2] = b2.take();
  expect(w2.me.id).toBe(welcome.me.id);
  expect(w2.resumed).toBe(true);
  expect(s2.state.names).toEqual(["Ann", "Bob"]);
  clock.advance(60_000);
  expect(inst.room.players.length).toBe(2);
});

test("a resumed socket replaces a still-open old socket for the same player", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  const token = a.last("welcome").resumeToken;
  const a2 = fakeSocket();
  inst.connect(a2, { resume: token });
  expect(a.closed?.code).toBe(4001);
  inst.disconnect(a); // late close event from the old socket must not mark the player offline
  expect(inst.room.players[0].connected).toBe(true);
});

test("after the grace period the player is removed and onLeave runs", () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.connect(b, { name: "Bob" });
  const token = b.last("welcome").resumeToken;
  clock.advance(50);
  a.take();
  inst.disconnect(b);
  clock.advance(30_000);
  expect(inst.room.players.map((p) => p.name)).toEqual(["Ann"]);
  expect(a.take()).toEqual([{ t: "patch", ops: [{ op: "replace", path: "/names", value: ["Ann"] }] }]);
  const b2 = fakeSocket();
  inst.connect(b2, { resume: token, name: "Bob" });
  expect(b2.take()[0].resumed).toBe(false);
  expect(b2.last("welcome").me.id).not.toBe(b.last("welcome").me.id);
});

test("a resume token that is unknown with no name is an error", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { resume: "nope" });
  expect(a.last().code).toBe("MIU_E_ROOM_RESUME_EXPIRED");
});

test("host key lets a second socket join as host; a wrong key is refused", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  const key = a.last("welcome").hostKey;
  const bad = fakeSocket();
  inst.connect(bad, { name: "Eve", role: "host", hostKey: "wrong" });
  expect(bad.last().code).toBe("MIU_E_ROOM_HOST_KEY");
  expect(bad.closed?.code).toBe(4003);
  const co = fakeSocket();
  inst.connect(co, { name: "Co", role: "host", hostKey: key });
  expect(co.last("welcome").me.role).toBe("host");
});

test("spectators can join with role=spectator", () => {
  const { inst } = setup();
  inst.connect(fakeSocket(), { name: "Ann" });
  const s = fakeSocket();
  inst.connect(s, { name: "Tv", role: "spectator" });
  expect(s.last("welcome").me.role).toBe("spectator");
});

test("when the host leaves for good, the next player becomes host", () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.connect(fakeSocket(), { name: "Bob" });
  inst.disconnect(a);
  clock.advance(30_000);
  expect(inst.room.players.map((p) => [p.name, p.role])).toEqual([["Bob", "host"]]);
});

test("after() and tick() use the injected clock and flush state changes", () => {
  const clock = new FakeClock(0);
  const ticking = defineRoom("ticking", {
    state: t.object({ ticks: t.number(), done: t.boolean() }),
    client: { go: t.object({}) },
    init: () => ({ ticks: 0, done: false }),
    on: {
      go: ({ room }) => {
        const stop = room.tick(10, () => {
          room.state.ticks++;
        });
        room.after(250, () => {
          stop();
          room.state.done = true;
        });
      },
    },
  });
  const inst = createRoomInstance(ticking, { id: "T", clock });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  inst.receive(a, JSON.stringify({ t: "msg", type: "go", data: {} }));
  clock.advance(1000);
  // 10 Hz for 250 ms → ticks at 100 and 200, then done at 250.
  expect(inst.room.state).toEqual({ ticks: 2, done: true });
  expect(a.take().length).toBe(3);
  expect(clock.pending).toBe(0);
});

test("close() closes every socket, stops timers and reports onClose", () => {
  const clock = new FakeClock(0);
  let closed = false;
  const inst = createRoomInstance(counter, { id: "R", clock, hooks: { onClose: () => (closed = true) } });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.room.after(1000, () => {
    throw new Error("should not run");
  });
  inst.room.close();
  expect(a.closed?.code).toBe(1000);
  expect(closed).toBe(true);
  expect(clock.pending).toBe(0);
  const b = fakeSocket();
  inst.connect(b, { name: "Late" });
  expect(b.last().code).toBe("MIU_E_ROOM_CLOSED");
});

test("onEmpty fires when the last player is removed", () => {
  const clock = new FakeClock(0);
  let empty = 0;
  const inst = createRoomInstance(counter, { id: "R", clock, hooks: { onEmpty: () => empty++ } });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.disconnect(a);
  expect(empty).toBe(0);
  clock.advance(30_000);
  expect(empty).toBe(1);
});

test("init gets the room id, type and creation data; secret state is never sent", () => {
  const def = defineRoom("secretive", {
    state: t.object({ code: t.string() }),
    secret: () => ({ answer: "TOP-SECRET" }),
    init: (ctx) => ({ code: `${ctx.type}:${ctx.id}:${(ctx.data as any)?.x}` }),
  });
  const inst = createRoomInstance(def, { id: "S", clock: new FakeClock(), data: { x: 1 } });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  expect(a.last("state").state).toEqual({ code: "secretive:S:1" });
  expect(inst.room.secret).toEqual({ answer: "TOP-SECRET" });
  expect(JSON.stringify(a.frames)).not.toContain("TOP-SECRET");
});

test("room.storage is an async key-value store", async () => {
  const { inst } = setup();
  await inst.room.storage.put("k", { v: 1 });
  expect(await inst.room.storage.get("k")).toEqual({ v: 1 });
  expect(await inst.room.storage.delete("k")).toBe(true);
  expect(await inst.room.storage.get("k")).toBeUndefined();
});

test("maxPlayers refuses extra players with MIU_E_ROOM_FULL", () => {
  const def = defineRoom("duo", { state: t.object({}), init: () => ({}), maxPlayers: 2 });
  const inst = createRoomInstance(def, { id: "D", clock: new FakeClock() });
  inst.connect(fakeSocket(), { name: "A" });
  inst.connect(fakeSocket(), { name: "B" });
  const c = fakeSocket();
  inst.connect(c, { name: "C" });
  expect(c.last().code).toBe("MIU_E_ROOM_FULL");
  expect(c.closed).not.toBeNull();
});

test("async handlers flush their changes when they settle", async () => {
  const def = defineRoom("slow", {
    state: t.object({ n: t.number() }),
    client: { go: t.object({}) },
    init: () => ({ n: 0 }),
    on: {
      go: async ({ room }) => {
        await Promise.resolve();
        room.state.n = 5;
      },
    },
  });
  const inst = createRoomInstance(def, { id: "A", clock: new FakeClock() });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  await inst.receive(a, JSON.stringify({ t: "msg", type: "go", data: {} }));
  expect(a.take()).toEqual([{ t: "patch", ops: [{ op: "replace", path: "/n", value: 5 }] }]);
});

test("snapshot() and restore() round-trip players, tokens and state", () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.receive(a, JSON.stringify({ t: "msg", type: "inc", data: { by: 3 } }));
  const token = a.last("welcome").resumeToken;
  const snap = JSON.parse(JSON.stringify(inst.snapshot()));
  const copy = createRoomInstance(counter, { id: "R1", clock: new FakeClock(), restore: snap });
  expect(copy.room.state.count).toBe(3);
  const a2 = fakeSocket();
  copy.connect(a2, { resume: token });
  expect(a2.last("welcome")).toMatchObject({ resumed: true, me: { name: "Ann", role: "host" } });
});

test("state checks after a handler cover nested, removed and replaced fields", () => {
  const shaped = defineRoom("shaped", {
    state: t.object({ n: t.number(), opt: t.optional(t.string()), scores: t.record(t.object({ s: t.number() })) }),
    client: { nested: t.object({}), drop: t.object({}), dropOpt: t.object({}), root: t.object({}), ok: t.object({}) },
    init: () => ({ n: 0, opt: "x", scores: { a: { s: 1 } } }),
    on: {
      nested: ({ room }) => void ((room.state.scores.a as any).s = "nope"),
      drop: ({ room }) => void delete (room.state as any).n,
      dropOpt: ({ room }) => void delete room.state.opt,
      root: ({ room }) => void (room.state = { n: "bad" } as any),
      ok: ({ room }) => void (room.state.scores.b = { s: 2 }),
    },
  });
  const errs: unknown[] = [];
  const inst = createRoomInstance(shaped, { id: "S", clock: new FakeClock(0), hooks: { onError: (e) => errs.push(e) } });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  const run = (type: string) => {
    inst.receive(a, JSON.stringify({ t: "msg", type, data: {} }));
    return a.last();
  };
  expect(run("nested")).toMatchObject({ code: "MIU_E_ROOM_STATE_INVALID", message: expect.stringContaining("scores.a.s") });
  expect(run("drop")).toMatchObject({ code: "MIU_E_ROOM_STATE_INVALID", message: expect.stringContaining("n is required") });
  expect(run("root")).toMatchObject({ code: "MIU_E_ROOM_STATE_INVALID" });
  expect(inst.room.state).toEqual({ n: 0, opt: "x", scores: { a: { s: 1 } } });
  expect(run("dropOpt")).toEqual({ t: "patch", ops: [{ op: "remove", path: "/opt" }] });
  expect(run("ok").t).toBe("patch");
  expect(inst.room.state.scores).toEqual({ a: { s: 1 }, b: { s: 2 } });
  expect(errs).toHaveLength(3);
});
