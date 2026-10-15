// Memory and exit health of the realtime package: room lifecycles, reconnects, broadcasts, rate
// limiters, join codes, MessagePack and the client store. Each leak check runs thousands of
// iterations with forced GC and fails if live memory keeps growing after warm-up.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { FakeClock } from "../src/clock.ts";
import { MemoryCodeStore } from "../src/codes.ts";
import { KeyedLimiter, LocalRooms, defineRoom, shardedRoom, t } from "../src/index.ts";
import { decode, encode } from "../src/msgpack.ts";
import { connect } from "../src/client.ts";
import { createRoomStore } from "../src/store.ts";
import { FakeWS } from "./fakews.ts";
import { fakeSocket } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()), n: t.integer() }),
  client: { say: t.object({ text: t.string() }) },
  reconnectMs: 1_000,
  rateLimit: false,
  init: () => ({ lines: [], n: 0 }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines.slice(-4), `${sender.name}: ${msg.text}`];
      room.state.n++;
    },
  },
});

const ticker = defineRoom("ticker", {
  state: t.object({ n: t.integer() }),
  timers: { bump: ({ room }) => void room.state.n++ },
  reconnectMs: 1_000,
  init: () => ({ n: 0 }),
  onJoin: ({ room }) => {
    room.tick(20, () => void room.state.n++);
    room.after(10_000, () => void room.state.n++);
    room.schedule("bump", 60_000);
  },
});

const sharded = shardedRoom(chat, { shardSize: 2, aggregate: (s) => s.reduce((a, x) => a + x.players, 0), publish: () => {} });

const say = (text: string) => JSON.stringify({ t: "msg", type: "say", data: { text } });

