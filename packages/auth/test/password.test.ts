import { describe, expect, test } from "bun:test";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { hashPassword, needsRehash, verifyPassword } from "../src/password.ts";

const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };

/** A Django `make_password` hash, computed independently with node:crypto. */
function djangoHash(password: string, salt: string, iterations: number): string {
  const dk = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64");
  return `pbkdf2_sha256$${iterations}$${salt}$${dk}`;
}

describe("pbkdf2", () => {
  test("hash format is pbkdf2_sha256$<iterations>$<salt>$<hash>", async () => {
    const h = await hashPassword("hunter2hunter2", FAST);
    const parts = h.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("pbkdf2_sha256");
    expect(parts[1]).toBe("1000");
    expect(parts[2].length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(parts[3], "base64").length).toBe(32);
  });

  test("salts differ between hashes", async () => {
    expect(await hashPassword("same-password", FAST)).not.toBe(await hashPassword("same-password", FAST));
  });

  test("verifies the right password and rejects a wrong one", async () => {
    const h = await hashPassword("correct horse", FAST);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("correct horsE", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  test("our hashes match an independent PBKDF2 computation (Django-compatible)", async () => {
    const h = await hashPassword("lètmein", FAST);
    const [, iter, salt] = h.split("$");
    expect(h).toBe(djangoHash("lètmein", salt, Number(iter)));
  });

  test("verifies Django hashes", async () => {
    const salt = randomBytes(12).toString("hex").slice(0, 22);
    const h = djangoHash("django-pass", salt, 2000);
    expect(await verifyPassword("django-pass", h)).toBe(true);
    expect(await verifyPassword("django-pasS", h)).toBe(false);
  });

  test("a tampered hash fails", async () => {
    const h = await hashPassword("pw-123456", FAST);
    const parts = h.split("$");
    parts[1] = "1001";
    expect(await verifyPassword("pw-123456", parts.join("$"))).toBe(false);
  });

  test("default iterations are 600k", async () => {
    // Only parse the prefix; hashing at 600k is slow, so check the option plumbing on a tiny run.
    expect(needsRehash("pbkdf2_sha256$599999$abc$def", { algorithm: "pbkdf2" })).toBe(true);
    expect(needsRehash("pbkdf2_sha256$600000$abc$def", { algorithm: "pbkdf2" })).toBe(false);
  });
});

describe("Bun.password algorithms", () => {
  test("argon2id is the default on Bun", async () => {
    const h = await hashPassword("argon-pass");
    expect(h).toStartWith("$argon2id$");
    expect(await verifyPassword("argon-pass", h)).toBe(true);
    expect(await verifyPassword("argon-pasS", h)).toBe(false);
  });

  test("bcrypt $2b$ and $2y$ verify via Bun.password", async () => {
    const h = await Bun.password.hash("bcrypt-pass", { algorithm: "bcrypt", cost: 4 });
    expect(await verifyPassword("bcrypt-pass", h)).toBe(true);
    expect(await verifyPassword("bcrypt-pass", h.replace(/^\$2b\$/, "$2y$"))).toBe(true);
    expect(await verifyPassword("nope", h)).toBe(false);
  });

  test("without Bun.password, bcrypt/argon2 throw MIU_E_AUTH_HASH_UNSUPPORTED with a fix", async () => {
    const h = await Bun.password.hash("x", { algorithm: "bcrypt", cost: 4 });
    for (const hash of [h, "$argon2id$v=19$m=65536,t=2,p=1$abc$def"]) {
      let err: any;
      try {
        await verifyPassword("x", hash, { bunPassword: null });
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("MIU_E_AUTH_HASH_UNSUPPORTED");
      expect(err.fix).toBeTruthy();
    }
  });

  test("without Bun.password, hashing falls back to pbkdf2", async () => {
    const h = await hashPassword("x-password", { bunPassword: null, iterations: 1000 });
    expect(h).toStartWith("pbkdf2_sha256$1000$");
  });

  test("unknown hash formats throw MIU_E_AUTH_HASH_UNSUPPORTED", async () => {
    await expect(verifyPassword("x", "md5$abc$def")).rejects.toMatchObject({ code: "MIU_E_AUTH_HASH_UNSUPPORTED" });
  });
});

describe("needsRehash", () => {
  test("bcrypt and low-iteration pbkdf2 need a rehash", async () => {
    const bcrypt = await Bun.password.hash("x", { algorithm: "bcrypt", cost: 4 });
    expect(needsRehash(bcrypt, { algorithm: "pbkdf2" })).toBe(true);
    expect(needsRehash(bcrypt)).toBe(true);
    expect(needsRehash("pbkdf2_sha256$1000$s$h", { algorithm: "pbkdf2", iterations: 2000 })).toBe(true);
    expect(needsRehash("pbkdf2_sha256$2000$s$h", { algorithm: "pbkdf2", iterations: 2000 })).toBe(false);
  });

  test("pbkdf2/Django hashes need a rehash when argon2id is preferred", () => {
    expect(needsRehash("pbkdf2_sha256$870000$s$h")).toBe(true);
  });

  test("argon2id hashes are current on Bun", async () => {
    expect(needsRehash(await hashPassword("x"))).toBe(false);
  });
});
