// Adversarial tests for the game kit: cheaters with valid accounts and raw HTTP / WebSocket clients.
import { expect, test } from "bun:test";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock, RoomInstance, rooms, t } from "@miujs/realtime";
import { leaderboard, signScoreProof } from "../src/leaderboard.ts";
import { lobbies } from "../src/lobbies.ts";
import { gameRoom, type MatchInfo } from "../src/room.ts";
import { issueTicket } from "../src/sign.ts";
import { as, fakeSocket, settle, testAuth } from "./helpers.ts";

const SECRET = "security-secret-0123456789abcdef";

const match: MatchInfo = {
  id: "m1",
  queue: "ranked",
  rated: true,
  players: [
    { userId: "u1", name: "Ann", team: 0 },
    { userId: "u2", name: "Bob", team: 1 },
  ],
  teams: [["u1"], ["u2"]],
};

const duel = gameRoom(
  "secduel",
  {
    state: t.object({ started: t.boolean() }),
    client: { start: t.object({}) },
    init: () => ({ started: false }),
    on: {
      start: ({ room, sender }) => {
        if (sender.role !== "host") throw new Error("host only");
        room.state.started = true;
      },
    },
  },
  { secret: SECRET },
);

const ticketFor = (userId: string, now: number, name = userId) =>
  issueTicket(SECRET, { userId, name, roomType: "secduel", roomId: "r1", matchId: "m1", team: userId === "u1" ? 0 : 1 }, now, 60_000);

async function join(inst: RoomInstance, ticket: string, name = "player") {
  const s = fakeSocket();
  inst.connect(s as any, { name, params: { ticket } });
  await settle();
  return s;
}

test("a kicked player cannot come back with a fresh ticket from the matchmaker", async () => {
  const clock = new FakeClock(1_000);
  const inst = new RoomInstance(duel, { id: "r1", clock, data: { match } });
  const a = await join(inst, await ticketFor("u1", clock.now()));
  const pid = a.last("welcome").me.id;
  expect(inst.room.kick(pid)).toBe(true);
  const again = await join(inst, await ticketFor("u1", clock.now()));
  expect(again.last("error").code).toBe("MIU_E_GAME_TICKET_INVALID");
  expect(again.closed?.code).toBe(4003);
  expect(inst.room.players).toEqual([]);
  // Others are unaffected.
  const b = await join(inst, await ticketFor("u2", clock.now()));
  expect(b.events("seated")).toHaveLength(1);
});

test("the ban survives hibernation (it lives in the room's secret state)", async () => {
  const clock = new FakeClock(1_000);
  const inst = new RoomInstance(duel, { id: "r1", clock, data: { match } });
  const a = await join(inst, await ticketFor("u1", clock.now()));
  inst.room.kick(a.last("welcome").me.id);
  const copy = new RoomInstance(duel, { id: "r1", clock, restore: inst.snapshot() });
  const again = await join(copy, await ticketFor("u1", clock.now()));
  expect(again.closed?.code).toBe(4003);
});

test("the display name comes from the ticket, not from ?name= (no impersonating the opponent)", async () => {
  const clock = new FakeClock(1_000);
  const inst = new RoomInstance(duel, { id: "r1", clock, data: { match } });
  const a = await join(inst, await ticketFor("u1", clock.now(), "Ann"), "Bob");
  expect(a.last("welcome").me.name).toBe("Ann");
  expect(inst.room.players[0].name).toBe("Ann");
});

test("game rooms have no first-joiner host: the first ticket holder is a plain player", async () => {
  const clock = new FakeClock(1_000);
  const inst = new RoomInstance(duel, { id: "r1", clock, data: { match } });
  const a = await join(inst, await ticketFor("u1", clock.now()));
  expect(a.last("welcome").me.role).toBe("player");
  await inst.receive(a as any, JSON.stringify({ t: "msg", type: "start", data: {} }));
  await settle();
  expect(inst.describe().state.started).toBe(false);
});

