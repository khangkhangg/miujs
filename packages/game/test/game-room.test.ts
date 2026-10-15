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

function setup(o: { id?: string; env?: Record<string, unknown> } = {}) {
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
    { secret: SECRET, report: async (matchId, result, env) => (reports.push({ matchId, result, env }), { summary: reports.length }) },
  );
  const clock = new FakeClock(1_000);
  const inst = new RoomInstance(duel, { id: o.id ?? "r1", clock, data: { match }, env: o.env });
  return { inst, clock, seated, reports, duel };
}

const ticketFor = (userId: string, o: { roomId?: string; now?: number; ttl?: number; name?: string; matchId?: string; secret?: string } = {}) =>
  issueTicket(o.secret ?? SECRET, { userId, name: o.name ?? userId, roomType: "duel", roomId: o.roomId ?? "r1", matchId: o.matchId ?? "m1", team: userId === "u1" ? 0 : 1 }, o.now ?? 1_000, o.ttl ?? 30_000);

async function join(inst: RoomInstance, ticket?: string, name = "player") {
  const s = fakeSocket();
  inst.connect(s as any, { name, params: ticket === undefined ? {} : { ticket } });
  await settle();
  return s;
}

async function send(inst: RoomInstance, s: any, f: unknown) {
  await inst.receive(s, JSON.stringify(f));
  await settle();
}

test("a join without a ticket is refused before seating (4003), taking no seat", async () => {
  const { inst } = setup();
  const a = await join(inst);
  expect(a.last("error")).toMatchObject({ code: "MIU_E_GAME_TICKET_REQUIRED" });
  expect(a.closed?.code).toBe(4003);
  expect(inst.room.players).toEqual([]);
});

test("a valid ticket in the join params seats the player: onSeat runs, seated event, play works", async () => {
  const { inst, seated } = setup();
  const a = await join(inst, await ticketFor("u1", { name: "Ann" }), "Ann");
  const me = a.last("welcome").me.id;
  expect(a.last("state").state.names).toEqual({ u1: "Ann", u2: "Bob" });
  expect(seated).toEqual([{ player: me, userId: "u1", name: "Ann", team: 0, matchId: "m1", hidden: 42 }]);
  expect(a.events("seated").map((e) => e.data)).toEqual([{ userId: "u1", name: "Ann", team: 0, matchId: "m1" }]);
  await send(inst, a, { t: "msg", type: "tap", data: {} });
  expect(inst.describe().state.taps).toEqual({ u1: 1 });
  expect(seatOf(inst.room, me)).toEqual({ userId: "u1", name: "Ann", team: 0, matchId: "m1" });
  expect(matchOf(inst.room)).toEqual(match);
  // Engine clients also send the ticket message: a silent no-op once seated.
  await send(inst, a, { t: "msg", type: "ticket", data: { ticket: await ticketFor("u1") } });
  expect(a.events("seated")).toHaveLength(1);
  expect(a.last("error")).toBeUndefined();
});

test("tickets for another room, expired, forged, off-roster or another match are refused at join", async () => {
  const { inst, clock } = setup();
  const soon = await ticketFor("u1", { ttl: 5_000 });
  const cases: [string, string][] = [
    [await ticketFor("u1", { roomId: "r2" }), "MIU_E_GAME_TICKET_INVALID"],
    [await ticketFor("u1", { secret: "someone-elses-secret-0123456" }), "MIU_E_GAME_TICKET_INVALID"],
    [await ticketFor("eve"), "MIU_E_GAME_TICKET_INVALID"],
    [await ticketFor("u1", { matchId: "m0" }), "MIU_E_GAME_TICKET_INVALID"],
  ];
  for (const [ticket, code] of cases) {
    const s = await join(inst, ticket);
    expect(s.last("error").code).toBe(code);
    expect(s.closed?.code).toBe(4003);
  }
  clock.advance(5_000);
  expect((await join(inst, soon)).last("error").code).toBe("MIU_E_GAME_TICKET_EXPIRED");
  expect(inst.room.players).toEqual([]);
});

