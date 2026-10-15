import { expect, test } from "bun:test";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock, rooms, t } from "@miujs/realtime";
import { matchmaker, signResult } from "../src/matchmaker.ts";
import { gameRoom, type GameRoomData } from "../src/room.ts";
import { verifyTicket } from "../src/sign.ts";
import { GameStore } from "../src/store.ts";
import { as, settle, testAuth } from "./helpers.ts";

const SECRET = "mm-secret-0123456789abcdef-xyz";

function setup(queue: Record<string, unknown> = {}) {
  const clock = new FakeClock(10_000);
  const db = sqlite(":memory:");
  const arena = gameRoom("arena", { state: t.object({ ok: t.boolean() }), init: () => ({ ok: true }) }, { secret: SECRET });
  const realtime = rooms({ rooms: [arena], clock });
  const mm = matchmaker({
    rooms: realtime,
    secret: SECRET,
    database: db,
    clock,
    queues: { ranked: { room: "arena", teamSize: 1, teams: 2, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000, ...queue } },
  });
  const app = miu({ plugins: [testAuth(), realtime, mm], logLevel: "silent" });
  const store = new GameStore(db, { clock });
  const join = (user: string, body: unknown = {}) => app.request("/match/ranked/join", as(user, { method: "POST", body: JSON.stringify(body) }));
  const status = async (user: string, q = "") => (await app.request(`/match/ranked/status${q}`, as(user))).json();
  return { clock, app, mm, realtime, store, join, status };
}

test("join needs a signed-in user and a known queue", async () => {
  const { app, join } = setup();
  expect((await app.request("/match/ranked/join", { method: "POST" })).status).toBe(401);
  const res = await app.request("/match/casual/join", as("a", { method: "POST", body: "{}" }));
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe("MIU_E_GAME_QUEUE_UNKNOWN");
  expect((await join("a")).status).toBe(200);
});

test("two players are matched: a room is created for the match and each gets a fresh ticket for it", async () => {
  const { join, status, realtime, store, clock } = setup();
  expect(await (await join("ann:Ann")).json()).toMatchObject({ queue: "ranked", status: { state: "queued", since: 10_000, window: 100 } });
  await join("bob:Bob");
  await settle();
  const a = await status("ann");
  const b = await status("bob");
  expect(a.status).toMatchObject({ state: "matched", room: { type: "arena" } });
  expect(a.status.room.url).toBe(`/rooms/arena/${a.status.room.id}`);
  expect(b.status.room.id).toBe(a.status.room.id);
  expect(a.status.team).not.toBe(b.status.team);
  const tk = await verifyTicket(SECRET, a.status.ticket, { roomType: "arena", roomId: a.status.room.id, now: clock.now() });
  expect(tk).toMatchObject({ userId: "ann", name: "Ann", matchId: a.status.matchId });
  // The room was created with the roster, and the match is recorded for result reporting.
  const inst = realtime.registry.get("arena", a.status.room.id)!;
  expect(inst).toBeTruthy();
  const m = await store.match(a.status.matchId);
  expect(m).toMatchObject({ status: "pending", roomId: a.status.room.id, queue: "ranked", rating: "elo" });
  expect(m!.players.map((p) => p.userId).sort()).toEqual(["ann", "bob"]);
  expect(await store.profile("ann")).toMatchObject({ displayName: "Ann" });
});

test("the window widens on the fake clock until far-apart ratings match", async () => {
  const { join, status, store, clock } = setup();
  await store.setRating("hi", "ranked", 1800);
  await join("lo");
  await join("hi");
  await settle();
  expect((await status("lo")).status.state).toBe("queued");
  clock.advance(5_000);
  await settle();
  expect((await status("lo")).status).toMatchObject({ state: "queued", window: 200 });
  clock.advance(5_000);
  await settle();
  expect((await status("lo")).status.state).toBe("matched");
});

test("leave takes you out of the queue; waiting too long times out", async () => {
  const { app, join, status, clock } = setup();
  await join("a");
  const left = await app.request("/match/ranked/leave", as("a", { method: "DELETE" }));
  expect(await left.json()).toEqual({ queue: "ranked", left: true });
  expect((await status("a")).status).toEqual({ state: "idle" });
  await join("a");
  clock.advance(60_000);
  await settle();
  expect((await status("a")).status).toMatchObject({ state: "timeout" });
  const again = await join("a");
  expect((await again.json()).status.state).toBe("queued");
});

test("joining twice is a conflict", async () => {
  const { join } = setup();
  await join("a");
  const r = await join("a");
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("MIU_E_GAME_ALREADY_QUEUED");
});

test("long-poll: status?wait= returns as soon as the player is matched", async () => {
  const { join, status } = setup();
  await join("a");
  const pending = status("a", "?wait=20000");
  let done = false;
  void pending.then(() => (done = true));
  await settle();
  expect(done).toBe(false);
  await join("b");
  const r = await pending;
  expect(r.status.state).toBe("matched");
});

