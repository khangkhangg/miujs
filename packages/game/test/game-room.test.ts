import { expect, test } from "bun:test";
import { FakeClock, RoomInstance, t } from "@miujs/realtime";
import { gameRoom, matchOf, reportResult, seatOf, type MatchInfo } from "../src/room.ts";
import { issueTicket } from "../src/sign.ts";
import { fakeSocket, settle } from "./helpers.ts";

const SECRET = "room-secret-0123456789abcdef";

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

function setup(extra: { report?: (matchId: string, result: unknown) => Promise<unknown> } = {}) {
  const seated: any[] = [];
  const reports: any[] = [];
  const duel = gameRoom(
    "duel",
    {
      state: t.object({ taps: t.record(t.number()), names: t.record(t.string()) }),
      client: { tap: t.object({}) },
      init: ({ match }) => ({ taps: {}, names: Object.fromEntries((match?.players ?? []).map((p) => [p.userId, p.name])) }),
      secret: () => ({ hidden: 42 }),
      onSeat: ({ room, player, seat }) => {
        seated.push({ player: player.id, ...seat, hidden: room.secret.hidden });
        room.state.taps[seat.userId] = 0;
      },
      on: {
        tap: ({ room, sender }) => {
          const seat = seatOf(room, sender.id)!;
          room.state.taps[seat.userId] += 1;
        },
      },
    },
    { secret: SECRET, report: extra.report ?? (async (matchId, result) => (reports.push({ matchId, result }), { summary: reports.length })) },
  );
  const clock = new FakeClock(1_000);
  const inst = new RoomInstance(duel, { id: "r1", clock, data: { match } });
  return { inst, clock, seated, reports, duel };
}

const ticketFor = (userId: string, o: { roomId?: string; now?: number; ttl?: number; name?: string } = {}) =>
  issueTicket(SECRET, { userId, name: o.name ?? userId, roomType: "duel", roomId: o.roomId ?? "r1", matchId: "m1", team: userId === "u1" ? 0 : 1 }, o.now ?? 1_000, o.ttl ?? 30_000);

async function send(inst: RoomInstance, s: any, f: unknown) {
  await inst.receive(s, JSON.stringify(f));
  await settle();
}

test("init sees the match; game messages are refused until a ticket is presented", async () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a as any, { name: "whatever" });
  expect(a.last("state").state).toEqual({ taps: {}, names: { u1: "Ann", u2: "Bob" } });
  await send(inst, a, { t: "msg", type: "tap", data: {}, id: 1 });
  expect(a.last("error")).toMatchObject({ code: "MIU_E_GAME_TICKET_REQUIRED", id: 1 });
});

test("a valid ticket seats the player: onSeat runs, a seated event arrives, and play works", async () => {
  const { inst, seated } = setup();
  const a = fakeSocket();
  inst.connect(a as any, { name: "Ann" });
  const me = a.last("welcome").me.id;
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u1", { name: "Ann" }) } });
  expect(seated).toEqual([{ player: me, userId: "u1", name: "Ann", team: 0, matchId: "m1", hidden: 42 }]);
  expect(a.events("seated")[0].data).toEqual({ userId: "u1", name: "Ann", team: 0, matchId: "m1" });
  await send(inst, a, { t: "msg", type: "tap", data: {} });
  expect(inst.describe().state.taps).toEqual({ u1: 1 });
  expect(seatOf(inst.room, me)).toEqual({ userId: "u1", name: "Ann", team: 0, matchId: "m1" });
  expect(matchOf(inst.room)).toEqual(match);
});