describe("realtime does not leak", () => {
  test("rooms created, joined, left and disposed (local registry)", async () => {
    const clock = new FakeClock(0);
    const reg = new LocalRooms([chat, ticker], { clock, emptyMs: 500 });
    const r = await leakCheck("room lifecycle", (i) => {
      const room = reg.route(i % 2 ? "chat" : "ticker", `r${i}`, {})!;
      const s = fakeSocket();
      room.connect(s, { name: "Ann" });
      if (i % 2) room.receive(s, say("hi"));
      reg.disconnected(room, s);
      clock.advance(1_000); // grace
      clock.advance(500); // emptyMs
    }, { perRound: 2000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(clock.pending).toBe(0);
  }, 60_000);

  test("rooms made with create() that nobody joins are disposed", async () => {
    const clock = new FakeClock(0);
    const reg = new LocalRooms([chat], { clock, emptyMs: 500 });
    const r = await leakCheck("create() only", (i) => {
      reg.create("chat", `c${i}`, { x: i });
      clock.advance(500);
    });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(clock.pending).toBe(0);
  }, 60_000);

  test("sharded rooms: joins, leaves and create() leave no coordinator entries behind", async () => {
    const clock = new FakeClock(0);
    const reg = new LocalRooms([sharded], { clock, emptyMs: 500 });
    const r = await leakCheck("sharded lifecycle", (i) => {
      if (i % 3 === 0) reg.create("chat", `z${i}`, { i });
      const a = reg.route("chat", `s${i}`, {})!;
      const sa = fakeSocket();
      a.connect(sa, { name: "Ann" });
      reg.disconnected(a, sa);
      clock.advance(1_000);
      clock.advance(500);
    });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(clock.pending).toBe(0);
  }, 60_000);

  test("connect/disconnect cycles with and without resume on one long-lived room", async () => {
    const clock = new FakeClock(0);
    const reg = new LocalRooms([chat], { clock, emptyMs: 500 });
    const room = reg.open("chat", "lobby")!;
    const host = fakeSocket();
    host.send = () => {}; // the fake socket would otherwise keep every patch it receives
    room.connect(host, { name: "Host" });
    let token: string | undefined;
    const r = await leakCheck("reconnects", (i) => {
      const s = fakeSocket();
      if (token && i % 2) room.connect(s, { resume: token });
      else {
        room.connect(s, { name: `p${i % 50}` });
        token = s.last("welcome")?.resumeToken;
      }
      room.receive(s, say("x"));
      reg.disconnected(room, s);
      if (i % 2 === 0) clock.advance(1_001); // let the seat expire on even rounds
    });
    expect(r.leaking, describeLeak(r)).toBe(false);
    clock.advance(2_000);
    expect(room.info().players).toBe(1);
    expect(room.connections).toBe(1);
  }, 60_000);

  test("broadcast storm to 100 players", async () => {
    const clock = new FakeClock(0);
    const reg = new LocalRooms([chat], { clock });
    const room = reg.open("chat", "big")!;
    const socks = Array.from({ length: 100 }, (_, i) => {
      const s = fakeSocket();
      // Drop what was sent: the fake socket would otherwise keep every frame.
      s.send = () => {};
      room.connect(s, { name: `p${i}` });
      return s;
    });
    const r = await leakCheck("broadcast", (i) => room.receive(socks[i % 100], say(`m${i}`)), { perRound: 1000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("KeyedLimiter with many distinct keys stays bounded", async () => {
    const lim = new KeyedLimiter({ perSecond: 1, burst: 2, maxKeys: 500 });
    let now = 0;
    const r = await leakCheck("limiter", (i) => {
      lim.take(`ip${i}`, now);
      lim.take(`ip${i}`, now);
      lim.take(`ip${i}`, now); // over the limit: never "full", so only the size cap evicts it
      now += 1;
    });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("join codes that expire without being looked up are forgotten", async () => {
    const clock = new FakeClock(0);
    const store = new MemoryCodeStore(clock);
    let n = 100_000;
    const r = await leakCheck("join codes", async () => {
      await store.claim(String(n++), { type: "chat", id: "x" }, 1_000);
      clock.advance(10);
    }, { perRound: 10_000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(store.size).toBeLessThan(1_000);
  }, 60_000);

  test("msgpack encode/decode loop", async () => {
    const value = { t: "patch", ops: [{ op: "replace", path: "/a/b", value: [1, 2.5, "x", true, null, { k: "v" }] }], bin: new Uint8Array([1, 2, 3]) };
    const r = await leakCheck("msgpack", () => decode(encode(value)), { perRound: 5000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);

  test("client send() after the connection closed for good, or while it cannot reconnect, stays bounded", async () => {
    const gone = connect("ws://x/rooms/chat/1", { name: "Ann", WebSocket: FakeWS as any, reconnect: false });
    FakeWS.last().open();
    FakeWS.last().drop(1000, "bye");
    const away = connect("ws://x/rooms/chat/2", { name: "Bob", WebSocket: FakeWS as any }); // never opens
    FakeWS.all.length = 0;
    const r = await leakCheck("client send queue", (i) => {
      gone.send("say", { text: `m${i}` });
      away.send("say", { text: `m${i}` });
    }, { perRound: 5000 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    away.close();
  }, 60_000);

  test("client store subscribe/unsubscribe", async () => {
    const r = await leakCheck("room store", async () => {
      const store = createRoomStore("ws://x/rooms/chat/1", { name: "Ann", WebSocket: FakeWS as any, reconnect: false });
      const off = store.subscribe(() => {});
      const ws = FakeWS.last();
      ws.open();
      ws.emit("message", { data: JSON.stringify({ t: "welcome", me: { id: "p", name: "Ann", role: "host" }, resumeToken: "r" }) });
      ws.emit("message", { data: JSON.stringify({ t: "state", state: { lines: [] } }) });
      off();
      await Promise.resolve();
      FakeWS.all.length = 0; // the fake keeps every instance for tests; drop them
    }, { perRound: 6000 }); // larger rounds: JSC shape (Structure) churn in the first rounds is one-off
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);
});

describe("realtime lets the process exit", () => {
  test("an app with rooms, after ready() and createRoom(), exits", async () => {
    const r = await exitCheck(`
      import { miu } from "miujs";
      import { defineRoom, rooms, t } from "../src/index.ts";
      const chat = defineRoom("chat", { state: t.object({ n: t.integer() }), init: () => ({ n: 0 }) });
      const realtime = rooms({ rooms: [chat] });
      const app = miu({ logLevel: "silent", plugins: [realtime] });
      await app.ready();
      await realtime.createRoom("chat");
    `, 3000, PKG);
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 10_000);

  test("listen(), a real WebSocket player, then stop() exits", async () => {
    const r = await exitCheck(`
      import { miu } from "miujs";
      import { defineRoom, rooms, t } from "../src/index.ts";
      const chat = defineRoom("chat", {
        state: t.object({ n: t.integer() }),
        init: () => ({ n: 0 }),
        onJoin: ({ room }) => { room.schedule("noop", 60_000); },
        timers: { noop: () => {} },
      });
      const realtime = rooms({ rooms: [chat] });
      const app = miu({ logLevel: "silent", plugins: [realtime] });
      const s = await app.listen(0, "127.0.0.1");
      const ws = new WebSocket(s.url.replace("http", "ws") + "rooms/chat/abc?name=Ann");
      await new Promise((res) => ws.addEventListener("message", res, { once: true }));
      ws.close();
      await new Promise((res) => setTimeout(res, 50));
      await s.stop();
      realtime.stop();
    `, 3000, PKG);
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 10_000);

  test("listen(), a connected player, stop() without realtime.stop() still exits (housekeeping timers are unref'd)", async () => {
    const r = await exitCheck(`
      import { miu } from "miujs";
      import { defineRoom, rooms, t } from "../src/index.ts";
      const chat = defineRoom("chat", { state: t.object({ n: t.integer() }), init: () => ({ n: 0 }) });
      const realtime = rooms({ rooms: [chat] });
      const app = miu({ logLevel: "silent", plugins: [realtime] });
      const s = await app.listen(0, "127.0.0.1");
      const ws = new WebSocket(s.url.replace("http", "ws") + "rooms/chat/abc?name=Ann");
      await new Promise((res) => ws.addEventListener("message", res, { once: true }));
      ws.close();
      await new Promise((res) => setTimeout(res, 50));
      await s.stop();
    `, 3000, PKG);
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 10_000);

  test("stop() closes every room and clears every timer", () => {
    const clock = new FakeClock(0);
    const reg = new LocalRooms([ticker, chat], { clock, emptyMs: 500 });
    for (let i = 0; i < 10; i++) {
      const room = reg.route("ticker", `t${i}`, {})!;
      room.connect(fakeSocket(), { name: "Ann" });
      reg.create("chat", `c${i}`);
    }
    expect(clock.pending).toBeGreaterThan(0);
    reg.closeAll();
    expect(reg.list()).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});
