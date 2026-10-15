import { expect, test } from "bun:test";
import { validate, type Context, type ManageAction, type ManageSection } from "miujs";
import { FakeClock, createRoomDurableObject, defineRoom, rooms, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  secret: () => ({ answer: "TOP-SECRET-ANSWER" }),
  client: { say: t.object({ text: t.string() }) },
  init: () => ({ lines: [] }),
  on: {},
});
const quiz = defineRoom("quiz", { state: t.object({ q: t.number() }), init: () => ({ q: 0 }) });

const local = { runtime: "bun", env: {} } as unknown as Context;

function setup() {
  const clock = new FakeClock(1_000);
  const realtime = rooms({ rooms: [chat, quiz], clock });
  const [section] = realtime.manage() as ManageSection[];
  return { clock, realtime, section, list: section.lists![0] };
}

function action(actions: ManageAction[] | undefined, name: string): ManageAction {
  const a = actions?.find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
}

function join(realtime: ReturnType<typeof rooms>, type: string, id: string, name: string) {
  const s = fakeSocket();
  const room = realtime.registry.route(type, id, { name })!;
  room.connect(s, { name });
  return { s, room, me: s.last("welcome").me };
}

test("manage() returns one 'rooms' section with status, a rooms list and actions", () => {
  const { section } = setup();
  expect(section.id).toBe("rooms");
  expect(typeof section.status).toBe("function");
  expect(section.lists!.map((l) => l.name)).toEqual(["rooms"]);
  expect(section.lists![0].rowActions!.map((a) => a.name)).toEqual(["broadcast", "kick", "close"]);
  expect(section.actions!.map((a) => a.name)).toEqual(["broadcastRoom", "kickMember", "closeRoom", "roomStorage"]);
  for (const a of [...section.actions!, ...section.lists![0].rowActions!]) expect(a.name).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
  expect(action(section.lists![0].rowActions, "close").danger).toBe(true);
  expect(action(section.lists![0].rowActions, "kick").danger).toBe(true);
  expect(action(section.actions, "closeRoom").danger).toBe(true);
  expect(action(section.lists![0].rowActions, "broadcast").danger).toBeFalsy();
});

test("status counts live rooms by type, connected sockets and members in reconnect grace", async () => {
  const { realtime, section, clock } = setup();
  const a = join(realtime, "chat", "A", "Ann");
  join(realtime, "chat", "A", "Bob");
  join(realtime, "chat", "B", "Cid");
  join(realtime, "quiz", "Q", "Dee");
  realtime.registry.disconnected(a.room, a.s); // Ann drops: seat kept in grace
  clock.advance(10);
  const st = await section.status!(local);
  const stat = (label: string) => st.stats!.find((s) => s.label === label);
  expect(stat("Live rooms")!.value).toBe(3);
  expect(stat("Connected sockets")!.value).toBe(3);
  expect(stat("Members in reconnect grace")!.value).toBe(1);
  expect(stat("Rooms in reconnect grace")!.value).toBe(1);
  expect(stat("Live rooms")!.hint).toContain("this process");
  const byType = st.tables!.find((x) => x.title === "Rooms by type")!;
  expect(byType.rows).toEqual([
    { type: "chat", rooms: 2, members: 3, connected: 2 },
    { type: "quiz", rooms: 1, members: 1, connected: 1 },
  ]);
});

test("status on Workers with the Durable Object binding says rooms are not enumerable", async () => {
  const { section } = setup();
  const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("{}") }) };
  const st = await section.status!({ runtime: "workerd", env: { MIU_ROOMS: ns } } as unknown as Context);
  const live = st.stats!.find((s) => s.label === "Live rooms")!;
  expect(live.value).toBe(0);
  expect(live.hint).toContain("Durable Object");
  expect(live.hint).toContain("isolate");
});

