import { expect, test } from "bun:test";
import { hashPassword, needsRehash, verifyPassword, type BunPasswordLike } from "../src/password.ts";

test("argon2id defaults to OWASP's 19 MiB, 2 passes (not Bun's 64 MiB)", async () => {
  const h = await hashPassword("correct horse");
  expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  expect(await verifyPassword("correct horse", h)).toBe(true);
});

test("memoryCost and timeCost are configurable", async () => {
  const h = await hashPassword("pw-123456", { memoryCost: 8192, timeCost: 3 });
  expect(h).toMatch(/\$m=8192,t=3,/);
});

test("at most `concurrency` hashes run at once; the rest queue", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow: BunPasswordLike = {
    hash: async () => "x",
    verify: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return true;
    },
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => verifyPassword("p", "$argon2id$v=19$m=19456,t=2,p=1$x$y", { bunPassword: slow, concurrency: 3 })));
  expect(results.every(Boolean)).toBe(true);
  expect(peak).toBe(3);
});

test("needsRehash upgrades weaker argon2 params but never downgrades stronger ones", () => {
  expect(needsRehash("$argon2id$v=19$m=8192,t=2,p=1$s$h")).toBe(true);
  expect(needsRehash("$argon2id$v=19$m=19456,t=1,p=1$s$h")).toBe(true);
  expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$s$h")).toBe(false);
  expect(needsRehash("$argon2id$v=19$m=65536,t=2,p=1$s$h")).toBe(false);
});
