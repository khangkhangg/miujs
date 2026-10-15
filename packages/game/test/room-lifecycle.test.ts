// Finished games must not pin memory: after reportResult the room closes after
// `closeAfterResultMs` (a named, durable timer), with a final `game.closed` event first.

import { expect, test } from "bun:test";
import { FakeClock, RoomInstance, rooms, t } from "@miujs/realtime";
import { gameRoom, reportResult, type MatchInfo } from "../src/room.ts";
import { issueTicket } from "../src/sign.ts";
import { fakeSocket, settle } from "./helpers.ts";

const SECRET = "life-secret-0123456789abcdef";
const players = [
  { userId: "u1", name: "A", team: 0 },
  { userId: "u2", name: "B", team: 1 },
];
const matchFor = (id: string): MatchInfo => ({ id, queue: "q", rated: true, players, teams: [["u1"], ["u2"]] });

function type(name: string, closeAfterResultMs?: number | false) {
  return gameRoom(name, { state: t.object({}), init: () => ({}) }, { secret: SECRET, report: async () => ({ ok: true }), closeAfterResultMs });
}

test("after reportResult the room sends game.closed and closes after closeAfterResultMs", async () => {
  const clock = new FakeClock(0);
  const inst = new RoomInstance(type("life1", 5_000), { id: "r1", clock, data: { match: matchFor("m1") } });
  const s = fakeSocket();
  inst.connect(s as any, { name: "A", params: { ticket: await issueTicket(SECRET, { userId: "u1", name: "A", roomType: "life1", roomId: "r1", matchId: "m1", team: 0 }, 0) } });
  await settle();
  await reportResult(inst.room, { winners: ["u1"] });
  expect(inst.snapshot().timers!.map((x) => x.name)).toEqual(["__miu_game_close"]);
  clock.advance(4_999);
  expect(inst.isClosed).toBe(false);
  clock.advance(1);
  await settle();
  expect(s.events("game.closed").map((e) => e.data)).toEqual([{ reason: "game over" }]);
  expect(inst.isClosed).toBe(true);
  expect(s.closed?.code).toBe(1000);
});

test("the close timer is durable (Durable Object alarm path) and closeAfterResultMs: false keeps the room", async () => {
  const clock = new FakeClock(0);
  const durable = new RoomInstance(type("life2"), { id: "r1", clock, durable: true, data: { match: matchFor("m1") } });
  await reportResult(durable.room, { winners: ["u1"] });
  expect(durable.nextDue()).toBe(5_000); // default 5 s
  const revived = new RoomInstance(type("life2"), { id: "r1", clock, durable: true, restore: durable.snapshot() });
  clock.advance(5_000);
  await revived.runDue();
  expect(revived.isClosed).toBe(true);

  const keep = new RoomInstance(type("life3", false), { id: "r1", clock, data: { match: matchFor("m1") } });
  await reportResult(keep.room, { winners: ["u1"] });
  clock.advance(60_000);
  expect(keep.isClosed).toBe(false);
});

test("health: thousands of finished games keep live rooms bounded by rate × closeAfterResultMs", async () => {
  const clock = new FakeClock(0);
  const life = type("life4", 500);
  const realtime = rooms({ rooms: [life], clock });
  const perTick = 10; // 10 games every 10 ms = 1 000 games/s
  let peak = 0;
  let games = 0;
  for (let tick = 0; tick < 400; tick++) {
    for (let i = 0; i < perTick; i++) {
      const matchId = `m${games++}`;
      const { id } = await realtime.createRoom("life4", { data: { match: matchFor(matchId) }, code: false });
      const inst = realtime.registry.get("life4", id)!;
      const socks = [];
      for (const p of players) {
        const s = fakeSocket();
        inst.connect(s as any, { name: p.name, params: { ticket: await issueTicket(SECRET, { userId: p.userId, name: p.name, roomType: "life4", roomId: id, matchId, team: p.team }, clock.now()) } });
        socks.push(s);
      }
      await reportResult(inst.room, { winners: ["u1"] });
      for (const s of socks) realtime.registry.disconnected(inst, s as any); // players leave: reconnect grace starts
    }
    clock.advance(10);
    peak = Math.max(peak, realtime.registry.list().length);
  }
  expect(games).toBe(4_000);
  // 1 000 games/s × 0.5 s ≈ 500 live rooms (+ one tick of slack), not 4 000 (or 60 s worth).
  expect(peak).toBeLessThanOrEqual(1_000 * 0.5 + perTick * 2);
  clock.advance(1_000);
  expect(realtime.registry.list().length).toBe(0);
}, 60_000);