test("one seat per user: a second join with the same ticket is refused while the first is in the room", async () => {
  const { inst, clock } = setup();
  const tk = await ticketFor("u1");
  const a = await join(inst, tk);
  const b = await join(inst, tk);
  expect(b.last("error").code).toBe("MIU_E_GAME_TICKET_USED");
  // Once the first player is gone for good (after the reconnect grace), the user may sit again.
  inst.disconnect(a as any);
  clock.advance(30_000);
  const c = await join(inst, await ticketFor("u1", { now: clock.now() }));
  expect(c.events("seated")).toHaveLength(1);
});

test("resuming keeps the seat without a ticket", async () => {
  const { inst, seated } = setup();
  const a = await join(inst, await ticketFor("u1"));
  const token = a.last("welcome").resumeToken;
  inst.disconnect(a as any);
  const again = fakeSocket();
  inst.connect(again as any, { resume: token });
  await settle();
  expect(again.last("welcome").resumed).toBe(true);
  await send(inst, again, { t: "msg", type: "tap", data: {} });
  expect(inst.describe().state.taps).toEqual({ u1: 1 });
  expect(seated).toHaveLength(1);
});

test("shard-aware: a shard instance (r1:shard2) accepts tickets issued for the base room r1", async () => {
  const { inst } = setup({ id: "r1:shard2" });
  const a = await join(inst, await ticketFor("u1"));
  expect(a.events("seated")).toHaveLength(1);
});

test("seats survive a snapshot/restore (Durable Object hibernation) and never reach clients", async () => {
  const { inst, duel } = setup();
  const a = await join(inst, await ticketFor("u1"));
  const me = a.last("welcome").me.id;
  const copy = new RoomInstance(duel, { id: "r1", clock: new FakeClock(2_000), restore: inst.snapshot() });
  expect(seatOf(copy.room, me)).toMatchObject({ userId: "u1" });
  expect(JSON.stringify(a.frames)).not.toContain("hidden");
});

test("reportResult maps player ids to users, reports once with room.env, and refuses unseated players", async () => {
  const { inst, reports } = setup({ env: { DB: "d1-binding" } });
  const a = await join(inst, await ticketFor("u1"));
  const b = await join(inst, await ticketFor("u2"));
  const pa = a.last("welcome").me.id;
  const pb = b.last("welcome").me.id;
  await expect(reportResult(inst.room, { winners: ["p_nobody"] })).rejects.toThrow(/did not play/);
  expect(reports).toEqual([]);
  expect(await reportResult<unknown>(inst.room, { ranking: [[pa], [pb]] })).toEqual({ reported: true, result: { ranking: [["u1"], ["u2"]] }, summary: { summary: 1 } });
  expect(reports).toEqual([{ matchId: "m1", result: { ranking: [["u1"], ["u2"]] }, env: { DB: "d1-binding" } }]);
  await reportResult(inst.room, { winners: [pb] });
  expect(reports).toHaveLength(1);
});

test("open: spectators may join without a ticket when spectators are allowed", async () => {
  const spect = gameRoom("watch", { state: t.object({}), init: () => ({}) }, { secret: SECRET, spectators: true });
  const inst = new RoomInstance(spect, { id: "w1", clock: new FakeClock(0), data: { match } });
  const s = fakeSocket();
  inst.connect(s as any, { name: "fan", role: "spectator", params: {} });
  expect(s.last("welcome").me.role).toBe("spectator");
  const p = fakeSocket();
  inst.connect(p as any, { name: "sneaky", params: {} });
  expect(p.closed?.code).toBe(4003);
});

test("a client message named ticket is reserved", () => {
  expect(() => gameRoom("x", { state: t.object({}), client: { ticket: t.object({}) }, init: () => ({}) }, { secret: SECRET })).toThrow(/ticket/);
});
