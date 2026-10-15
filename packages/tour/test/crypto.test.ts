import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { hashPassword, signProcessorBody, signTourToken, verifyPassword, verifyProcessorSignature, verifyTourToken } from "../src/crypto.ts";

const S = "s".repeat(40);
const S2 = "t".repeat(40);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isMiuError(e)) return e.code;
    throw e;
  }
  return "no error";
}

describe("tour tokens", () => {
  test("round-trip a share token", async () => {
    const tok = await signTourToken([S], { p: "share", tour: "tour_1", v: 1, e: 2000 });
    expect(await verifyTourToken([S], tok, "share", 1000)).toEqual({ p: "share", tour: "tour_1", v: 1, e: 2000 });
  });

  test("expired, wrong purpose, tampered and wrong secret are rejected", async () => {
    const tok = await signTourToken([S], { p: "share", tour: "tour_1", v: 1, e: 2000 });
    expect(await code(verifyTourToken([S], tok, "share", 2001))).toBe("MIU_E_TOUR_TOKEN_EXPIRED");
    expect(await code(verifyTourToken([S], tok, "unlock", 1000))).toBe("MIU_E_TOUR_TOKEN_INVALID");
    expect(await code(verifyTourToken([S2], tok, "share", 1000))).toBe("MIU_E_TOUR_TOKEN_INVALID");
    const [body, sig] = tok.split(".");
    const forged = btoa(JSON.stringify({ p: "share", tour: "tour_2", v: 1, e: 2000 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(await code(verifyTourToken([S], `${forged}.${sig}`, "share", 1000))).toBe("MIU_E_TOUR_TOKEN_INVALID");
    expect(await code(verifyTourToken([S], `${body}`, "share", 1000))).toBe("MIU_E_TOUR_TOKEN_INVALID");
    expect(await code(verifyTourToken([S], "x".repeat(5000), "share", 1000))).toBe("MIU_E_TOUR_TOKEN_INVALID");
  });

  test("rotated secrets still verify; signing uses the first", async () => {
    const old = await signTourToken([S2], { p: "tiles", tour: "t", prefix: "a/b", e: 2000 });
    expect((await verifyTourToken([S, S2], old, "tiles", 1000)).prefix).toBe("a/b");
  });

  test("signing is deterministic, so equal payloads give equal (cacheable) URLs", async () => {
    const a = await signTourToken([S], { p: "tiles", tour: "t", prefix: "x", e: 5 });
    const b = await signTourToken([S], { p: "tiles", tour: "t", prefix: "x", e: 5 });
    expect(a).toBe(b);
  });
});

describe("passwords", () => {
  test("hash and verify", async () => {
    const h = await hashPassword("open sesame");
    expect(h.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(h).not.toContain("open sesame");
    expect(await verifyPassword("open sesame", h)).toBe(true);
    expect(await verifyPassword("open sesam", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  test("two hashes of the same password differ (random salt)", async () => {
    expect(await hashPassword("pw")).not.toBe(await hashPassword("pw"));
  });
});

describe("processor signatures", () => {
  test("verify a signed body within the tolerance", async () => {
    const body = JSON.stringify({ a: 1 });
    const header = await signProcessorBody(S, body, 1000);
    expect(header).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
    expect(await verifyProcessorSignature([S], header, body, 1100)).toBe(true);
  });

  test("reject a changed body, a wrong secret, an old timestamp and junk", async () => {
    const body = JSON.stringify({ a: 1 });
    const header = await signProcessorBody(S, body, 1000);
    expect(await verifyProcessorSignature([S], header, body + " ", 1000)).toBe(false);
    expect(await verifyProcessorSignature([S2], header, body, 1000)).toBe(false);
    expect(await verifyProcessorSignature([S], header, body, 1000 + 301)).toBe(false);
    expect(await verifyProcessorSignature([S], header, body, 1000 - 301)).toBe(false);
    expect(await verifyProcessorSignature([S], "nonsense", body, 1000)).toBe(false);
    expect(await verifyProcessorSignature([S], null, body, 1000)).toBe(false);
  });
});
