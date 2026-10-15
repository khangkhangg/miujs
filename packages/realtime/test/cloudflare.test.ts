import { expect, test } from "bun:test";
import { FakeClock, createRoomDurableObject, defineRoom, t } from "../src/index.ts";
import { decode, encode } from "../src/msgpack.ts";
import { loadSnapshot } from "../src/persist.ts";

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  client: { say: t.object({ text: t.string() }) },
  init: () => ({ lines: [] }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`];
    },
  },
});

// Just enough of Cloudflare's hibernatable WebSocket + DurableObjectState to drive the class.
class CfSocket {
  frames: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  raw: unknown[] = [];
  send(m: string | Uint8Array) {
    this.raw.push(m);
    if (typeof m !== "string") return void this.frames.push(decode(m));
    this.frames.push(JSON.parse(m));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  last(t?: string) {
    for (let i = this.frames.length - 1; i >= 0; i--) if (!t || this.frames[i].t === t) return this.frames[i];
  }
}

function fakeState() {
  const data = new Map<string, unknown>();
  const sockets: CfSocket[] = [];
  return {
    data,
    sockets,
    acceptWebSocket(ws: CfSocket) {
      sockets.push(ws);
    },
    getWebSockets() {
      return sockets.filter((s) => !s.closed);
    },
    storage: {
      async get(k: string) {
        return structuredClone(data.get(k));
      },
      async put(k: string, v: unknown) {
        data.set(k, structuredClone(v));
      },
      async delete(k: string) {
        return data.delete(k);
      },
    },
  };
}

const pair = () => [new CfSocket(), new CfSocket()] as const;
const cfClock = new FakeClock();
const MiuRooms = createRoomDurableObject([chat], { webSocketPair: pair as any, clock: cfClock });
/** Wait for snapshot writes in flight (the stats endpoint answers after them). */
const settle = (dobj: { fetch(r: Request): Promise<Response> }, type = "chat", id = "ABC") => dobj.fetch(new Request(`https://miu-room/_miu/stats?type=${type}&id=${id}`));

function upgrade(path: string) {
  return new Request(`https://app.example${path}`, { headers: { upgrade: "websocket" } });
}

test("fetch() accepts a hibernatable WebSocket and joins the player from the query", async () => {
  const state = fakeState();
  const dobj = new MiuRooms(state as any, {});
  const res = await dobj.fetch(upgrade("/rooms/chat/ABC?name=Ann"));
  expect(res.status).toBe(101);
  const ws = state.sockets[0];
  expect(ws.last("welcome").me).toMatchObject({ name: "Ann", role: "host" });
  expect(ws.last("state").state).toEqual({ lines: [] });
  expect((ws.deserializeAttachment() as any).pid).toBe(ws.last("welcome").me.id);
});

test("messages run handlers, broadcast patches and persist state to storage", async () => {
  const state = fakeState();
  const dobj = new MiuRooms(state as any, {});
  await dobj.fetch(upgrade("/rooms/chat/ABC?name=Ann"));
  const ws = state.sockets[0];
  await dobj.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "say", data: { text: "hi" } }));
  expect(ws.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/lines", value: ["Ann: hi"] }] });
  // Writes are coalesced: the join was written at once, the message lands at the end of the window.
  expect((await loadSnapshot(state.storage))!.state).toEqual({ lines: [] });
  cfClock.advance(1_000);
  await settle(dobj);
  expect((await loadSnapshot(state.storage))!.state).toEqual({ lines: ["Ann: hi"] });
});

