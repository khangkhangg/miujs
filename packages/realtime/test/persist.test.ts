// Durable Object persistence: coalesced writes, snapshots split across keys (members apart from
// game state), and failures that are logged, counted and retried instead of swallowed.
import { expect, test } from "bun:test";
import { FakeClock, createRoomDurableObject, defineRoom, rooms, t } from "../src/index.ts";
import { SNAPSHOT_KEY, loadSnapshot } from "../src/persist.ts";

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  client: { say: t.object({ text: t.string() }), arm: t.object({}) },
  init: () => ({ lines: [] }),
  secret: () => ({ seen: 0 }),
  timers: { ring: () => {} },
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`];
      room.secret.seen++;
    },
    arm: ({ room }) => {
      room.schedule("ring", 60_000);
    },
  },
});

class CfSocket {
  frames: any[] = [];
  closed: { code?: number } | null = null;
  private att: unknown = null;
  send(m: string) {
    this.frames.push(JSON.parse(m));
  }
  close(code?: number) {
    this.closed = { code };
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(t?: string) {
    for (let i = this.frames.length - 1; i >= 0; i--) if (!t || this.frames[i].t === t) return this.frames[i];
  }
}

/** DO storage stand-in that counts writes and enforces a per-value size limit like Cloudflare's. */
function fakeState(opts: { maxValue?: number } = {}) {
  const data = new Map<string, unknown>();
  const sockets: CfSocket[] = [];
  const log: { key: string; size: number }[] = [];
  let failures = 0;
  const s = {
    data,
    sockets,
    log,
    alarm: null as number | null,
    failNext(n = 1) {
      failures = n;
    },
    acceptWebSocket(ws: CfSocket) {
      sockets.push(ws);
    },
    getWebSockets() {
      return sockets.filter((x) => !x.closed);
    },
    storage: {
      async get(k: string) {
        return structuredClone(data.get(k));
      },
      async put(k: string, v: unknown) {
        if (failures > 0) {
          failures--;
          throw new Error("storage unavailable");
        }
        const size = JSON.stringify(v)?.length ?? 0;
        if (opts.maxValue && size > opts.maxValue) throw new RangeError(`Values cannot be larger than ${opts.maxValue} bytes. A value of size ${size} was provided.`);
        log.push({ key: k, size });
        data.set(k, structuredClone(v));
      },
      async delete(k: string) {
        return data.delete(k);
      },
      async setAlarm(at: number) {
        s.alarm = at;
      },
      async deleteAlarm() {
        s.alarm = null;
      },
    },
  };
  return s;
}

const upgrade = (path: string) => new Request(`https://app.example${path}`, { headers: { upgrade: "websocket" } });
const say = (text: string) => JSON.stringify({ t: "msg", type: "say", data: { text } });

function setup(o: { persistMs?: number; maxSnapshotBytes?: number; maxValue?: number } = {}) {
  const clock = new FakeClock(1_000);
  const logged: { err: any; where: string }[] = [];
  const Rooms = createRoomDurableObject([chat], {
    clock,
    webSocketPair: () => [new CfSocket(), new CfSocket()] as any,
    persistMs: o.persistMs,
    maxSnapshotBytes: o.maxSnapshotBytes,
    onError: (err, where) => logged.push({ err, where }),
  });
  const state = fakeState({ maxValue: o.maxValue });
  const dobj = new Rooms(state as any, {});
  const stored = async (): Promise<any> => loadSnapshot(state.storage);
  const stats = async () => (await (await dobj.fetch(new Request("https://miu-room/_miu/stats?type=chat&id=A"))).json()) as any;
  return { clock, Rooms, state, dobj, stored, stats, logged };
}

test("a burst of messages is persisted once at once and once more at the end of the window", async () => {
  const { clock, state, dobj, stored, stats } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  const ws = state.sockets[0];
  const headerWrites = () => state.log.filter((x) => x.key === SNAPSHOT_KEY).length;
  expect(headerWrites()).toBe(1);
  for (let i = 0; i < 50; i++) await dobj.webSocketMessage(ws as any, say(`m${i}`));
  expect(headerWrites()).toBe(1);
  clock.advance(1_000);
  await stats();
  expect(headerWrites()).toBe(2);
  // Nothing was lost: the trailing write holds the last message.
  expect((await stored())!.state.lines).toHaveLength(50);
  expect((await stored())!.secret).toEqual({ seen: 50 });
});

test("persistMs: 0 writes after every event (the old behaviour)", async () => {
  const { state, dobj } = setup({ persistMs: 0 });
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  for (let i = 0; i < 5; i++) await dobj.webSocketMessage(state.sockets[0] as any, say(`m${i}`));
  expect(state.log.filter((x) => x.key === SNAPSHOT_KEY).length).toBe(6);
});

