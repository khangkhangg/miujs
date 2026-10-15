import { describe, expect, test } from "bun:test";
import { sqlite } from "@miujs/db";
import { authMigrations, dbUserStore, memoryUserStore, type UserStore } from "../src/index.ts";

const env = {};

const stores: [string, () => UserStore][] = [
  ["memoryUserStore", () => memoryUserStore()],
  ["dbUserStore", () => dbUserStore(sqlite())],
];

for (const [name, make] of stores) {
  describe(name, () => {
    test("create, find by email (case-insensitive) and id", async () => {
      const s = make();
      const u = await s.createUser({ email: "Ann@Example.com", name: "Ann", roles: ["admin"], passwordHash: "h1" }, env);
      expect(u).not.toBeNull();
      expect(u!.email).toBe("ann@example.com");
      expect(u!.id).toBeTruthy();
      expect(await s.findUserByEmail("ANN@example.com", env)).toEqual(u);
      expect(await s.findUserById(u!.id, env)).toEqual(u);
      expect(u!.roles).toEqual(["admin"]);
      expect(await s.findUserById("nope", env)).toBeNull();
    });

    test("duplicate email returns null", async () => {
      const s = make();
      await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env);
      expect(await s.createUser({ email: "A@B.co", roles: [], passwordHash: "h" }, env)).toBeNull();
    });

    test("updatePasswordHash", async () => {
      const s = make();
      const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "old" }, env))!;
      await s.updatePasswordHash(u.id, "new", env);
      expect((await s.findUserById(u.id, env))!.passwordHash).toBe("new");
    });

    test("api tokens: create, find by hash, delete only own", async () => {
      const s = make();
      const a = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
      const b = (await s.createUser({ email: "b@b.co", roles: [], passwordHash: "h" }, env))!;
      await s.createToken({ id: "t1", userId: a.id, name: "ci", tokenHash: "abc", createdAt: 1, expiresAt: null }, env);
      expect(await s.findTokenByHash("abc", env)).toEqual({ id: "t1", userId: a.id, name: "ci", tokenHash: "abc", createdAt: 1, expiresAt: null });
      expect(await s.findTokenByHash("zzz", env)).toBeNull();
      expect(await s.deleteToken("t1", b.id, env)).toBe(false);
      expect(await s.deleteToken("t1", a.id, env)).toBe(true);
      expect(await s.findTokenByHash("abc", env)).toBeNull();
    });
  });
}

test("authMigrations create users and api_tokens", async () => {
  const database = sqlite();
  const { migrate } = await import("@miujs/db");
  expect(await migrate(database, authMigrations)).toEqual(authMigrations.map((m) => m.id));
  const { results } = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(["users", "api_tokens"]));
});

test("dbUserStore stores roles as a JSON array", async () => {
  const database = sqlite();
  const s = dbUserStore(database);
  const u = (await s.createUser({ email: "a@b.co", roles: ["x", "y"], passwordHash: "h" }, env))!;
  expect(await database.prepare("SELECT roles FROM users WHERE id = ?").bind(u.id).first("roles")).toBe('["x","y"]');
});

