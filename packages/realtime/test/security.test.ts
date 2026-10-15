// Adversarial tests: what a cheater or attacker can do with a raw WebSocket or HTTP client.
import { expect, test } from "bun:test";
import { miu } from "miujs";
import { FakeClock, LocalRooms, createRoomDurableObject, createRoomInstance, defineRoom, rooms, t } from "../src/index.ts";
import { decode, encode } from "../src/msgpack.ts";
import { fakeSocket } from "./helpers.ts";

const echo = defineRoom("echo", {
  state: t.object({ n: t.number() }),
  client: { inc: t.object({}), boom: t.object({}) },
  init: () => ({ n: 0 }),
  on: {
    inc: ({ room }) => {
      room.state.n++;
    },
    boom: () => {
      throw new Error("SELECT * FROM users failed: password=hunter2 at /srv/game/db.ts:12");
    },
  },
});

// ---- MessagePack bombs --------------------------------------------------------------------

test("a 6-byte MessagePack array header claiming 100M elements is refused before anything is allocated", () => {
  const before = process.memoryUsage().rss;
  const t0 = performance.now();
  expect(() => decode(new Uint8Array([0xdd, 0x05, 0xf5, 0xe1, 0x00, 0x01]))).toThrow(RangeError);
  expect(() => decode(new Uint8Array([0xdc, 0xff, 0xff, 0x01]))).toThrow(RangeError);
  expect(() => decode(new Uint8Array([0xdf, 0x05, 0xf5, 0xe1, 0x00, 0xa1, 0x61]))).toThrow(RangeError);
  expect(performance.now() - t0).toBeLessThan(50);
  expect(process.memoryUsage().rss - before).toBeLessThan(50 * 1024 * 1024);
  // Honest data still decodes.
  expect(decode(encode({ a: [1, 2, 3], b: { c: "x" } }))).toEqual({ a: [1, 2, 3], b: { c: "x" } });
  expect(decode(encode(Array.from({ length: 70_000 }, (_, i) => i % 100)))).toHaveLength(70_000);
});

test("the msgpack bomb sent to a room is an error frame, not a memory spike", () => {
  const inst = createRoomInstance(echo, { id: "M", clock: new FakeClock(0) });
  const s = fakeSocket();
  inst.connect(s, { name: "Ann", enc: "msgpack" });
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 5; i++) inst.receive(s, new Uint8Array([0x82, 0xa1, 0x74, 0xa3, 0x6d, 0x73, 0x67, 0xa4, 0x64, 0x61, 0x74, 0x61, 0xdd, 0x05, 0xf5, 0xe1, 0x00]));
  expect(process.memoryUsage().rss - before).toBeLessThan(50 * 1024 * 1024);
  expect(s.last("error").code).toBe("MIU_E_ROOM_BAD_FRAME");
});

// ---- data leaks -------------------------------------------------------------------------------

test("a handler crash does not leak the internal error message to the client", () => {
  const seen: unknown[] = [];
  const inst = createRoomInstance(echo, { id: "L", clock: new FakeClock(0), hooks: { onError: (e) => seen.push(e) } });
  const s = fakeSocket();
  inst.connect(s, { name: "Ann" });
  inst.receive(s, JSON.stringify({ t: "msg", type: "boom", data: {}, id: 7 }));
  const err = s.last("error");
  expect(err.code).toBe("MIU_E_ROOM_HANDLER_FAILED");
  expect(err.id).toBe(7);
  expect(JSON.stringify(err)).not.toContain("hunter2");
  expect(JSON.stringify(err)).not.toContain("/srv/");
  expect(seen).toHaveLength(1); // the server log still gets the real error
});

// ---- room capacity ----------------------------------------------------------------------------

test("spectators count toward maxMembers: one client cannot pile thousands of seats into a room", () => {
  const room = defineRoom("cap", { state: t.object({ n: t.number() }), init: () => ({ n: 0 }), maxPlayers: 2, maxMembers: 5 });
  const inst = createRoomInstance(room, { id: "C", clock: new FakeClock(0) });
  const socks = Array.from({ length: 8 }, () => fakeSocket());
  socks.forEach((s, i) => inst.connect(s, { name: `s${i}`, role: "spectator" }));
  expect(inst.info().players).toBe(5);
  expect(socks[5].last("error").code).toBe("MIU_E_ROOM_FULL");
  expect(socks[5].closed?.code).toBe(4005);
});

