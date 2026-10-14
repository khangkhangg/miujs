import { describe, expect, test } from "bun:test";
import { signJwt, verifyJwt } from "../../src/batteries/auth/jwt.ts";
import { HttpError } from "../../src/core/errors.ts";

const SECRET = "jwt-secret-jwt-secret-jwt-secret-!!";
const T0 = 1_700_000_000_000;

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function expectInvalid(p: Promise<unknown>, match?: RegExp) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as HttpError).code).toBe("invalid_token");
    if (match) expect((err as HttpError).message).toMatch(match);
    return;
  }
  throw new Error("expected verifyJwt to throw");
}

describe("JWT HS256", () => {
  test("round-trips claims and sets iat/exp/iss/aud", async () => {
    const token = await signJwt({ sub: "u1", role: "admin" }, SECRET, {
      expiresIn: 60,
      issuer: "miu",
      audience: "api",
      now: () => T0,
    });
    expect(token.split(".")).toHaveLength(3);
    const header = JSON.parse(atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    const payload = await verifyJwt(token, SECRET, { issuer: "miu", audience: "api", now: () => T0 + 1000 });
    expect(payload).toMatchObject({ sub: "u1", role: "admin", iss: "miu", aud: "api", iat: T0 / 1000, exp: T0 / 1000 + 60 });
  });

  test("rejects a wrong secret", async () => {
    const token = await signJwt({ sub: "u1" }, SECRET);
    await expectInvalid(verifyJwt(token, "another-secret-another-secret-!!!!"), /signature/);
  });

  test("rejects a tampered payload", async () => {
    const token = await signJwt({ sub: "u1", role: "user" }, SECRET);
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ sub: "u1", role: "admin" }))}.${s}`;
    await expectInvalid(verifyJwt(forged, SECRET), /signature/);
  });

  test('rejects alg "none" and other algorithms', async () => {
    const payload = b64url(JSON.stringify({ sub: "u1" }));
    await expectInvalid(verifyJwt(`${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${payload}.`, SECRET), /alg/);
    await expectInvalid(verifyJwt(`${b64url(JSON.stringify({ alg: "RS256" }))}.${payload}.abc`, SECRET), /alg/);
  });

  test("rejects malformed tokens", async () => {
    await expectInvalid(verifyJwt("not-a-jwt", SECRET));
    await expectInvalid(verifyJwt("a.b.c", SECRET));
    await expectInvalid(verifyJwt("", SECRET));
  });

  test("enforces exp with leeway", async () => {
    const token = await signJwt({ sub: "u1" }, SECRET, { expiresIn: 60, now: () => T0 });
    await verifyJwt(token, SECRET, { now: () => T0 + 64_000 }); // within default 5s leeway
    await expectInvalid(verifyJwt(token, SECRET, { now: () => T0 + 66_000 }), /expired/);
    await expectInvalid(verifyJwt(token, SECRET, { now: () => T0 + 61_000, leeway: 0 }), /expired/);
  });

  test("enforces nbf", async () => {
    const token = await signJwt({ sub: "u1", nbf: T0 / 1000 + 100 }, SECRET, { now: () => T0 });
    await expectInvalid(verifyJwt(token, SECRET, { now: () => T0 }), /not yet valid/);
    await verifyJwt(token, SECRET, { now: () => T0 + 100_000 });
  });

  test("enforces issuer and audience", async () => {
    const token = await signJwt({ sub: "u1" }, SECRET, { issuer: "miu", audience: ["api", "web"] });
    await verifyJwt(token, SECRET, { issuer: "miu", audience: "web" });
    await expectInvalid(verifyJwt(token, SECRET, { issuer: "other" }), /issuer/);
    await expectInvalid(verifyJwt(token, SECRET, { audience: "admin" }), /audience/);
    const noAud = await signJwt({ sub: "u1" }, SECRET);
    await expectInvalid(verifyJwt(noAud, SECRET, { audience: "api" }), /audience/);
  });
});