test("long-poll gives up after wait ms (on the room clock) with the current status", async () => {
  const { join, status, clock } = setup();
  await join("a");
  const pending = status("a", "?wait=1000");
  await settle();
  clock.advance(1_000);
  expect((await pending).status.state).toBe("queued");
});

test("regional queues need a region and only match within it", async () => {
  const { join, status } = setup({ region: ["eu", "us"] });
  expect((await join("a")).status).toBe(400);
  await join("a", { region: "eu" });
  await join("b", { region: "us" });
  await settle();
  expect((await status("a")).status).toMatchObject({ state: "queued", region: "eu" });
});

test("results reach the store through mm.reportResult (ratings move, Elo ±16)", async () => {
  const { join, status, mm, store } = setup();
  await join("a");
  await join("b");
  await settle();
  const { matchId } = (await status("a")).status;
  const r = await mm.reportResult(matchId, { winners: ["a"] });
  expect(r.ratings.a.after).toBeCloseTo(1516, 6);
  expect((await store.rating("b", "ranked")).rating).toBeCloseTo(1484, 6);
});

test("the internal result route only accepts results signed with the game secret", async () => {
  const { app, join, status, store, clock } = setup();
  await join("a");
  await join("b");
  await settle();
  const { matchId } = (await status("a")).status;
  const body = JSON.stringify({ matchId, result: { winners: ["b"] }, at: clock.now() });
  const unsigned = await app.request("/match/_result", { method: "POST", body, headers: { "content-type": "application/json" } });
  expect(unsigned.status).toBe(401);
  expect((await unsigned.json()).error.code).toBe("MIU_E_GAME_RESULT_UNSIGNED");
  const forged = await signResult("not-the-secret-0123456789abc", { matchId, result: { winners: ["b"] } }, clock.now());
  expect((await app.request("/match/_result", { method: "POST", body: forged.body, headers: forged.headers })).status).toBe(401);
  const stale = await signResult(SECRET, { matchId, result: { winners: ["b"] } }, clock.now() - 120_000);
  expect((await app.request("/match/_result", { method: "POST", body: stale.body, headers: stale.headers })).status).toBe(401);
  const ok = await signResult(SECRET, { matchId, result: { winners: ["b"] } }, clock.now());
  const res = await app.request("/match/_result", { method: "POST", body: ok.body, headers: ok.headers });
  expect(res.status).toBe(200);
  expect((await store.rating("b", "ranked")).rating).toBeCloseTo(1516, 6);
});

test("the room created for a match can report through reportResult(room) (registered sink)", async () => {
  const { join, status, realtime, store } = setup();
  await join("a");
  await join("b");
  await settle();
  const s = (await status("a")).status;
  const inst = realtime.registry.get("arena", s.room.id)!;
  const { reportResult } = await import("../src/room.ts");
  await reportResult(inst.room, { winners: ["b"] });
  expect((await store.rating("b", "ranked")).rating).toBeCloseTo(1516, 6);
  expect(((inst.snapshot().secret as any).__game.match as GameRoomData["match"])!.id).toBe(s.matchId);
});

test("inspect() and cloudflare() describe the queues and the Durable Object", async () => {
  const { mm, app } = setup();
  await app.ready();
  expect(mm.inspect()).toMatchObject({
    path: "/match",
    queues: { ranked: { room: "arena", teamSize: 1, teams: 2, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000, waiting: 0 } },
    durableObject: { binding: "MIU_MATCH", className: "MiuMatchmaker" },
  });
  expect(mm.cloudflare()).toEqual({ durableObjects: [{ binding: "MIU_MATCH", className: "MiuMatchmaker" }] });
  expect(app.service("matchmaker")).toBe(mm);
});

test("queues must point at a room type the rooms plugin knows", () => {
  const realtime = rooms({ rooms: [] });
  expect(() => matchmaker({ rooms: realtime, secret: SECRET, queues: { q: { room: "nope", teamSize: 1, rating: "elo", widenAfterMs: 1, maxWaitMs: 1 } } })).toThrow(/nope/);
});