test("rooms have a default member cap (5000) even without maxPlayers", () => {
  const room = defineRoom("cap2", { state: t.object({ n: t.number() }), init: () => ({ n: 0 }), presenceBatchMs: 1_000 });
  const inst = createRoomInstance(room, { id: "D", clock: new FakeClock(0) });
  for (let i = 0; i < 5_000; i++) inst.connect(fakeSocket(), { name: `p${i}`, role: "spectator" });
  const extra = fakeSocket();
  inst.connect(extra, { name: "one-too-many", role: "spectator" });
  expect(inst.info().players).toBe(5_000);
  expect(extra.last("error").code).toBe("MIU_E_ROOM_FULL");
});

// ---- idle unjoined sockets --------------------------------------------------------------------

test("a socket that never joins is closed after joinTimeoutMs (default 10 s)", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(echo, { id: "J", clock });
  const idle = fakeSocket();
  const late = fakeSocket();
  const ok = fakeSocket();
  inst.connect(idle, {});
  inst.connect(ok, {});
  inst.receive(ok, JSON.stringify({ t: "join", name: "Ok" }));
  clock.advance(5_000);
  inst.connect(late, {});
  clock.advance(5_000);
  expect(idle.closed?.code).toBe(4002);
  expect(idle.last("error").code).toBe("MIU_E_ROOM_JOIN_TIMEOUT");
  expect(ok.closed).toBeNull();
  expect(late.closed).toBeNull();
  clock.advance(5_000);
  expect(late.closed?.code).toBe(4002);
  expect(inst.connections).toBe(1);
});

test("pings do not keep an unjoined socket alive", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(echo, { id: "J2", clock });
  const s = fakeSocket();
  inst.connect(s, {});
  for (let i = 0; i < 12; i++) {
    clock.advance(1_000);
    inst.receive(s, JSON.stringify({ t: "ping" }));
  }
  expect(s.closed?.code).toBe(4002);
});

// ---- host privileges --------------------------------------------------------------------------

const hosted = defineRoom("hosted", {
  state: t.object({ started: t.boolean() }),
  client: { start: t.object({}) },
  init: () => ({ started: false }),
  requireHostKey: true,
  reconnectMs: 1_000,
  on: {
    start: ({ room, sender }) => {
      if (sender.role !== "host") throw new Error("host only");
      room.state.started = true;
    },
  },
});

test("requireHostKey: the first joiner does not become host; only the hostKey holder does", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(hosted, { id: "H", clock });
  const attacker = fakeSocket();
  inst.connect(attacker, { name: "Eve" });
  expect(attacker.last("welcome").me.role).toBe("player");
  expect(attacker.last("welcome").hostKey).toBeUndefined();
  const forged = fakeSocket();
  inst.connect(forged, { name: "Eve2", role: "host", hostKey: "guess" });
  expect(forged.closed?.code).toBe(4003);
  const host = fakeSocket();
  inst.connect(host, { name: "Host", role: "host", hostKey: inst.hostKey });
  expect(host.last("welcome").me.role).toBe("host");
});

test("requireHostKey: when the host leaves, no player is promoted; the host can come back with the key", () => {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(hosted, { id: "H2", clock });
  const host = fakeSocket();
  inst.connect(host, { name: "Host", role: "host", hostKey: inst.hostKey });
  const p = fakeSocket();
  inst.connect(p, { name: "Pat" });
  inst.disconnect(host);
  clock.advance(1_000); // grace over: host seat removed
  expect(inst.room.players.map((x) => x.role)).toEqual(["player"]);
  const back = fakeSocket();
  inst.connect(back, { name: "Host", role: "host", hostKey: inst.hostKey });
  expect(back.last("welcome").me.role).toBe("host");
});

test("without requireHostKey the old behaviour stays: first joiner is host", () => {
  const inst = createRoomInstance(echo, { id: "H3", clock: new FakeClock(0) });
  const s = fakeSocket();
  inst.connect(s, { name: "A" });
  expect(s.last("welcome").me.role).toBe("host");
});

test("createRoom() returns the hostKey of the new room so the creator can claim host", async () => {
  const realtime = rooms({ rooms: [hosted] });
  await miu({ plugins: [realtime], logLevel: "silent" }).ready();
  const { id, hostKey } = await realtime.createRoom("hosted");
  expect(typeof hostKey).toBe("string");
  const inst = realtime.registry.get("hosted", id)!;
  const s = fakeSocket();
  inst.connect(s, { name: "Host", role: "host", hostKey });
  expect(s.last("welcome").me.role).toBe("host");
  realtime.stop();
});