test("the rooms list pages with a cursor, filters by type, searches ids and never shows secrets", async () => {
  const { realtime, list, clock } = setup();
  for (const id of ["r1", "r2", "r3"]) join(realtime, "chat", id, "P" + id);
  join(realtime, "quiz", "q1", "Q");
  clock.advance(5_000);
  const p1 = await list.list({ limit: 2 }, local);
  expect(p1.rows.map((r) => r.room)).toEqual(["chat:r1", "chat:r2"]);
  expect(p1.next).toBeString();
  const p2 = await list.list({ limit: 2, cursor: p1.next }, local);
  expect(p2.rows.map((r) => r.room)).toEqual(["chat:r3", "quiz:q1"]);
  expect(p2.next).toBeUndefined();
  expect(p1.rows[0]).toMatchObject({ room: "chat:r1", type: "chat", id: "r1", members: 1, connected: 1, grace: 0, age: 5_000 });
  expect(String(p1.rows[0].state)).toContain("lines");
  expect(JSON.stringify([...p1.rows, ...p2.rows])).not.toContain("TOP-SECRET-ANSWER");
  expect(JSON.stringify(p1.rows)).not.toMatch(/token|hostKey/i);

  const quizOnly = await list.list({ limit: 10, filters: { type: "quiz" } }, local);
  expect(quizOnly.rows.map((r) => r.room)).toEqual(["quiz:q1"]);
  const search = await list.list({ limit: 10, search: "r2" }, local);
  expect(search.rows.map((r) => r.room)).toEqual(["chat:r2"]);
  expect(list.filters![0]).toEqual({ key: "type", label: "Type", options: ["chat", "quiz"] });
  // A garbage cursor starts over instead of throwing.
  expect((await list.list({ limit: 1, cursor: "zzz" }, local)).rows.length).toBe(1);
  // The page size is capped.
  for (let i = 0; i < 120; i++) realtime.registry.create("quiz", `x${i}`);
  expect((await list.list({ limit: 500 }, local)).rows.length).toBe(100);
});

test("state previews are truncated", async () => {
  const { realtime, list } = setup();
  const { room } = join(realtime, "chat", "big", "Ann");
  room.update((r) => {
    r.state.lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  });
  const rows = (await list.list({ limit: 10 }, local)).rows;
  expect(String(rows[0].state).length).toBeLessThanOrEqual(201);
  expect(String(rows[0].state).endsWith("…")).toBe(true);
});

test("row action broadcast sends an event to connected members", async () => {
  const { realtime, list } = setup();
  const a = join(realtime, "chat", "A", "Ann");
  const msg = await action(list.rowActions, "broadcast").run({ id: "chat:A", event: "notice", message: "server restarts soon" }, local);
  expect(a.s.last("event")).toEqual({ t: "event", event: "notice", data: "server restarts soon" });
  expect(String(msg)).toContain("1 connected");
});

test("row action kick removes a member; kicking again is a no-op with a clear message", async () => {
  const { realtime, list } = setup();
  const a = join(realtime, "chat", "A", "Ann");
  const kick = action(list.rowActions, "kick");
  expect(String(await kick.run({ id: "chat:A", member: a.me.id }, local))).toContain("Kicked");
  expect(a.s.closed).not.toBeNull();
  expect(a.room.isEmpty).toBe(true);
  expect(String(await kick.run({ id: "chat:A", member: a.me.id }, local))).toContain("not in");
});

test("row action close closes the room and is idempotent", async () => {
  const { realtime, list } = setup();
  const a = join(realtime, "chat", "A", "Ann");
  const close = action(list.rowActions, "close");
  expect(String(await close.run({ id: "chat:A", reason: "maintenance" }, local))).toContain("Closed");
  expect(a.s.closed).toEqual({ code: 1000, reason: "maintenance" });
  expect(realtime.registry.get("chat", "A")).toBeUndefined();
  expect(String(await close.run({ id: "chat:A" }, local))).toContain("not open");
});

test("actions reject unknown room types, bad ids and missing rooms", async () => {
  const { list, section } = setup();
  await expect(Promise.resolve().then(() => action(list.rowActions, "broadcast").run({ id: "nope:A", event: "x" }, local))).rejects.toMatchObject({ code: "MIU_E_ROOM_TYPE_UNKNOWN" });
  await expect(Promise.resolve().then(() => action(list.rowActions, "broadcast").run({ id: "chat:bad id!", event: "x" }, local))).rejects.toMatchObject({ code: "MIU_E_ROOM_ID_INVALID" });
  await expect(Promise.resolve().then(() => action(section.actions, "broadcastRoom").run({ type: "chat", id: "missing", event: "x" }, local))).rejects.toMatchObject({ code: "MIU_E_ROOM_NOT_FOUND" });
});