test("after hibernation a new instance restores state and re-attaches live sockets", async () => {
  const state = fakeState();
  const first = new MiuRooms(state as any, {});
  await first.fetch(upgrade("/rooms/chat/ABC?name=Ann"));
  const ws = state.sockets[0];
  const me = ws.last("welcome").me;
  await first.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "say", data: { text: "one" } }));
  cfClock.advance(1_000); // the coalesced write lands (a pending write keeps a real object awake)
  await settle(first);

  const woken = new MiuRooms(state as any, {}); // evicted from memory, sockets kept open
  await woken.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "say", data: { text: "two" } }));
  expect(ws.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/lines", value: ["Ann: one", "Ann: two"] }] });
  const info: any = await (await woken.fetch(new Request("https://miu-room/_miu/room?type=chat&id=ABC"))).json();
  expect(info.players).toEqual([expect.objectContaining({ id: me.id, connected: true })]);
});

test("webSocketClose keeps the seat; reconnecting with ?resume= restores the same player", async () => {
  const state = fakeState();
  const dobj = new MiuRooms(state as any, {});
  await dobj.fetch(upgrade("/rooms/chat/ABC?name=Ann"));
  const ws = state.sockets[0];
  const welcome = ws.last("welcome");
  ws.closed = { code: 1006 };
  await dobj.webSocketClose(ws as any, 1006, "", false);
  await dobj.fetch(upgrade(`/rooms/chat/ABC?resume=${welcome.resumeToken}`));
  const ws2 = state.sockets[1];
  expect(ws2.last("welcome")).toMatchObject({ resumed: true, me: { id: welcome.me.id } });
});

test("invalid frames become error frames", async () => {
  const state = fakeState();
  const dobj = new MiuRooms(state as any, {});
  await dobj.fetch(upgrade("/rooms/chat/ABC?name=Ann"));
  const ws = state.sockets[0];
  await dobj.webSocketMessage(ws as any, "nope");
  expect(ws.last().code).toBe("MIU_E_ROOM_BAD_FRAME");
});

test("plain HTTP gets 426, unknown room types 404, unknown room state 404", async () => {
  const dobj = new MiuRooms(fakeState() as any, {});
  expect((await dobj.fetch(new Request("https://x/rooms/chat/ABC"))).status).toBe(426);
  const r = await dobj.fetch(upgrade("/rooms/nope/ABC"));
  expect(r.status).toBe(404);
  expect((await r.json()).error.code).toBe("MIU_E_ROOM_TYPE_UNKNOWN");
  expect((await dobj.fetch(new Request("https://miu-room/_miu/room?type=chat&id=ABC"))).status).toBe(404);
});

// ---- alarms: named timers and reconnect grace survive hibernation ------------------------

const timed = defineRoom("timed", {
  state: t.object({ log: t.array(t.string()) }),
  client: { arm: t.object({ ms: t.number() }), closure: t.object({}) },
  init: () => ({ log: [] }),
  reconnectMs: 10_000,
  onLeave: ({ room, player }) => {
    room.state.log = [...room.state.log, `left:${player.name}`];
  },
  timers: {
    ring: ({ room, data, now }) => {
      room.state.log = [...room.state.log, `ring:${data.n}@${now}`];
    },
  },
  on: {
    arm: ({ room, msg }) => {
      room.schedule("ring", msg.ms, { n: msg.ms });
    },
    closure: ({ room }) => {
      room.after(10, () => {});
    },
  },
});

function alarmState() {
  const s = fakeState() as ReturnType<typeof fakeState> & { alarm: number | null };
  s.alarm = null;
  Object.assign(s.storage, {
    async setAlarm(at: number) {
      s.alarm = at;
    },
    async getAlarm() {
      return s.alarm;
    },
    async deleteAlarm() {
      s.alarm = null;
    },
  });
  return s;
}

function timedRooms() {
  const clock = new FakeClock(1_000);
  return { clock, Rooms: createRoomDurableObject([timed], { webSocketPair: pair as any, clock }) };
}

