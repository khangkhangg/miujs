import { expect, test } from "bun:test";
import { miu } from "miujs";
import { FakeClock } from "../src/clock.ts";
import { LocalRooms, defineRoom, rooms, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

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

test("LocalRooms creates rooms on first use and disposes them when empty for emptyMs", () => {
  const clock = new FakeClock(0);
  const reg = new LocalRooms([chat], { clock, emptyMs: 5_000 });
  const room = reg.open("chat", "ABC")!;
  expect(reg.open("chat", "ABC")).toBe(room);
  const a = fakeSocket();
  room.connect(a, { name: "Ann" });
  reg.disconnected(room, a);
  clock.advance(30_000); // grace ends → empty
  expect(reg.get("chat", "ABC")).toBe(room);
  clock.advance(4_999);
  expect(reg.get("chat", "ABC")).toBe(room);
  clock.advance(1);
  expect(reg.get("chat", "ABC")).toBeUndefined();
  expect(room.isClosed).toBe(true);
});

test("a room that never got a player is disposed after its socket leaves", () => {
  const clock = new FakeClock(0);
  const reg = new LocalRooms([chat], { clock, emptyMs: 1_000 });
  const room = reg.open("chat", "X")!;
  const s = fakeSocket();
  room.connect(s, {});
  reg.disconnected(room, s);
  clock.advance(1_000);
  expect(reg.get("chat", "X")).toBeUndefined();
});

test("a player joining during the empty countdown keeps the room", () => {
  const clock = new FakeClock(0);
  const reg = new LocalRooms([chat], { clock, emptyMs: 1_000 });
  const room = reg.open("chat", "Y")!;
  const s = fakeSocket();
  room.connect(s, {});
  reg.disconnected(room, s);
  room.connect(fakeSocket(), { name: "Bob" });
  clock.advance(5_000);
  expect(reg.get("chat", "Y")).toBe(room);
});

test("open() returns null for unknown room types; list() reports rooms", () => {
  const reg = new LocalRooms([chat], { clock: new FakeClock() });
  expect(reg.open("nope", "1")).toBeNull();
  reg.open("chat", "1")!.connect(fakeSocket(), { name: "Ann" });
  expect(reg.list()).toEqual([{ type: "chat", id: "1", players: 1, connected: 1, createdAt: 0, closed: false }]);
});

test("unknown room type → 404 MIU_E_ROOM_TYPE_UNKNOWN; bad id → 400", async () => {
  const app = miu({ plugins: [rooms({ rooms: [chat] })], logLevel: "silent" });
  const res = await app.request("/rooms/nope/ABC");
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe("MIU_E_ROOM_TYPE_UNKNOWN");
  const bad = await app.request("/rooms/chat/" + "x".repeat(100));
  expect(bad.status).toBe(400);
  expect((await bad.json()).error.code).toBe("MIU_E_ROOM_ID_INVALID");
});

test("plain HTTP on the room route asks for a WebSocket", async () => {
  const app = miu({ plugins: [rooms({ rooms: [chat] })], logLevel: "silent" });
  const res = await app.request("/rooms/chat/ABC");
  expect(res.status).toBe(426);
});

test("the route path is configurable", async () => {
  const app = miu({ plugins: [rooms({ rooms: [chat], path: "/ws" })], logLevel: "silent" });
  expect((await app.request("/ws/chat/ABC")).status).toBe(426);
  expect((await app.request("/rooms/chat/ABC")).status).toBe(404);
});

test("cloudflare() declares the Durable Object binding and class", () => {
  expect(rooms({ rooms: [chat] }).cloudflare()).toEqual({ durableObjects: [{ binding: "MIU_ROOMS", className: "MiuRooms" }] });
  expect(rooms({ rooms: [chat], binding: "GAMES", className: "GameRooms" }).cloudflare()).toEqual({
    durableObjects: [{ binding: "GAMES", className: "GameRooms" }],
  });
});

test("rooms.createCode() returns a 6-digit code", () => {
  for (let i = 0; i < 50; i++) expect(rooms.createCode()).toMatch(/^\d{6}$/);
});

test("on workerd the route forwards to the Durable Object named type:id", async () => {
  const plugin = rooms({ rooms: [chat] });
  const seen: string[] = [];
  const ns = {
    idFromName: (name: string) => {
      seen.push(name);
      return { name };
    },
    get: (id: { name: string }) => ({
      fetch: async (req: Request) => new Response(`forwarded ${id.name} ${new URL(req.url).pathname}`),
    }),
  };
  const handler = plugin.routes[0].config.handler;
  const req = new Request("http://x/rooms/chat/ABC?name=Ann", { headers: { upgrade: "websocket" } });
  const res = (await handler({ req, params: { type: "chat", id: "ABC" }, runtime: "workerd", env: { MIU_ROOMS: ns } } as any)) as Response;
  expect(seen).toEqual(["chat:ABC"]);
  expect(await res.text()).toBe("forwarded chat:ABC /rooms/chat/ABC");
});

test("MCP tools rooms_list and room_state let agents observe rooms", async () => {
  const plugin = rooms({ rooms: [chat] });
  const room = plugin.registry.open("chat", "ABC")!;
  const a = fakeSocket();
  room.connect(a, { name: "Ann" });
  await room.receive(a, JSON.stringify({ t: "msg", type: "say", data: { text: "hi" } }));
  const tools = plugin.mcpTools();
  expect(tools.map((x) => x.name)).toEqual(["rooms_list", "room_state"]);
  const ctx = { runtime: "bun", env: {}, user: { id: "op", roles: ["admin"] } } as any; // operator tools (see security.test.ts)
  const list: any = await tools[0].call({}, ctx);
  expect(list.rooms).toEqual([expect.objectContaining({ type: "chat", id: "ABC", players: 1 })]);
  const st: any = await tools[1].call({ type: "chat", id: "ABC" }, ctx);
  expect(st.state).toEqual({ lines: ["Ann: hi"] });
  expect(st.players).toEqual([expect.objectContaining({ name: "Ann", role: "host", connected: true })]);
  await expect(Promise.resolve(tools[1].call({ type: "chat", id: "nope" }, ctx))).rejects.toMatchObject({ code: "MIU_E_ROOM_NOT_FOUND" });
});

test("inspect() lists room types and live rooms", () => {
  const plugin = rooms({ rooms: [chat] });
  expect(plugin.inspect()).toEqual({ path: "/rooms/:type/:id", types: ["chat"], rooms: [] });
});

// ---- end to end over real WebSockets on Bun ---------------------------------------------

function client(url: string) {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  const waiters: { pred: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(String(e.data));
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(f);
    }
  });
  const next = (pred: (f: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) {
        frames.splice(frames.indexOf(hit), 1);
        return resolve(hit);
      }
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("timed out waiting for frame")), 2000);
    });
  const opened = new Promise<void>((r) => ws.addEventListener("open", () => r()));
  return { ws, frames, next, opened };
}

