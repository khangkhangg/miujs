import { describe, expect, test } from "bun:test";
import { hashBcrypt, verifyBcrypt, verifyLegacyPassword } from "../../src/migrate/bcrypt.ts";
import { hashPassword } from "../../src/batteries/auth/password.ts";

// Generated with PHP 8.3 crypt()/password_hash() and Python bcrypt 5.0 / Django 6.1 hashers.
const SALT = "abcdefghijklmnopqrstuu";
const A72 = "a".repeat(72);
const PHP_VECTORS: [string, string][] = [
  ["", `$2y$04$${SALT}byCG3zY1GIXMyxfivm.ClDiInHzxjiq`],
  ["password", `$2y$05$${SALT}WG29KuyeAicPCJODk1zjyGvyQUU2awu`],
  ["héllo wörld 🐱", `$2y$04$${SALT}dPp4GzZurcGU6b7vAlwA8QP7FDXIwk6`],
  [A72, `$2y$04$${SALT}BzzIgyKkz7xMWYSzkIjUSnxEQFQ0WNe`],
  ["U*U", `$2y$05$${SALT}MpLhh66NJUQMuZ6FwRQX0sqAEKeWcKW`],
  ["secret", "$2y$04$mBvp061SSyZI5rViNjDXcuunDkrLVl6IffR6lhuVSRuEEdzjiYdxC"],
  ["correct horse", "$2b$04$30YbJd6XPL.pIzYfy8XCg.uq3GsuMqhL5kexyty1hm6a4EQwKCHja"],
  ["Pässwörd", "$2b$06$7BEr0YXAz2FDqnFdJNEV4e/afrxFSUrZEigaSv.EHls6IiF9y1rTe"],
];

describe("verifyBcrypt", () => {
  test("verifies PHP and Python generated hashes", async () => {
    for (const [pw, hash] of PHP_VECTORS) {
      expect(await verifyBcrypt(pw, hash)).toBe(true);
      if (pw.length < 72) expect(await verifyBcrypt(pw + "x", hash)).toBe(false);
    }
  });

  test("$2a$, $2b$ and $2y$ prefixes are equivalent", async () => {
    for (const v of ["2a", "2b", "2y"]) {
      expect(await verifyBcrypt("password", `$${v}$05$${SALT}WG29KuyeAicPCJODk1zjyGvyQUU2awu`)).toBe(true);
    }
  });

  test("truncates passwords to 72 bytes", async () => {
    const hash = `$2y$04$${SALT}BzzIgyKkz7xMWYSzkIjUSnxEQFQ0WNe`;
    expect(await verifyBcrypt(A72 + "EXTRA", hash)).toBe(true);
    expect(await verifyBcrypt("a".repeat(71), hash)).toBe(false);
  });

  test("rejects malformed hashes", async () => {
    for (const bad of ["", "$2x$04$" + SALT + "byCG3zY1GIXMyxfivm.ClDiInHzxjiq", "$2y$03$" + SALT + "byCG3zY1GIXMyxfivm.ClDiInHzxjiq", "$2y$04$short", "pbkdf2_sha256$1$a$b"]) {
      expect(await verifyBcrypt("", bad)).toBe(false);
    }
  });
});

describe("hashBcrypt", () => {
  test("produces $2y$ hashes that verify", async () => {
    const h = await hashBcrypt("hunter2", 4);
    expect(h).toMatch(/^\$2y\$04\$[./A-Za-z0-9]{53}$/);
    expect(await verifyBcrypt("hunter2", h)).toBe(true);
    expect(await verifyBcrypt("hunter3", h)).toBe(false);
    expect(await hashBcrypt("hunter2", 4)).not.toBe(h);
  });

  test("rejects out-of-range cost", async () => {
    expect(hashBcrypt("x", 3)).rejects.toThrow();
    expect(hashBcrypt("x", 32)).rejects.toThrow();
  });
});

describe("verifyLegacyPassword", () => {
  test("dispatches bcrypt, Django bcrypt variants and PBKDF2", async () => {
    expect(await verifyLegacyPassword("secret", PHP_VECTORS[5]![1])).toBe(true);
    expect(await verifyLegacyPassword("s3cret pass", "bcrypt_sha256$$2b$04$LKnnczyHYgHPpM9dcAJGZ.l2jf5LKcCiOFJW/m8A5kDdq5KkNQyYC")).toBe(true);
    expect(await verifyLegacyPassword("s3cret pass", "bcrypt$$2b$04$LUud3lje2L.Yq5E2PHh36OwI8iP7E7LevAaK/OzprYUWgr2p4fF7.")).toBe(true);
    expect(await verifyLegacyPassword("wrong", "bcrypt$$2b$04$LUud3lje2L.Yq5E2PHh36OwI8iP7E7LevAaK/OzprYUWgr2p4fF7.")).toBe(false);
    const pb = await hashPassword("pw", { iterations: 1000 });
    expect(await verifyLegacyPassword("pw", pb)).toBe(true);
    expect(await verifyLegacyPassword("px", pb)).toBe(false);
  });

  test("md5/sha1 hashes only with allowInsecure", async () => {
    const md5 = "5211da5c87b0c916f11bbeb561492eef";
    const sha1 = "a21818805da492032545b1f51e510373394e73e3";
    const djMd5 = "md5$seasalt$63116186e0e6fec44f738d4c3f981d86";
    for (const h of [md5, sha1, djMd5]) {
      expect(await verifyLegacyPassword("s3cret pass", h)).toBe(false);
      expect(await verifyLegacyPassword("s3cret pass", h, { allowInsecure: true })).toBe(true);
      expect(await verifyLegacyPassword("s3cret pasS", h, { allowInsecure: true })).toBe(false);
    }
    expect(await verifyLegacyPassword("s3cret pass", md5.toUpperCase(), { allowInsecure: true })).toBe(true);
    expect(await verifyLegacyPassword("héllo", "be50e8478cf24ff3595bc7307fb91b50", { allowInsecure: true })).toBe(true);
  });

  test("unknown formats return false", async () => {
    expect(await verifyLegacyPassword("x", "argon2$whatever", { allowInsecure: true })).toBe(false);
  });
});