test("tickets for another room, expired tickets and forged tickets are refused", async () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  inst.connect(a as any, { name: "Ann" });
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u1", { roomId: "r2" }) } });
  expect(a.last("error").code).toBe("MIU_E_GAME_TICKET_INVALID");
  const soon = await ticketFor("u1", { ttl: 5_000 });
  clock.advance(5_000);
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: soon } });
  expect(a.last("error").code).toBe("MIU_E_GAME_TICKET_EXPIRED");
  const forged = await issueTicket("someone-elses-secret-0123456", { userId: "u1", name: "x", roomType: "duel", roomId: "r1", matchId: "m1", team: 0 }, clock.now());
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: forged } });
  expect(a.last("error").code).toBe("MIU_E_GAME_TICKET_INVALID");
  expect(a.events("seated")).toEqual([]);
});

test("users outside the match roster or from another match are refused", async () => {
  const { inst } = setup();
  const a = fakeSocket();
  inst.connect(a as any, { name: "Eve" });
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await issueTicket(SECRET, { userId: "eve", name: "Eve", roomType: "duel", roomId: "r1", matchId: "m1", team: 0 }, 1_000) } });
  expect(a.last("error")).toMatchObject({ code: "MIU_E_GAME_TICKET_INVALID" });
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await issueTicket(SECRET, { userId: "u1", name: "Ann", roomType: "duel", roomId: "r1", matchId: "m0", team: 0 }, 1_000) } });
  expect(a.last("error")).toMatchObject({ code: "MIU_E_GAME_TICKET_INVALID" });
  expect(a.events("seated")).toEqual([]);
});

test("one seat per user: a second player with the same ticket is refused while the first is in the room", async () => {
  const { inst, clock } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a as any, { name: "Ann" });
  inst.connect(b as any, { name: "Ann again" });
  const tk = await ticketFor("u1");
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: tk } });
  await send(inst, b, { t: "msg", type: "ticket", data: { ticket: tk } });
  expect(b.last("error").code).toBe("MIU_E_GAME_TICKET_USED");
  // Presenting it again on the same seat is harmless.
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: tk } });
  expect(a.events("seated")).toHaveLength(2);
  // Once the first player is gone for good (after the reconnect grace), the user may sit again.
  inst.disconnect(a as any);
  clock.advance(30_000);
  await send(inst, b, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u1", { now: clock.now() }) } });
  expect(b.events("seated")).toHaveLength(1);
});

test("seats survive a snapshot/restore (Durable Object hibernation) and never reach clients", async () => {
  const { inst, duel } = setup();
  const a = fakeSocket();
  inst.connect(a as any, { name: "Ann" });
  const me = a.last("welcome").me.id;
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u1") } });
  const copy = new RoomInstance(duel, { id: "r1", clock: new FakeClock(2_000), restore: inst.snapshot() });
  expect(seatOf(copy.room, me)).toMatchObject({ userId: "u1" });
  expect(JSON.stringify(a.frames)).not.toContain("hidden");
});

test("reportResult maps player ids to users, reports once, and refuses unseated players", async () => {
  const { inst, reports } = setup();
  const a = fakeSocket();
  const b = fakeSocket();
  inst.connect(a as any, { name: "Ann" });
  inst.connect(b as any, { name: "Bob" });
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u1") } });
  await send(inst, b, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u2") } });
  const pa = a.last("welcome").me.id;
  const pb = b.last("welcome").me.id;
  await expect(reportResult(inst.room, { winners: ["p_nobody"] })).rejects.toThrow(/did not play/);
  expect(reports).toEqual([]);
  expect(await reportResult<unknown>(inst.room, { ranking: [[pa], [pb]] })).toEqual({ reported: true, result: { ranking: [["u1"], ["u2"]] }, summary: { summary: 1 } });
  expect(reports).toEqual([{ matchId: "m1", result: { ranking: [["u1"], ["u2"]] } }]);
  await reportResult(inst.room, { winners: [pb] });
  expect(reports).toHaveLength(1);
});

test("a client message named ticket is reserved", () => {
  expect(() => gameRoom("x", { state: t.object({}), client: { ticket: t.object({}) }, init: () => ({}) }, { secret: SECRET })).toThrow(/ticket/);
});
