import { expect, test } from "bun:test";
import { FakeClock, RoomInstance, createRoomDurableObject, defineRoom, parseShardId, rooms, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const left: string[] = [];
const seen: { env?: Record<string, unknown> } = {};
const chat = defineRoom("kickchat", {
  state: t.object({ n: t.number() }),
  client: { hi: t.object({}) },
  init: () => ({ n: 0 }),
  onLeave: ({ player }) => void left.push(player.id),
  on: {
    hi: ({ room }) => {
      seen.env = room.env;
    },
  },
});

function room(opts: { env?: Record<string, unknown> } = {}) {
  const clock = new FakeClock(0);
  return { clock, inst: new RoomInstance(chat, { id: "r1", clock, ...opts }) };
}

test("room.kick removes the seat, closes the socket with the code, and the resume token stops working", () => {
  left.length = 0;
  const { inst } = room();
  const host = fakeSocket();
  const a = fakeSocket();
  inst.connect(host, { name: "Host" });
  inst.connect(a, { name: "Ann" });
  const id = a.last("welcome").me.id;
  const token = a.last("welcome").resumeToken;
  expect(inst.room.kick(id, 4010)).toBe(true);
  expect(a.closed?.code).toBe(4010);
  expect(inst.room.player(id)).toBeUndefined();
  expect(left).toEqual([id]);
  expect(inst.room.kick(id)).toBe(false);
  const again = fakeSocket();
  inst.connect(again, { resume: token });
  expect(again.last("error").code).toBe("MIU_E_ROOM_RESUME_EXPIRED");
  // Late frames from the kicked socket are ignored.
  inst.receive(a, JSON.stringify({ t: "ping" }));
  expect(a.frames.filter((f) => f.t === "pong")).toEqual([]);
});

test("room.kick defaults to close code 4009 and works on players inside the reconnect grace", () => {
  const { inst } = room();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a, { name: "A" });
  inst.connect(b, { name: "B" });
  const ida = a.last("welcome").me.id;
  const idb = b.last("welcome").me.id;
  inst.room.kick(ida);
  expect(a.closed?.code).toBe(4009);
  inst.disconnect(b);
  expect(inst.room.kick(idb)).toBe(true);
  expect(inst.isEmpty).toBe(true);
  expect(inst.nextDue()).toBeNull();
});

test("room.env: the env passed to the instance (Durable Object env / process env)", () => {
  const { inst } = room({ env: { DB: "d1" } });
  const a = fakeSocket();
  inst.connect(a, { name: "A" });
  inst.receive(a, JSON.stringify({ t: "msg", type: "hi", data: {} }));
  expect(seen.env).toEqual({ DB: "d1" });
  expect(room().inst.room.env).toEqual({});
});

test("local rooms get the process env; the plugin exposes its path; createRoom({ code: false }) skips the code", async () => {
  process.env.MIU_KICK_ENV_TEST = "yes";
  const realtime = rooms({ rooms: [chat], path: "/play/" });
  expect(realtime.path).toBe("/play");
  const made = await realtime.createRoom("kickchat", { code: false });
  expect(made).toEqual({ id: made.id });
  expect(realtime.registry.get("kickchat", made.id)!.room.env.MIU_KICK_ENV_TEST).toBe("yes");
  const withCode = await realtime.createRoom("kickchat");
  expect(withCode.code).toMatch(/^\d{6}$/);
});

test("Durable Object rooms see the object's env", async () => {
  const data = new Map<string, unknown>();
  const state = {
    acceptWebSocket() {},
    getWebSockets: () => [],
    storage: { get: async (k: string) => data.get(k), put: async (k: string, v: unknown) => void data.set(k, v), delete: async (k: string) => data.delete(k) },
  };
  const DO = createRoomDurableObject([chat], { clock: new FakeClock(0) });
  const obj = new DO(state as any, { DB: "binding" });
  const res = await obj.fetch(new Request("https://x/_miu/create?type=kickchat&id=r9", { method: "POST", body: "{}" }));
  expect(res.status).toBe(200);
  const res2 = await obj.fetch(new Request("https://x/_miu/room?type=kickchat&id=r9"));
  expect(res2.status).toBe(200);
  expect((obj as any).inst.room.env).toEqual({ DB: "binding" });
});

test("parseShardId is exported for shard-aware checks", () => {
  expect(parseShardId("abc:shard3")).toEqual({ id: "abc", shard: 3 });
  expect(parseShardId("abc")).toBeNull();
});

test("the JS client treats 4009 (kicked) as terminal: no reconnect", async () => {
  const { connect } = await import("../src/client.ts");
  const { FakeWS } = await import("./fakews.ts");
  const c = connect("ws://x/rooms/a/1", { name: "A", WebSocket: FakeWS as any });
  const closes: any[] = [];
  c.on("close", (e) => closes.push(e));
  FakeWS.last().joined({});
  FakeWS.last().drop(4009, "kicked");
  expect(closes).toEqual([{ code: 4009, reason: "kicked", willReconnect: false }]);
});