// ---- rooms created by connecting ----------------------------------------------------------------

const serverMade = defineRoom("made", { state: t.object({ n: t.number() }), init: () => ({ n: 0 }), createOnJoin: false });

test("createOnJoin: false — connecting to a room id nobody created is 404 and creates nothing", async () => {
  const realtime = rooms({ rooms: [serverMade] });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  for (let i = 0; i < 20; i++) {
    const res = await app.request(`/rooms/made/r${i}?name=Eve&resume=junk`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("MIU_E_ROOM_NOT_FOUND");
  }
  expect(realtime.registry.list()).toEqual([]);
  realtime.stop();
});

test("createOnJoin: false — rooms made with createRoom() are joinable", async () => {
  const realtime = rooms({ rooms: [serverMade] });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  const s = await app.listen(0);
  try {
    const { id } = await realtime.createRoom("made");
    const ws = new WebSocket(s.url.replace("http", "ws") + `rooms/made/${id}?name=Ann`);
    const welcome = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (e) => {
        const f = JSON.parse(String(e.data));
        if (f.t === "welcome") resolve(f);
      };
      ws.onerror = reject;
    });
    expect(welcome.me.name).toBe("Ann");
    ws.close();
  } finally {
    await s.stop();
    realtime.stop();
  }
});

test("LocalRooms.route() does not create a createOnJoin:false room", () => {
  const reg = new LocalRooms([serverMade], { clock: new FakeClock(0) });
  expect(reg.route("made", "x", {})).toBeNull();
  expect(reg.list()).toEqual([]);
  reg.create("made", "y");
  expect(reg.route("made", "y", {})).not.toBeNull();
});

// ---- join codes ----------------------------------------------------------------------------------

test("code lookups that hit a live room do not use up the guessing budget (a classroom behind one NAT)", async () => {
  const clock = new FakeClock(0);
  const realtime = rooms({ rooms: [echo], clock, codeLookups: { perMinute: 6, burst: 3 } });
  await miu({ plugins: [realtime], logLevel: "silent" }).ready();
  const { code } = await realtime.createRoom("echo");
  const lookup = realtime.routes.find((r) => r.path.endsWith("/code/:code"))!;
  const call = async (c: string) => {
    try {
      await lookup.config.handler({ params: { code: c }, ip: "10.0.0.1", runtime: "bun", env: {} } as any);
      return 200;
    } catch (e: any) {
      return e.code;
    }
  };
  for (let i = 0; i < 40; i++) expect(await call(code)).toBe(200);
  const wrong = code === "999999" ? "999998" : "999999";
  expect([await call(wrong), await call(wrong), await call(wrong)]).toEqual(Array(3).fill("MIU_E_ROOM_CODE_UNKNOWN"));
  expect(await call(wrong)).toBe("MIU_E_ROOM_CODE_RATE_LIMITED");
  // Once the guesser is locked out, lookups of real codes from that IP wait too.
  expect(await call(code)).toBe("MIU_E_ROOM_CODE_RATE_LIMITED");
  realtime.stop();
});

test("a closed room frees its join code (a flood of created rooms cannot exhaust the 900k code space)", async () => {
  const clock = new FakeClock(0);
  const realtime = rooms({ rooms: [echo], clock, emptyMs: 1_000 });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  const { code } = await realtime.createRoom("echo");
  expect((await app.request(`/rooms/code/${code}`)).status).toBe(200);
  clock.advance(1_000); // nobody joined: disposed
  expect(realtime.registry.list()).toEqual([]);
  expect((await app.request(`/rooms/code/${code}`)).status).toBe(404);
  realtime.stop();
});

// ---- per-IP connection cap ---------------------------------------------------------------------

test("maxConnectionsPerIp: one IP cannot hold thousands of idle sockets", async () => {
  const realtime = rooms({ rooms: [echo], maxConnectionsPerIp: 3 });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  const s = await app.listen(0);
  const open: WebSocket[] = [];
  try {
    const url = (i: number) => s.url.replace("http", "ws") + `rooms/echo/room${i}?name=x`;
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(url(i));
      open.push(ws);
      results.push(
        await new Promise<string>((resolve) => {
          ws.onopen = () => resolve("open");
          ws.onerror = () => resolve("refused");
        }),
      );
    }
    expect(results).toEqual(["open", "open", "open", "refused", "refused"]);
    open[0].close();
    await new Promise((r) => setTimeout(r, 100));
    const again = new WebSocket(url(9));
    open.push(again);
    expect(await new Promise<string>((resolve) => ((again.onopen = () => resolve("open")), (again.onerror = () => resolve("refused"))))).toBe("open");
  } finally {
    for (const ws of open) ws.close();
    await s.stop();
    realtime.stop();
  }
});

