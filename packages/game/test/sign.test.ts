import { expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { signToken, verifyToken, gameSecret, issueTicket, verifyTicket } from "../src/sign.ts";

const SECRET = "test-secret-0123456789abcdef";

test("signed tokens round-trip their payload and kind", async () => {
  const tok = await signToken(SECRET, "ticket", { u: "user1", exp: 2000 });
  expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(await verifyToken(SECRET, "ticket", tok, 1000)).toMatchObject({ u: "user1", exp: 2000 });
});

test("tampered, re-kinded, foreign-secret and expired tokens are rejected with MIU_E_GAME_TICKET_*", async () => {
  const tok = await signToken(SECRET, "ticket", { u: "user1", exp: 2000 });
  const [body, sig] = tok.split(".");
  const forged = btoa(JSON.stringify({ k: "ticket", u: "admin", exp: 2000 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const codes: string[] = [];
  for (const attempt of [
    () => verifyToken(SECRET, "ticket", `${forged}.${sig}`, 1000),
    () => verifyToken(SECRET, "proof", tok, 1000),
    () => verifyToken("another-secret-0123456789", "ticket", tok, 1000),
    () => verifyToken(SECRET, "ticket", `${body}`, 1000),
  ]) {
    try {
      await attempt();
      codes.push("accepted");
    } catch (e) {
      codes.push(isMiuError(e) ? e.code : String(e));
    }
  }
  expect(codes).toEqual(["MIU_E_GAME_TICKET_INVALID", "MIU_E_GAME_TICKET_INVALID", "MIU_E_GAME_TICKET_INVALID", "MIU_E_GAME_TICKET_INVALID"]);
  const expired = await verifyToken(SECRET, "ticket", tok, 2000).catch((e) => e);
  expect(expired.code).toBe("MIU_E_GAME_TICKET_EXPIRED");
  expect(expired.fix).toContain("ticket");
});

test("tickets bind a user to one room and expire after ttl", async () => {
  const ticket = await issueTicket(SECRET, { userId: "u1", name: "Ann", roomType: "arena", roomId: "r1", matchId: "m1", team: 0 }, 1_000, 30_000);
  const t = await verifyTicket(SECRET, ticket, { roomType: "arena", roomId: "r1", now: 5_000 });
  expect(t).toEqual({ userId: "u1", name: "Ann", roomType: "arena", roomId: "r1", matchId: "m1", team: 0, exp: 31_000 });
  const wrongRoom = await verifyTicket(SECRET, ticket, { roomType: "arena", roomId: "r2", now: 5_000 }).catch((e) => e);
  expect(wrongRoom.code).toBe("MIU_E_GAME_TICKET_INVALID");
  const late = await verifyTicket(SECRET, ticket, { roomType: "arena", roomId: "r1", now: 31_000 }).catch((e) => e);
  expect(late.code).toBe("MIU_E_GAME_TICKET_EXPIRED");
});

test("gameSecret: explicit secrets must be long; without one a per-process dev secret is used off Workers", () => {
  expect(gameSecret("x".repeat(32))).toBe("x".repeat(32));
  expect(() => gameSecret("short")).toThrow(/MIU_E_GAME_SECRET|at least/);
  const dev = gameSecret(undefined, { env: {}, runtime: "bun" });
  expect(dev.length).toBeGreaterThanOrEqual(32);
  expect(gameSecret(undefined, { env: {}, runtime: "bun" })).toBe(dev);
  expect(gameSecret(undefined, { env: { MIU_GAME_SECRET: "y".repeat(40) }, runtime: "workerd" })).toBe("y".repeat(40));
  let code = "";
  try {
    gameSecret(undefined, { env: {}, runtime: "workerd" });
  } catch (e: any) {
    code = e.code;
  }
  expect(code).toBe("MIU_E_GAME_SECRET_MISSING");
});

test("verifyTicketSync (for synchronous onJoinRequest) agrees with the async check", async () => {
  const { verifyTicketSync } = await import("../src/sign.ts");
  const ticket = await issueTicket(SECRET, { userId: "u1", name: "Ann", roomType: "arena", roomId: "r1", matchId: "m1", team: 1 }, 0, 1_000);
  expect(verifyTicketSync(SECRET, ticket, { roomType: "arena", roomId: "r1", now: 10 })).toEqual(await verifyTicket(SECRET, ticket, { roomType: "arena", roomId: "r1", now: 10 }));
  const code = (f: () => unknown) => {
    try {
      f();
      return "ok";
    } catch (e: any) {
      return e.code;
    }
  };
  expect(code(() => verifyTicketSync(SECRET, ticket.slice(0, -2) + "xx", { roomType: "arena", roomId: "r1", now: 10 }))).toBe("MIU_E_GAME_TICKET_INVALID");
  expect(code(() => verifyTicketSync("other-secret-0123456789abcd", ticket, { roomType: "arena", roomId: "r1", now: 10 }))).toBe("MIU_E_GAME_TICKET_INVALID");
  expect(code(() => verifyTicketSync(SECRET, ticket, { roomType: "arena", roomId: "r2", now: 10 }))).toBe("MIU_E_GAME_TICKET_INVALID");
  expect(code(() => verifyTicketSync(SECRET, ticket, { roomType: "arena", roomId: "r1", now: 1_000 }))).toBe("MIU_E_GAME_TICKET_EXPIRED");
  expect(code(() => verifyTicketSync(SECRET, 42, { roomType: "arena", roomId: "r1", now: 1 }))).toBe("MIU_E_GAME_TICKET_INVALID");
});