test("an unchanged snapshot is not written again", async () => {
  const { clock, state, dobj, stats } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  clock.advance(5_000);
  const before = state.log.length;
  await dobj.webSocketMessage(state.sockets[0] as any, JSON.stringify({ t: "ping" }));
  expect(state.log.length).toBe(before);
  expect((await stats()).persist.skipped).toBeGreaterThan(0);
});

test("scheduling a timer and the last socket closing are written at once", async () => {
  const { state, dobj, stored } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  const ws = state.sockets[0];
  await dobj.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "arm", data: {} }));
  expect((await stored())!.timers).toHaveLength(1);
  await dobj.webSocketMessage(ws as any, say("bye"));
  expect((await stored())!.state.lines).toEqual([]);
  ws.closed = { code: 1006 };
  await dobj.webSocketClose(ws as any, 1006, "", false);
  const snap = (await stored())!;
  expect(snap.state.lines).toEqual(["Ann: bye"]);
  expect(snap.players[0].graceUntil).toBe(31_000);
});

test("the last socket closing writes at once even when the alarm does not move", async () => {
  const { clock, state, dobj, stored } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  await dobj.fetch(upgrade("/rooms/chat/A?name=Bob"));
  const [ann, bob] = state.sockets;
  bob.closed = { code: 1006 };
  await dobj.webSocketClose(bob as any, 1006, "", false); // grace alarm at 31 000
  clock.advance(100);
  await dobj.webSocketMessage(ann as any, say("bye")); // inside the window: deferred
  expect((await stored())!.state.lines).toEqual([]);
  ann.closed = { code: 1006 };
  await dobj.webSocketClose(ann as any, 1006, "", false); // grace 31 100: the alarm stays at 31 000
  expect((await stored())!.state.lines).toEqual(["Ann: bye"]);
});

test("a new timer is written at once even when it does not move the alarm", async () => {
  const { state, dobj, stored } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  const arm = JSON.stringify({ t: "msg", type: "arm", data: {} });
  await dobj.webSocketMessage(state.sockets[0] as any, arm);
  await dobj.webSocketMessage(state.sockets[0] as any, arm); // same due time: the alarm stays put
  expect((await stored())!.timers).toHaveLength(2);
});