test("a resume-only connection to a random game room id is 404 and creates no room", async () => {
  const realtime = rooms({ rooms: [duel] });
  const { matchmaker } = await import("../src/matchmaker.ts");
  const mm = matchmaker({ rooms: realtime, secret: SECRET, database: sqlite(":memory:"), queues: { q: { room: "secduel", teamSize: 1, rating: "elo", widenAfterMs: 1_000, maxWaitMs: 10_000 } } });
  const app = miu({ plugins: [realtime, mm], logLevel: "silent" });
  for (let i = 0; i < 10; i++) {
    const res = await app.request(`/rooms/secduel/rx${i}?resume=junk`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  }
  expect(realtime.registry.list()).toEqual([]);
  mm.stop();
  realtime.stop();
});

// ---- lobbies ---------------------------------------------------------------------------------

function lobbySetup(o: { joinGuesses?: { perMinute?: number; burst?: number }; creates?: { perMinute?: number; burst?: number } } = {}) {
  const clock = new FakeClock(50_000);
  const party = gameRoom("secparty", { state: t.object({}), init: () => ({}) }, { secret: SECRET });
  const realtime = rooms({ rooms: [party], clock });
  const lb = lobbies({ rooms: realtime, room: "secparty", secret: SECRET, database: sqlite(":memory:"), clock, ...o });
  const app = miu({ plugins: [testAuth(), realtime, lb], logLevel: "silent" });
  const post = async (user: string, path: string, body: unknown = {}) => {
    const r = await app.request(path, as(user, { method: "POST", body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  return { clock, post, realtime, lb };
}

test("lobby join codes cannot be brute forced: wrong codes are rate limited per user", async () => {
  const { post, clock } = lobbySetup({ joinGuesses: { perMinute: 6, burst: 3 } });
  const { code } = (await post("ann", "/lobbies")).body.lobby;
  const wrong = code === "999999" ? "999998" : "999999";
  for (let i = 0; i < 3; i++) expect((await post("eve", "/lobbies/join", { code: wrong })).status).toBe(404);
  const blocked = await post("eve", "/lobbies/join", { code: wrong });
  expect(blocked.status).toBe(429);
  expect(blocked.body.error.code).toBe("MIU_E_GAME_LOBBY_RATE_LIMITED");
  // Locked out even for the right code until the budget refills.
  expect((await post("eve", "/lobbies/join", { code })).status).toBe(429);
  // Friends with the right code are not affected.
  expect((await post("bob", "/lobbies/join", { code })).status).toBe(200);
  clock.advance(10_000);
  expect((await post("eve", "/lobbies/join", { code })).status).toBe(200);
});

test("lobby creation is rate limited per user (no exhausting the code space)", async () => {
  const { post } = lobbySetup({ creates: { perMinute: 6, burst: 3 } });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await post("eve", "/lobbies")).status);
  expect(statuses).toEqual([200, 200, 200, 429, 429]);
  expect((await post("ann", "/lobbies")).status).toBe(200);
});

// ---- leaderboards ---------------------------------------------------------------------------------

test("a score proof cannot be replayed on another isolate (nonces live in the database)", async () => {
  const secret = "proof-secret-0123456789abcdef";
  const db = sqlite(":memory:");
  const clock = new FakeClock(Date.parse("2026-10-15T12:00:00Z"));
  // Two boards over one database: two Workers isolates of the same app.
  const a = leaderboard({ id: "wins", sort: "desc", resets: "weekly", mode: "sum", database: db, clock, clientSubmit: { secret } });
  const b = leaderboard({ id: "wins", sort: "desc", resets: "weekly", mode: "sum", database: db, clock, clientSubmit: { secret } });
  const appA = miu({ plugins: [testAuth(), a], logLevel: "silent" });
  const appB = miu({ plugins: [testAuth(), b], logLevel: "silent" });
  const proof = await signScoreProof(secret, { board: "wins", playerId: "eve", score: 100, nonce: "n1" }, clock.now());
  const body = JSON.stringify({ score: 100, proof });
  expect((await appA.request("/leaderboards/wins/scores", as("eve", { method: "POST", body }))).status).toBe(200);
  const replay = await appB.request("/leaderboards/wins/scores", as("eve", { method: "POST", body }));
  expect(replay.status).toBe(401);
  expect(await a.rank("eve")).toMatchObject({ score: 100 });
});
