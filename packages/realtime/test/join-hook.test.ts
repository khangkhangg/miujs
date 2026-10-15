import { expect, test } from "bun:test";
import { errors } from "miujs";
import { FakeClock } from "../src/clock.ts";
import { createRoomInstance, defineRoom, joinParamsFrom, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const seen: unknown[] = [];
const guarded = defineRoom("guarded", {
  state: t.object({ names: t.array(t.string()) }),
  init: () => ({ names: [] }),
  onJoinRequest: ({ params, player, room }) => {
    seen.push(params);
    if (params.ticket === "bad") throw errors.forbidden("No entry", "Bring a valid ticket.");
    // Only the ticket holder may lead; everyone else watches.
    if (params.ticket === "guide") {
      for (const p of room.players) if (p.role === "host") p.role = "spectator";
      player.role = "host";
    } else player.role = "spectator";
  },
  onJoin: ({ room, player }) => {
    room.state.names = [...room.state.names, `${player.name}:${player.role}`];
  },
});

function setup() {
  seen.length = 0;
  return createRoomInstance(guarded, { id: "G1", clock: new FakeClock(0), hooks: { onError: () => {} } });
}

test("onJoinRequest sees every query param and can set the role", () => {
  const inst = setup();
  const a = fakeSocket();
  inst.connect(a, joinParamsFrom({ name: "Eve", role: "player", ticket: "x", extra: ["1", "2"] }));
  expect(seen[0]).toEqual({ name: "Eve", role: "player", ticket: "x", extra: "1" });
  expect(a.last("welcome").me.role).toBe("spectator");
  const g = fakeSocket();
  inst.connect(g, joinParamsFrom({ name: "Ann", ticket: "guide" }));
  expect(g.last("welcome").me.role).toBe("host");
  expect(g.last("welcome").hostKey).toBeString();
  expect(inst.room.state.names).toEqual(["Eve:spectator", "Ann:host"]);
});

test("throwing rejects the join with the error and closes the socket", () => {
  const inst = setup();
  const s = fakeSocket();
  inst.connect(s, joinParamsFrom({ name: "Mal", ticket: "bad" }));
  expect(s.last("error")).toMatchObject({ code: "MIU_E_FORBIDDEN", message: "No entry", fix: "Bring a valid ticket." });
  expect(s.closed?.code).toBe(4003);
  expect(inst.room.players).toEqual([]);
});

test("join frames carry params too", async () => {
  const inst = setup();
  const s = fakeSocket();
  inst.connect(s, {});
  await inst.receive(s, JSON.stringify({ t: "join", name: "Ann", params: { ticket: "guide" } }));
  expect(s.last("welcome").me.role).toBe("host");
  expect(seen[0]).toEqual({ ticket: "guide", name: "Ann" });
});

test("params are bounded and string-only", () => {
  const inst = setup();
  const q: Record<string, unknown> = { name: "A", big: "x".repeat(5000), obj: { a: 1 } };
  for (let i = 0; i < 100; i++) q[`k${i}`] = "v";
  inst.connect(fakeSocket(), joinParamsFrom(q));
  const p = seen[0] as Record<string, string>;
  expect(Object.keys(p).length).toBeLessThanOrEqual(32);
  expect(p.big).toBeUndefined();
  expect(p.obj).toBeUndefined();
});

test("resumes skip the hook (the seat was already admitted)", () => {
  const inst = setup();
  const s = fakeSocket();
  inst.connect(s, joinParamsFrom({ name: "Ann", ticket: "guide" }));
  const token = s.last("welcome").resumeToken;
  inst.disconnect(s);
  seen.length = 0;
  const again = fakeSocket();
  inst.connect(again, joinParamsFrom({ resume: token }));
  expect(again.last("welcome").resumed).toBe(true);
  expect(seen).toEqual([]);
});