test("notify WebSocket pushes the current status, then the match with room and ticket", async () => {
  const { app, join } = setup();
  const server = await app.listen(0);
  try {
    const url = server.url.replace("http", "ws") + "match/ranked/notify";
    const frames: any[] = [];
    const ws = new WebSocket(url, { headers: { "x-test-user": "ann" } } as any);
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    await new Promise((r) => ws.addEventListener("open", r));
    const deadline = Date.now() + 2000;
    while (!frames.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(frames[0]).toEqual({ t: "match", queue: "ranked", status: { state: "idle" } });
    await join("ann");
    await join("bob");
    while (!frames.some((f) => f.status.state === "matched") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const matched = frames.find((f) => f.status.state === "matched");
    expect(matched.status.room.url).toMatch(/^\/rooms\/arena\/r[0-9a-f]+$/);
    expect(typeof matched.status.ticket).toBe("string");
    expect(frames.map((f) => f.status.state)).toEqual(["idle", "queued", "matching", "matched"]);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("the notify WebSocket needs a signed-in user", async () => {
  const { app } = setup();
  const res = await app.request("/match/ranked/notify", { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(401);
});

test("ticket gate: game-room WebSockets need a valid ?ticket= (or a pure resume) before the upgrade", async () => {
  const { app, join, status, clock } = setup();
  await join("a");
  await join("b");
  await settle();
  const s = (await status("a")).status;
  const ws = { headers: { upgrade: "websocket" } };
  const path = s.room.url;
  // No ticket: refused before any seat is taken.
  const none = await app.request(`${path}?name=eve`, ws);
  expect(none.status).toBe(401);
  expect((await none.json()).error.code).toBe("MIU_E_GAME_TICKET_REQUIRED");
  // Forged / other-room tickets are refused.
  expect((await app.request(`${path}?name=eve&ticket=abc.def`, ws)).status).toBe(401);
  const other = (await status("a")).status.ticket;
  expect((await app.request(`/rooms/arena/rffffffffffffffff?name=a&ticket=${other}`, ws)).status).toBe(401);
  // A valid ticket passes the gate (the realtime route then answers; app.request cannot upgrade).
  expect((await app.request(`${path}?name=a&ticket=${s.ticket}`, ws)).status).not.toBe(401);
  // Reconnects: a pure resume passes; resume with an expired (but genuine) ticket passes too.
  expect((await app.request(`${path}?resume=sometoken`, ws)).status).not.toBe(401);
  expect((await app.request(`${path}?resume=sometoken&name=a`, ws)).status).toBe(401);
  clock.advance(61_000);
  expect((await app.request(`${path}?name=a&ticket=${s.ticket}`, ws)).status).toBe(401);
  expect((await app.request(`${path}?name=a&resume=tok&ticket=${s.ticket}`, ws)).status).not.toBe(401);
});

test("room.env carries the database: a room reports through a d1(\"BINDING\") ref with no request in flight", async () => {
  const { d1 } = await import("@miujs/db");
  const { RoomInstance } = await import("@miujs/realtime");
  const { reportResult } = await import("../src/room.ts");
  const db = sqlite(":memory:");
  const clock = new FakeClock(0);
  const envArena = gameRoom("envarena", { state: t.object({}), init: () => ({}) }, { secret: SECRET });
  const realtime = rooms({ rooms: [envArena], clock });
  matchmaker({ rooms: realtime, secret: SECRET, database: d1("GAMEDB"), clock, queues: { q: { room: "envarena", teamSize: 1, rating: "elo", widenAfterMs: 1_000, maxWaitMs: 10_000 } } });
  const store = new GameStore(db, { clock });
  const players = [{ userId: "a", name: "A", team: 0 }, { userId: "b", name: "B", team: 1 }];
  await store.createMatch({ id: "mx", queue: "q", room: "envarena", createdAt: 0, players: players.map((p) => ({ ...p, rating: 1500 })), teams: [["a"], ["b"]] }, "elo");
  // Like a Durable Object room: its env holds the D1 binding.
  const inst = new RoomInstance(envArena, { id: "r1", clock, env: { GAMEDB: db }, data: { match: { id: "mx", queue: "q", rated: true, players, teams: [["a"], ["b"]] } } });
  const r = await reportResult(inst.room, { winners: ["a"] });
  expect((r.summary as any).ratings.a.after).toBeCloseTo(1516, 6);
});

test("match rooms are created without a join code", async () => {
  const { join, realtime } = setup();
  const calls: any[] = [];
  const orig = realtime.createRoom;
  (realtime as any).createRoom = (type: string, o: any) => (calls.push(o), orig(type, o));
  await join("a");
  await join("b");
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0].code).toBe(false);
});

test("long-poll ends as soon as the client disconnects (ctx.req.signal), freeing its subscription", async () => {
  const { app, join, mm } = setup();
  const server = await app.listen(0);
  try {
    await join("a");
    const ctrl = new AbortController();
    const pending = fetch(`${server.url}match/ranked/status?wait=20000`, { headers: { "x-test-user": "a" }, signal: ctrl.signal }).catch((e) => e);
    const deadline = Date.now() + 2000;
    while ((mm.inspect() as any).longPolls !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect((mm.inspect() as any).longPolls).toBe(1);
    ctrl.abort();
    await pending;
    while ((mm.inspect() as any).longPolls !== 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect((mm.inspect() as any).longPolls).toBe(0); // the fake clock never fired: only the abort ended it
  } finally {
    await server.stop();
  }
});