test("room.schedule() persists the timer in DO storage and sets the alarm to the earliest due time", async () => {
  const { Rooms } = timedRooms();
  const state = alarmState();
  const dobj = new Rooms(state as any, {});
  await dobj.fetch(upgrade("/rooms/timed/A?name=Ann"));
  const ws = state.sockets[0];
  await dobj.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "arm", data: { ms: 500 } }));
  await dobj.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "arm", data: { ms: 200 } }));
  expect((state.data.get("miu:room") as any).timers).toEqual([
    { id: expect.any(String), at: 1_500, name: "ring", data: { n: 500 } },
    { id: expect.any(String), at: 1_200, name: "ring", data: { n: 200 } },
  ]);
  expect(state.alarm).toBe(1_200);
});

test("alarm() on a woken object runs due timers, patches live sockets, then re-arms", async () => {
  const { Rooms, clock } = timedRooms();
  const state = alarmState();
  const first = new Rooms(state as any, {});
  await first.fetch(upgrade("/rooms/timed/A?name=Ann"));
  const ws = state.sockets[0];
  await first.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "arm", data: { ms: 200 } }));
  await first.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "arm", data: { ms: 500 } }));

  clock.advance(200);
  const woken = new Rooms(state as any, {}); // hibernated: memory gone, socket kept
  await woken.alarm();
  expect(ws.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/log", value: ["ring:200@1200"] }] });
  expect(state.alarm).toBe(1_500);
  clock.advance(300);
  await new Rooms(state as any, {}).alarm();
  expect(((await loadSnapshot(state.storage)) as any).state.log).toEqual(["ring:200@1200", "ring:500@1500"]);
  expect(state.alarm).toBeNull();
});

test("the reconnect grace period is an alarm: a seat expires even if the object hibernated", async () => {
  const { Rooms, clock } = timedRooms();
  const state = alarmState();
  const dobj = new Rooms(state as any, {});
  await dobj.fetch(upgrade("/rooms/timed/A?name=Ann"));
  await dobj.fetch(upgrade("/rooms/timed/A?name=Bob"));
  const [ann, bob] = state.sockets;
  bob.closed = { code: 1006 };
  await dobj.webSocketClose(bob as any, 1006, "", false);
  expect(state.alarm).toBe(11_000);

  clock.advance(10_000);
  await new Rooms(state as any, {}).alarm();
  expect(ann.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/log", value: ["left:Bob"] }] });
  expect((await loadSnapshot(state.storage))!.players.map((p: any) => p.name)).toEqual(["Ann"]);
  expect(state.alarm).toBeNull();
});

test("room.after() inside a Durable Object is refused with a MiuError pointing to schedule()", async () => {
  const { Rooms } = timedRooms();
  const state = alarmState();
  const dobj = new Rooms(state as any, {});
  await dobj.fetch(upgrade("/rooms/timed/A?name=Ann"));
  const ws = state.sockets[0];
  await dobj.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "closure", data: {} }));
  expect(ws.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_TIMER_NOT_DURABLE" });
  expect(ws.last().fix).toContain("schedule(");
});

test("alarm() with no stored room does nothing", async () => {
  const { Rooms } = timedRooms();
  const state = alarmState();
  await new Rooms(state as any, {}).alarm();
  expect(state.alarm).toBeNull();
});

test("?enc=msgpack survives hibernation: the attachment remembers the socket's encoding", async () => {
  const state = fakeState();
  const first = new MiuRooms(state as any, {});
  await first.fetch(upgrade("/rooms/chat/BIN?name=Ann&enc=msgpack"));
  const ws = state.sockets[0];
  expect(ws.raw.every((r) => r instanceof Uint8Array)).toBe(true);
  expect((ws.deserializeAttachment() as any).enc).toBe("msgpack");

  const woken = new MiuRooms(state as any, {});
  await woken.webSocketMessage(ws as any, encode({ t: "msg", type: "say", data: { text: "hi" } }).buffer as ArrayBuffer);
  expect(ws.raw.at(-1)).toBeInstanceOf(Uint8Array);
  expect(ws.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/lines", value: ["Ann: hi"] }] });
});