test("a room bigger than one storage value is split across keys and restores intact", async () => {
  const { clock, state, dobj, Rooms, stats } = setup({ maxValue: 128 * 1024 });
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  const ws = state.sockets[0];
  const big = "x".repeat(9_000);
  for (let i = 0; i < 40; i++) await dobj.webSocketMessage(ws as any, say(`${i}${big}`)); // ~360 KB of state
  clock.advance(1_000);
  await stats();
  expect(Math.max(...state.log.map((x) => x.size))).toBeLessThanOrEqual(128 * 1024);
  const woken = new Rooms(state as any, {});
  await woken.webSocketMessage(ws as any, say("after"));
  expect(ws.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/lines", value: expect.any(Array) }] });
  const lines = ws.last().ops[0].value as string[];
  expect(lines).toHaveLength(41);
  expect(lines[39]).toBe(`Ann: 39${big}`);
});

test("members are stored apart from game state: a message does not rewrite the member list", async () => {
  const { clock, state, dobj, stats } = setup();
  for (let i = 0; i < 300; i++) await dobj.fetch(upgrade(`/rooms/chat/A?name=player${i}`));
  clock.advance(1_000);
  await stats();
  const from = state.log.length;
  await dobj.webSocketMessage(state.sockets[0] as any, say("hi"));
  clock.advance(1_000);
  await stats();
  const keys = state.log.slice(from).map((x) => x.key);
  expect(keys).toContain(SNAPSHOT_KEY);
  expect(keys.some((k) => k.includes(":players"))).toBe(false);
  expect(state.log.slice(from).reduce((n, x) => n + x.size, 0)).toBeLessThan(5_000);
});

test("old chunks are deleted when a section is rewritten, and close() deletes every key", async () => {
  const { clock, state, dobj, stats } = setup();
  for (let i = 0; i < 300; i++) await dobj.fetch(upgrade(`/rooms/chat/A?name=player${i}`));
  clock.advance(1_000);
  await stats();
  await dobj.fetch(upgrade(`/rooms/chat/A?name=late`));
  clock.advance(1_000);
  await stats();
  const chunkKeys = [...state.data.keys()].filter((k) => k.startsWith(`${SNAPSHOT_KEY}:`));
  const gens = new Set(chunkKeys.map((k) => k.split(":").slice(0, 4).join(":")));
  expect(gens.size).toBe(1);
  const res = await dobj.fetch(new Request("https://miu-room/_miu/admin?type=chat&id=A", { method: "POST", body: JSON.stringify({ op: "close" }) }));
  expect(res.status).toBe(200);
  await stats();
  expect([...state.data.keys()].filter((k) => k.startsWith("miu:room"))).toEqual([]);
});

test("a snapshot over maxSnapshotBytes is refused loudly: MIU_E_ROOM_STATE_TOO_LARGE, logged, counted", async () => {
  const { state, dobj, stored, stats, logged } = setup({ maxSnapshotBytes: 20_000, persistMs: 0 });
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  const ws = state.sockets[0];
  await dobj.webSocketMessage(ws as any, say("small"));
  await dobj.webSocketMessage(ws as any, say("y".repeat(12_000)));
  expect(logged).toEqual([]);
  await dobj.webSocketMessage(ws as any, say("z".repeat(12_000)));
  expect(logged.at(-1)!.err.code).toBe("MIU_E_ROOM_STATE_TOO_LARGE");
  expect(logged.at(-1)!.err.fix).toContain("maxSnapshotBytes");
  // The room keeps running and the last good snapshot stays in storage.
  expect(ws.last().t).toBe("patch");
  expect(ws.last().ops[0].value).toHaveLength(3);
  expect((await stored())!.state.lines).toHaveLength(2);
  const s = (await stats()).persist;
  expect(s.failures).toBe(1);
  expect(s.lastError.code).toBe("MIU_E_ROOM_STATE_TOO_LARGE");
});

test("a failing storage write is logged as MIU_E_ROOM_PERSIST_FAILED and retried", async () => {
  const { clock, state, dobj, stored, stats, logged } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  clock.advance(5_000);
  state.failNext();
  await dobj.webSocketMessage(state.sockets[0] as any, say("hi"));
  expect(logged.at(-1)!.err.code).toBe("MIU_E_ROOM_PERSIST_FAILED");
  expect(logged.at(-1)!.err.message).toContain("storage unavailable");
  expect((await stats()).persist.failures).toBe(1);
  clock.advance(1_000);
  await stats();
  await stats();
  expect((await stored())!.state.lines).toEqual(["Ann: hi"]);
});

test("stats report the last persisted size and write counts", async () => {
  const { clock, state, dobj, stats } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  await dobj.webSocketMessage(state.sockets[0] as any, say("hi"));
  clock.advance(1_000);
  await stats();
  const s = (await stats()).persist;
  expect(s.writes).toBe(2);
  expect(s.lastBytes).toBeGreaterThan(100);
  expect(s.bytesWritten).toBeGreaterThanOrEqual(s.lastBytes);
  expect(s.failures).toBe(0);
  expect(s.lastError).toBeNull();
});

test("a snapshot stored by an older version (one key) still restores", async () => {
  const { state, Rooms } = setup();
  const ws = new CfSocket();
  ws.serializeAttachment({ sid: "s1", type: "chat", id: "A", pid: "p_old" });
  state.sockets.push(ws);
  await state.storage.put(SNAPSHOT_KEY, {
    v: 1,
    type: "chat",
    id: "A",
    createdAt: 1,
    hostKey: "k",
    state: { lines: ["old"] },
    secret: { seen: 1 },
    players: [{ id: "p_old", name: "Ann", role: "host", joinedAt: 1, token: "tok" }],
    timers: [],
  });
  const woken = new Rooms(state as any, {});
  await woken.webSocketMessage(ws as any, say("new"));
  expect(ws.last()).toEqual({ t: "patch", ops: [{ op: "replace", path: "/lines", value: ["old", "Ann: new"] }] });
});

test("manage(): the room storage action shows a Durable Object room's persistence stats", async () => {
  const { dobj } = setup();
  await dobj.fetch(upgrade("/rooms/chat/A?name=Ann"));
  const plugin = rooms({ rooms: [chat] });
  const section = plugin.manage!()[0];
  const action = section.actions!.find((a) => a.name === "roomStorage")!;
  const ns = { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => dobj.fetch(r) }) };
  const msg = await action.run({ type: "chat", id: "A" }, { runtime: "workerd", env: { MIU_ROOMS: ns } } as any);
  expect(String(msg)).toMatch(/last persisted [\d,]+ bytes/);
  expect(String(msg)).toContain("0 failures");
  const local = await action.run({ type: "chat", id: "A" }, { runtime: "bun", env: {} } as any);
  expect(String(local)).toContain("in memory");
});