describe("email verification, session versions and one-time tokens", () => {
  for (const [name, make] of stores) {
    describe(name, () => {
      test("new users are unverified with session version 0", async () => {
        const s = make();
        const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
        expect(u.emailVerifiedAt).toBeNull();
        expect(u.sessionVersion).toBe(0);
        expect(await s.findUserById(u.id, env)).toEqual(u);
      });

      test("markEmailVerified sets the time once", async () => {
        const s = make();
        const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
        await s.markEmailVerified!(u.id, 1234, env);
        expect((await s.findUserById(u.id, env))!.emailVerifiedAt).toBe(1234);
        await s.markEmailVerified!(u.id, 9999, env);
        expect((await s.findUserById(u.id, env))!.emailVerifiedAt).toBe(1234);
      });

      test("changePassword sets the hash and bumps the session version; updatePasswordHash does not bump", async () => {
        const s = make();
        const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
        expect(await s.changePassword!(u.id, "h2", env)).toBe(1);
        expect(await s.changePassword!(u.id, "h3", env)).toBe(2);
        await s.updatePasswordHash(u.id, "h4", env);
        const after = (await s.findUserById(u.id, env))!;
        expect(after.passwordHash).toBe("h4");
        expect(after.sessionVersion).toBe(2);
      });

      test("one-time tokens: consume once, only for the right purpose", async () => {
        const s = make();
        const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
        const rec = { tokenHash: "hash1", userId: u.id, purpose: "reset" as const, createdAt: 1, expiresAt: 2 };
        await s.createOneTimeToken!(rec, env);
        expect(await s.consumeOneTimeToken!("hash1", "verify", env)).toBeNull();
        expect(await s.consumeOneTimeToken!("hash1", "reset", env)).toEqual(rec);
        expect(await s.consumeOneTimeToken!("hash1", "reset", env)).toBeNull();
        expect(await s.consumeOneTimeToken!("nope", "reset", env)).toBeNull();
      });

      test("deleteOneTimeTokens removes one user's tokens of one purpose", async () => {
        const s = make();
        const a = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
        const b = (await s.createUser({ email: "b@b.co", roles: [], passwordHash: "h" }, env))!;
        await s.createOneTimeToken!({ tokenHash: "a-reset", userId: a.id, purpose: "reset", createdAt: 1, expiresAt: 2 }, env);
        await s.createOneTimeToken!({ tokenHash: "a-verify", userId: a.id, purpose: "verify", createdAt: 1, expiresAt: 2 }, env);
        await s.createOneTimeToken!({ tokenHash: "b-reset", userId: b.id, purpose: "reset", createdAt: 1, expiresAt: 2 }, env);
        await s.deleteOneTimeTokens!(a.id, "reset", env);
        expect(await s.consumeOneTimeToken!("a-reset", "reset", env)).toBeNull();
        expect(await s.consumeOneTimeToken!("a-verify", "verify", env)).not.toBeNull();
        expect(await s.consumeOneTimeToken!("b-reset", "reset", env)).not.toBeNull();
      });

      test("concurrent consumes of one token: exactly one wins", async () => {
        const s = make();
        const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
        await s.createOneTimeToken!({ tokenHash: "race", userId: u.id, purpose: "reset", createdAt: 1, expiresAt: 2 }, env);
        const results = await Promise.all(Array.from({ length: 5 }, () => s.consumeOneTimeToken!("race", "reset", env)));
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });
  }

  test("the new migration is appended, never editing the first one", () => {
    expect(authMigrations[0].id).toBe("miu_auth_001_users_tokens");
    expect(authMigrations[0].sql).not.toContain("session_version");
    expect(authMigrations.map((m) => m.id)).toContain("miu_auth_002_verify_reset");
  });

  test("a database migrated with only 001 upgrades in place and keeps users", async () => {
    const database = sqlite();
    const { migrate } = await import("@miujs/db");
    await migrate(database, authMigrations.slice(0, 1));
    await database.prepare("INSERT INTO users (id, email, name, roles, password_hash, created_at) VALUES ('u1', 'old@b.co', NULL, '[]', 'h', 1)").run();
    const s = dbUserStore(database);
    const u = (await s.findUserById("u1", env))!;
    expect(u).toMatchObject({ email: "old@b.co", emailVerifiedAt: null, sessionVersion: 0 });
  });

  test("dbUserStore stores only what it is given (the hash) for one-time tokens", async () => {
    const database = sqlite();
    const s = dbUserStore(database);
    const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
    await s.createOneTimeToken!({ tokenHash: "abc", userId: u.id, purpose: "verify", createdAt: 1, expiresAt: 2 }, env);
    const row = await database.prepare("SELECT * FROM auth_one_time_tokens").first<Record<string, unknown>>();
    expect(row).toEqual({ token_hash: "abc", user_id: u.id, purpose: "verify", created_at: 1, expires_at: 2 });
  });
});
