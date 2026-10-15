import { expect, test } from "bun:test";
import { FakeClock, createRoomDurableObject, defineRoom, t } from "../src/index.ts";

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
  send(m: string) {
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
const MiuRooms = createRoomDurableObject([chat], { webSocketPair: pair as any, clock: new FakeClock() });

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
  expect((state.data.get("miu:room") as any).state).toEqual({ lines: ["Ann: hi"] });
});

test("after hibernation a new instance restores state and re-attaches live sockets", async () => {
  const state = fakeState();
  const first = new MiuRooms(state as any, {});
  await first.fetch(upgrade("/rooms/chat/ABC?name=Ann"));
  const ws = state.sockets[0];
  const me = ws.last("welcome").me;
  await first.webSocketMessage(ws as any, JSON.stringify({ t: "msg", type: "say", data: { text: "one" } }));

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