// ---- Durable Object internal endpoints -----------------------------------------------------------

test("Durable Object internal endpoints (/_miu/*) only answer the internal host, never a forwarded client request", async () => {
  const data = new Map<string, unknown>();
  const state = {
    acceptWebSocket() {},
    getWebSockets: () => [],
    storage: { get: async (k: string) => data.get(k), put: async (k: string, v: unknown) => void data.set(k, v), delete: async (k: string) => data.delete(k) },
  };
  const Obj = createRoomDurableObject([echo], { clock: new FakeClock(0), webSocketPair: (() => [{}, {}]) as any });
  const obj = new Obj(state as any, {});
  await obj.fetch(new Request("https://miu-room/_miu/create?type=echo&id=A", { method: "POST", body: "{}" }));
  for (const path of ["/_miu/admin?type=echo&id=A", "/_miu/room?type=echo&id=A", "/_miu/stats?type=echo&id=A"]) {
    const res = await obj.fetch(new Request(`https://game.example${path}`, { method: "POST", body: JSON.stringify({ op: "close" }) }));
    expect(res.status).toBe(404);
  }
  const ok = await obj.fetch(new Request("https://miu-room/_miu/room?type=echo&id=A"));
  expect(ok.status).toBe(200);
});

// ---- MCP tools ---------------------------------------------------------------------------------

test("MCP rooms_list / room_state are operator tools: anonymous or non-admin callers cannot enumerate rooms or read raw state", async () => {
  const secretHands = defineRoom("cards", {
    state: t.object({ hands: t.record(t.array(t.string())) }),
    init: () => ({ hands: { p1: ["A♠", "K♠"] } }),
    view: (s, p) => ({ mine: s.hands[p.id] ?? [] }), // clients only ever see their own hand
  });
  const realtime = rooms({ rooms: [secretHands] });
  const app = miu({ plugins: [realtime], logLevel: "silent", mcp: true });
  realtime.registry.create("cards", "private1");
  const call = async (name: string, args: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return (await res.json()).result;
  };
  const list = await call("rooms_list", {});
  expect(list.isError).toBe(true);
  expect(JSON.stringify(list)).not.toContain("private1");
  const st = await call("room_state", { type: "cards", id: "private1" });
  expect(st.isError).toBe(true);
  expect(JSON.stringify(st)).not.toContain("K♠");
  // An admin (operator) may still look.
  const tools = realtime.mcpTools();
  const admin = { runtime: "bun", env: {}, user: { id: "op", roles: ["admin"] } } as any;
  expect(((await tools[0].call({}, admin)) as any).rooms).toHaveLength(1);
  // Explicit opt-in keeps the old public behaviour.
  const open = rooms({ rooms: [secretHands], mcpAccess: "public" });
  open.registry.create("cards", "x");
  expect(((await open.mcpTools()[0].call({}, { runtime: "bun", env: {} } as any)) as any).rooms).toHaveLength(1);
  realtime.stop();
  open.stop();
});

// ---- slow consumers ----------------------------------------------------------------------------

test("a socket whose frames the server drops (Bun: send() → 0 past the backpressure limit) is closed, not silently desynced", () => {
  const inst = createRoomInstance(echo, { id: "S", clock: new FakeClock(0) });
  const fast = fakeSocket();
  const slow = fakeSocket();
  inst.connect(fast, { name: "Fast" });
  inst.connect(slow, { name: "Slow" });
  const send = slow.send.bind(slow);
  slow.send = (m) => (send(m), 0) as unknown as void; // the runtime dropped it
  inst.receive(fast, JSON.stringify({ t: "msg", type: "inc", data: {} }));
  expect(slow.closed?.code).toBe(1013);
  expect(fast.closed).toBeNull();
  // The seat is kept: the client reconnects with its resume token and gets a fresh full state.
  expect(inst.room.players.map((p) => p.name)).toEqual(["Fast", "Slow"]);
});
