import { expect, test } from "bun:test";
import { FakeClock, TokenBucket, createRoomInstance, defineRoom, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const echo = defineRoom("echo", {
  state: t.object({ n: t.number() }),
  client: { inc: t.object({ pad: t.optional(t.string()) }) },
  init: () => ({ n: 0 }),
  on: {
    inc: ({ room }) => {
      room.state.n++;
    },
  },
});

const ping = JSON.stringify({ t: "ping" });

function joined(def = echo) {
  const clock = new FakeClock(0);
  const inst = createRoomInstance(def, { id: "E", clock });
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  a.take();
  return { clock, inst, a };
}

test("TokenBucket allows a burst, then refills at the steady rate", () => {
  const b = new TokenBucket(10, 3, 0);
  expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
  expect(b.take(99)).toBe(false);
  expect(b.take(100)).toBe(true);
  expect(b.take(10_000) && b.take(10_000) && b.take(10_000)).toBe(true);
  expect(b.take(10_000)).toBe(false); // never more than the burst
});

test("default limit: a burst of 60 frames passes, the 61st gets one MIU_E_ROOM_RATE_LIMITED error and is dropped", () => {
  const { inst, a } = joined();
  for (let i = 0; i < 60; i++) inst.receive(a, ping);
  expect(a.take().filter((f) => f.t === "pong").length).toBe(60);
  inst.receive(a, ping);
  inst.receive(a, ping);
  inst.receive(a, ping);
  const out = a.take();
  expect(out).toEqual([{ t: "error", code: "MIU_E_ROOM_RATE_LIMITED", message: expect.any(String), fix: expect.stringContaining("30") }]);
  expect(a.closed).toBeNull();
});

test("the limit refills at 30 messages per second", () => {
  const { inst, a, clock } = joined();
  for (let i = 0; i < 60; i++) inst.receive(a, ping);
  clock.advance(1_000);
  a.take();
  for (let i = 0; i < 31; i++) inst.receive(a, ping);
  const out = a.take();
  expect(out.filter((f) => f.t === "pong").length).toBe(30);
  expect(out.at(-1).code).toBe("MIU_E_ROOM_RATE_LIMITED");
});

test("sustained flooding (over the limit for 3 s without a quiet second) disconnects with 4008", () => {
  const { inst, a, clock } = joined();
  for (let step = 0; step < 40 && !a.closed; step++) {
    for (let i = 0; i < 10; i++) inst.receive(a, ping); // 100 msg/s
    clock.advance(100);
  }
  expect(a.closed?.code).toBe(4008);
  expect(a.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_RATE_LIMITED" });
  expect(clock.now()).toBeGreaterThanOrEqual(3_000);
  expect(clock.now()).toBeLessThan(4_000);
  expect(inst.room.players[0].connected).toBe(false); // keeps the seat; a resume is still possible
});

test("short bursts separated by quiet seconds are never kicked", () => {
  const { inst, a, clock } = joined();
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 80; i++) inst.receive(a, ping);
    clock.advance(1_500);
  }
  expect(a.closed).toBeNull();
});

test("rateLimit is configurable per room, and false turns it off", () => {
  const strict = defineRoom("strict", { state: t.object({}), init: () => ({}), rateLimit: { perSecond: 1, burst: 2 } });
  const s = joined(strict as any);
  for (let i = 0; i < 3; i++) s.inst.receive(s.a, ping);
  expect(s.a.take().map((f) => f.t)).toEqual(["pong", "pong", "error"]);

  const open = defineRoom("open", { state: t.object({}), init: () => ({}), rateLimit: false });
  const o = joined(open as any);
  for (let i = 0; i < 500; i++) o.inst.receive(o.a, ping);
  expect(o.a.take().every((f) => f.t === "pong")).toBe(true);
});

test("frames over maxMessageBytes (counted in UTF-8 bytes) get MIU_E_ROOM_MESSAGE_TOO_LARGE and close 1009", () => {
  const small = defineRoom("small", {
    state: t.object({ n: t.number() }),
    client: { inc: t.object({ pad: t.optional(t.string()) }) },
    init: () => ({ n: 0 }),
    maxMessageBytes: 64,
  });
  const ok = JSON.stringify({ t: "msg", type: "inc", data: { pad: "x".repeat(20) } });
  expect(new TextEncoder().encode(ok).length).toBeLessThanOrEqual(64);
  const s = joined(small as any);
  s.inst.receive(s.a, ok);
  expect(s.a.closed).toBeNull();
  // 20 two-byte characters: short in UTF-16 length, too long in bytes.
  s.inst.receive(s.a, JSON.stringify({ t: "msg", type: "inc", data: { pad: "é".repeat(20) } }));
  expect(s.a.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_MESSAGE_TOO_LARGE" });
  expect(s.a.closed?.code).toBe(1009);
});

test("the default max message size is 16 KiB", () => {
  const { inst, a } = joined();
  inst.receive(a, JSON.stringify({ t: "msg", type: "inc", data: { pad: "x".repeat(16_000) } }));
  expect(a.closed).toBeNull();
  inst.receive(a, JSON.stringify({ t: "msg", type: "inc", data: { pad: "x".repeat(16_400) } }));
  expect(a.last().code).toBe("MIU_E_ROOM_MESSAGE_TOO_LARGE");
  expect(a.closed?.code).toBe(1009);
});