test("end to end: two browsers join over WebSockets and see each other's messages", async () => {
  const app = miu({ plugins: [rooms({ rooms: [chat] })], logLevel: "silent" });
  const s = await app.listen(0);
  try {
    const base = s.url.replace("http", "ws") + "rooms/chat/ABC123";
    const a = client(base + "?name=Ann");
    const welcome = await a.next((f) => f.t === "welcome");
    expect(welcome.me).toMatchObject({ name: "Ann", role: "host" });
    expect(await a.next((f) => f.t === "state")).toEqual({ t: "state", state: { lines: [] } });

    const b = client(base);
    await b.opened;
    b.ws.send(JSON.stringify({ t: "join", name: "Bob" }));
    expect((await b.next((f) => f.t === "welcome")).me.role).toBe("player");
    await b.next((f) => f.t === "state");

    b.ws.send(JSON.stringify({ t: "msg", type: "say", data: { text: "hello" } }));
    const patch = { t: "patch", ops: [{ op: "replace", path: "/lines", value: ["Bob: hello"] }] };
    expect(await a.next((f) => f.t === "patch")).toEqual(patch);
    expect(await b.next((f) => f.t === "patch")).toEqual(patch);

    b.ws.send("garbage");
    expect((await b.next((f) => f.t === "error")).code).toBe("MIU_E_ROOM_BAD_FRAME");

    a.ws.close();
    b.ws.close();
  } finally {
    await s.stop();
  }
});
