import { describe, expect, test } from "bun:test";
import { signToken, timingSafeEqual, verifyToken } from "../src/token.ts";

const S1 = "s".repeat(32);
const S2 = "t".repeat(40);
const now = 1_700_000_000;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (err: any) {
    return err.code;
  }
}

describe("signed tokens", () => {
  test("round-trips the payload", async () => {
    const tok = await signToken([S1], { p: "url", k: "a/b.png", m: "GET", e: now + 60, d: "b.png" });
    expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyToken([S1], tok, "url", now)).toEqual({ p: "url", k: "a/b.png", m: "GET", e: now + 60, d: "b.png" });
  });

  test("rejects a token whose payload was edited", async () => {
    const tok = await signToken([S1], { p: "url", k: "a.png", m: "GET", e: now + 60 });
    const [, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "url", k: "secret.pdf", m: "GET", e: now + 60 })).toString("base64url");
    expect(await code(verifyToken([S1], `${forged}.${sig}`, "url", now))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("rejects a token with an edited signature", async () => {
    const tok = await signToken([S1], { p: "url", k: "a.png", m: "GET", e: now + 60 });
    const last = tok.at(-1) === "A" ? "B" : "A";
    expect(await code(verifyToken([S1], tok.slice(0, -1) + last, "url", now))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("rejects a token signed with another secret", async () => {
    const tok = await signToken([S2], { p: "url", k: "a.png", m: "GET", e: now + 60 });
    expect(await code(verifyToken([S1], tok, "url", now))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("rotation: the first secret signs, all of them verify", async () => {
    const old = await signToken([S2], { p: "url", k: "a.png", m: "GET", e: now + 60 });
    expect((await verifyToken([S1, S2], old, "url", now)).k).toBe("a.png");
  });

  test("rejects an expired token, but only after checking the signature", async () => {
    const tok = await signToken([S1], { p: "url", k: "a.png", m: "GET", e: now - 1 });
    expect(await code(verifyToken([S1], tok, "url", now))).toBe("MIU_E_FILES_TOKEN_EXPIRED");
    expect(await code(verifyToken([S2], tok, "url", now))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("a token for one purpose is refused for another", async () => {
    const tok = await signToken([S1], { p: "mpu", k: "a.glb", e: now + 60 });
    expect(await code(verifyToken([S1], tok, "url", now))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test.each(["", "abc", "a.b.c", "!!.??", ".", "e30.AAAA"])("rejects malformed token %p", async (tok) => {
    expect(await code(verifyToken([S1], tok, "url", now))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("timingSafeEqual", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });
});
