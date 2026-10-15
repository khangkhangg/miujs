import { expect, test } from "bun:test";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock, rooms, t } from "@miujs/realtime";
import { lobbies } from "../src/lobbies.ts";
import { LobbyCore } from "../src/lobby.ts";
import { gameRoom, reportResult } from "../src/room.ts";
import { verifyTicket } from "../src/sign.ts";
import { GameStore } from "../src/store.ts";
import { as, testAuth } from "./helpers.ts";

const SECRET = "lobby-secret-0123456789abcdef";

test("LobbyCore: join, ready, host-only start once everyone is ready", () => {
  const l = new LobbyCore({ id: "L1", code: "123456", roomType: "party", hostId: "a", hostName: "Ann", minPlayers: 2, maxPlayers: 3, teams: 2, now: 0 });
  expect(l.view().members).toEqual([{ userId: "a", name: "Ann", ready: false, host: true, team: 0 }]);
  l.join("b", "Bob", 1);
  l.join("b", "Bob", 2); // idempotent
  expect(() => l.start("a", 3)).toThrow(/not ready: Bob/);
  expect(() => l.start("b", 3)).toThrow(/host/);
  l.ready("b", true);
  l.join("c", "Cy", 4);
  expect(() => l.join("d", "Dee", 5)).toThrow(/full/);
  l.ready("c", true);
  const spec = l.start("a", 6);
  expect(spec).toMatchObject({ queue: "lobby", room: "party", createdAt: 6, teams: [["a", "c"], ["b"]] });
  expect(l.view().status).toBe("starting");
  expect(() => l.join("e", "E", 7)).toThrow(/already started/);
});

test("LobbyCore: when the host leaves, the next member becomes host; min players is enforced", () => {
  const l = new LobbyCore({ id: "L1", code: "123456", roomType: "party", hostId: "a", hostName: "Ann", minPlayers: 2, maxPlayers: 4, teams: 2, now: 0 });
  expect(() => l.start("a", 1)).toThrow(/at least 2/);
  l.join("b", "Bob", 1);
  l.leave("a");
  expect(l.view().hostId).toBe("b");
  expect(l.leave("b")).toBe(true);
  expect(l.view().members).toEqual([]);
});

function setup() {
  const clock = new FakeClock(50_000);
  const db = sqlite(":memory:");
  const party = gameRoom("party", { state: t.object({}), init: () => ({}) }, { secret: SECRET });
  const realtime = rooms({ rooms: [party], clock });
  const lb = lobbies({ rooms: realtime, room: "party", secret: SECRET, database: db, clock, maxPlayers: 4 });
  const app = miu({ plugins: [testAuth(), realtime, lb], logLevel: "silent" });
  const post = async (user: string, path: string, body: unknown = {}) => {
    const r = await app.request(path, as(user, { method: "POST", body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  const get = async (user: string, path: string) => {
    const r = await app.request(path, as(user));
    return { status: r.status, body: await r.json() };
  };
  return { clock, app, post, get, realtime, store: new GameStore(db, { clock }), lb };
}

test("create → share the 6-digit code → join → ready → host starts → room and tickets", async () => {
  const { post, get, realtime, store, clock } = setup();
  const created = await post("ann:Ann", "/lobbies");
  expect(created.status).toBe(200);
  const { id, code } = created.body.lobby;
  expect(code).toMatch(/^\d{6}$/);
  const joined = await post("bob:Bob", "/lobbies/join", { code });
  expect(joined.body.lobby.members.map((m: any) => m.userId)).toEqual(["ann", "bob"]);
  expect((await post("ann", `/lobbies/${id}/start`)).status).toBe(409);
  await post("bob", `/lobbies/${id}/ready`, { ready: true });
  expect((await post("bob", `/lobbies/${id}/start`)).body.error.code).toBe("MIU_E_GAME_LOBBY_NOT_HOST");
  const started = await post("ann", `/lobbies/${id}/start`);
  expect(started.status).toBe(200);
  expect(started.body.lobby.status).toBe("started");
  const room = started.body.lobby.room;
  expect(room.url).toBe(`/rooms/party/${room.id}`);
  expect(realtime.registry.get("party", room.id)).toBeTruthy();
  // Every member gets their own ticket from GET /lobbies/:id.
  const bobView = await get("bob", `/lobbies/${id}`);
  const tk = await verifyTicket(SECRET, bobView.body.ticket, { roomType: "party", roomId: room.id, now: clock.now() });
  expect(tk).toMatchObject({ userId: "bob", name: "Bob", matchId: bobView.body.lobby.matchId });
  // The match is recorded unrated; results update stats only.
  const m = await store.match(bobView.body.lobby.matchId);
  expect(m).toMatchObject({ queue: "lobby", rating: "none", roomId: room.id });
  await reportResult(realtime.registry.get("party", room.id)!.room, { winners: ["bob"] });
  expect(await store.stats("bob")).toMatchObject({ wins: 1 });
  expect((await store.profile("bob"))!.ratings).toEqual({});
});

test("non-members cannot see tickets or act on a lobby; unknown codes are 404", async () => {
  const { post, get } = setup();
  const { id } = (await post("ann", "/lobbies")).body.lobby;
  expect((await get("eve", `/lobbies/${id}`)).body.error.code).toBe("MIU_E_GAME_LOBBY_NOT_MEMBER");
  expect((await post("eve", `/lobbies/${id}/ready`, { ready: true })).status).toBe(403);
  expect((await post("eve", "/lobbies/join", { code: "000000" })).body.error.code).toBe("MIU_E_GAME_LOBBY_NOT_FOUND");
  expect((await post("eve", "/lobbies/join", { code: "abc" })).status).toBe(400);
});

test("lobby codes expire with the code store TTL", async () => {
  const { post, clock } = setup();
  const { code } = (await post("ann", "/lobbies")).body.lobby;
  clock.advance(6 * 3_600_000);
  expect((await post("bob", "/lobbies/join", { code })).status).toBe(404);
});

test("lobbies need auth, and inspect/cloudflare describe the plugin", async () => {
  const { app, lb } = setup();
  expect((await app.request("/lobbies", { method: "POST" })).status).toBe(401);
  expect(lb.inspect()).toMatchObject({ path: "/lobbies", room: "party", minPlayers: 2, maxPlayers: 4, teams: 2, open: 0 });
  expect(lb.cloudflare()).toEqual({ durableObjects: [{ binding: "MIU_LOBBY", className: "MiuLobbies" }] });
});