test("action input schemas reject bad input", () => {
  const { list, section } = setup();
  const bc = action(list.rowActions, "broadcast").input!;
  expect(validate(bc, { event: "" }).ok).toBe(false);
  expect(validate(bc, { event: "x".repeat(65) }).ok).toBe(false);
  expect(validate(bc, { event: "notice", message: "x".repeat(5_000) }).ok).toBe(false);
  expect(validate(bc, { event: "notice" }).ok).toBe(true);
  expect(validate(action(list.rowActions, "kick").input!, {}).ok).toBe(false);
  const closeRoom = action(section.actions, "closeRoom").input!;
  expect(validate(closeRoom, { type: "nope", id: "A" }).ok).toBe(false);
  expect(validate(closeRoom, { type: "chat", id: "A" }).ok).toBe(true);
});

test("section actions take a type and id (they work without the list)", async () => {
  const { realtime, section } = setup();
  const a = join(realtime, "chat", "A", "Ann");
  await action(section.actions, "broadcastRoom").run({ type: "chat", id: "A", event: "hi" }, local);
  expect(a.s.last("event")).toEqual({ t: "event", event: "hi", data: null });
  await action(section.actions, "kickMember").run({ type: "chat", id: "A", member: a.me.id }, local);
  expect(a.room.isEmpty).toBe(true);
  await action(section.actions, "closeRoom").run({ type: "chat", id: "A" }, local);
  expect(a.room.isClosed).toBe(true);
});

// ---- Cloudflare: actions are forwarded to the room's Durable Object ----------------------

class CfSocket {
  frames: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private att: unknown = null;
  send(m: string) {
    this.frames.push(JSON.parse(m));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
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

function cfNamespace() {
  const Rooms = createRoomDurableObject([chat, quiz], { webSocketPair: (() => [new CfSocket(), new CfSocket()]) as any, clock: new FakeClock() });
  const objects = new Map<string, { obj: InstanceType<typeof Rooms>; sockets: CfSocket[]; data: Map<string, unknown> }>();
  const get = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      const data = new Map<string, unknown>();
      const sockets: CfSocket[] = [];
      const state = {
        acceptWebSocket: (ws: CfSocket) => void sockets.push(ws),
        getWebSockets: () => sockets.filter((s) => !s.closed),
        storage: { get: async (k: string) => structuredClone(data.get(k)), put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)), delete: async (k: string) => data.delete(k) },
      };
      o = { obj: new Rooms(state as any, {}), sockets, data };
      objects.set(name, o);
    }
    return o;
  };
  return { ns: { idFromName: (n: string) => n, get: (id: unknown) => ({ fetch: (r: Request) => get(String(id)).obj.fetch(r) }) }, get };
}

test("on Workers the section actions reach the room's Durable Object", async () => {
  const { section } = setup();
  const cf = cfNamespace();
  const ctx = { runtime: "workerd", env: { MIU_ROOMS: cf.ns } } as unknown as Context;
  await cf.get("chat:A").obj.fetch(new Request("https://x/rooms/chat/A?name=Ann", { headers: { upgrade: "websocket" } }));
  await cf.get("chat:A").obj.fetch(new Request("https://x/rooms/chat/A?name=Bob", { headers: { upgrade: "websocket" } }));
  const ws = cf.get("chat:A").sockets[0];
  const me = ws.last("welcome").me;

  expect(String(await action(section.actions, "broadcastRoom").run({ type: "chat", id: "A", event: "notice", message: "hello" }, ctx))).toContain("2 connected");
  expect(ws.last("event")).toEqual({ t: "event", event: "notice", data: "hello" });
  expect(String(await action(section.actions, "kickMember").run({ type: "chat", id: "A", member: me.id }, ctx))).toContain("Kicked");
  expect(ws.closed).not.toBeNull();
  expect(String(await action(section.actions, "closeRoom").run({ type: "chat", id: "A" }, ctx))).toContain("Closed");
  expect(cf.get("chat:A").data.has("miu:room")).toBe(false);
  expect(String(await action(section.actions, "closeRoom").run({ type: "chat", id: "A" }, ctx))).toContain("not open");
  await expect(Promise.resolve().then(() => action(section.actions, "broadcastRoom").run({ type: "chat", id: "gone", event: "x" }, ctx))).rejects.toMatchObject({ code: "MIU_E_ROOM_NOT_FOUND" });
});

test("on Workers the rooms list is empty (rooms cannot be enumerated across Durable Objects)", async () => {
  const { section } = setup();
  const cf = cfNamespace();
  const ctx = { runtime: "workerd", env: { MIU_ROOMS: cf.ns } } as unknown as Context;
  expect(await section.lists![0].list({ limit: 10 }, ctx)).toEqual({ rows: [] });
});
