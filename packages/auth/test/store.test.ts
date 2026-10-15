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

describe("OAuth accounts, passkeys, challenges and token revocation", () => {
  for (const [name, make] of stores) {
    describe(name, () => {
      const user = async (s: UserStore, email = "a@b.co") => (await s.createUser({ email, roles: [], passwordHash: "h" }, env))!;

      test("deleteUserTokens removes only that user's API tokens", async () => {
        const s = make();
        const a = await user(s);
        const b = await user(s, "b@b.co");
        await s.createToken({ id: "t1", userId: a.id, name: "x", tokenHash: "h1", createdAt: 1, expiresAt: null }, env);
        await s.createToken({ id: "t2", userId: a.id, name: "y", tokenHash: "h2", createdAt: 1, expiresAt: null }, env);
        await s.createToken({ id: "t3", userId: b.id, name: "z", tokenHash: "h3", createdAt: 1, expiresAt: null }, env);
        expect(await s.deleteUserTokens!(a.id, env)).toBe(2);
        expect(await s.findTokenByHash("h1", env)).toBeNull();
        expect(await s.findTokenByHash("h2", env)).toBeNull();
        expect(await s.findTokenByHash("h3", env)).not.toBeNull();
      });

      test("oauth accounts: (provider, subject) is unique; lookup by both", async () => {
        const s = make();
        const a = await user(s);
        const b = await user(s, "b@b.co");
        const rec = { id: "o1", provider: "google", subject: "123", userId: a.id, email: "a@b.co", createdAt: 5 };
        expect(await s.createOAuthAccount!(rec, env)).toBe(true);
        expect(await s.createOAuthAccount!({ ...rec, id: "o2", userId: b.id }, env)).toBe(false);
        expect(await s.findOAuthAccount!("google", "123", env)).toEqual(rec);
        expect(await s.findOAuthAccount!("github", "123", env)).toBeNull();
        expect(await s.createOAuthAccount!({ ...rec, id: "o3", provider: "github", userId: b.id }, env)).toBe(true);
      });

      const pk = (userId: string, over: Record<string, unknown> = {}) => ({
        id: "p1",
        userId,
        credentialId: "cred-1",
        publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        algorithm: -7,
        signCount: 0,
        transports: ["internal"],
        name: "Laptop",
        createdAt: 1,
        lastUsedAt: null,
        ...over,
      });

      test("passkeys: create, unique credential id, find, list, delete only own", async () => {
        const s = make();
        const a = await user(s);
        const b = await user(s, "b@b.co");
        expect(await s.createPasskey!(pk(a.id), env)).toBe(true);
        expect(await s.createPasskey!(pk(b.id, { id: "p2" }), env)).toBe(false);
        expect(await s.createPasskey!(pk(a.id, { id: "p3", credentialId: "cred-3", transports: [] }), env)).toBe(true);
        expect(await s.findPasskeyByCredentialId!("cred-1", env)).toEqual(pk(a.id));
        expect(await s.findPasskeyByCredentialId!("nope", env)).toBeNull();
        expect((await s.listPasskeys!(a.id, env)).map((p) => p.id).sort()).toEqual(["p1", "p3"]);
        expect(await s.listPasskeys!(b.id, env)).toEqual([]);
        expect(await s.deletePasskey!("p1", b.id, env)).toBe(false);
        expect(await s.deletePasskey!("p1", a.id, env)).toBe(true);
        expect(await s.findPasskeyByCredentialId!("cred-1", env)).toBeNull();
        await s.deleteUserPasskeys!(a.id, env);
        expect(await s.listPasskeys!(a.id, env)).toEqual([]);
      });

      test("updatePasskeyUsage is compare-and-set on the sign count", async () => {
        const s = make();
        const a = await user(s);
        await s.createPasskey!(pk(a.id, { signCount: 5 }), env);
        expect(await s.updatePasskeyUsage!("p1", 4, 9, 100, env)).toBe(false);
        expect(await s.updatePasskeyUsage!("p1", 5, 9, 100, env)).toBe(true);
        expect(await s.updatePasskeyUsage!("p1", 5, 10, 101, env)).toBe(false);
        expect(await s.findPasskeyByCredentialId!("cred-1", env)).toMatchObject({ signCount: 9, lastUsedAt: 100 });
      });

      test("challenges: consumed once, only for their purpose", async () => {
        const s = make();
        const now = Date.now();
        await s.createChallenge!({ challenge: "c1", purpose: "passkey-login", userId: null, createdAt: now, expiresAt: now + 1000 }, env);
        expect(await s.consumeChallenge!("c1", "passkey-register", env)).toBeNull();
        expect(await s.consumeChallenge!("c1", "passkey-login", env)).toEqual({ challenge: "c1", purpose: "passkey-login", userId: null, createdAt: now, expiresAt: now + 1000 });
        expect(await s.consumeChallenge!("c1", "passkey-login", env)).toBeNull();
      });

      test("concurrent consumes of one challenge: exactly one wins", async () => {
        const s = make();
        const now = Date.now();
        await s.createChallenge!({ challenge: "c2", purpose: "passkey-login", userId: "u", createdAt: now, expiresAt: now + 1000 }, env);
        const got = await Promise.all([1, 2, 3].map(() => s.consumeChallenge!("c2", "passkey-login", env)));
        expect(got.filter(Boolean)).toHaveLength(1);
      });

      test("creating a challenge sweeps expired ones", async () => {
        const s = make();
        const now = Date.now();
        await s.createChallenge!({ challenge: "old", purpose: "passkey-login", userId: null, createdAt: now - 10_000, expiresAt: now - 1 }, env);
        await s.createChallenge!({ challenge: "new", purpose: "passkey-login", userId: null, createdAt: now, expiresAt: now + 1000 }, env);
        expect(await s.consumeChallenge!("old", "passkey-login", env)).toBeNull();
      });
    });
  }

  test("migration 003 is appended and upgrades a 002 database in place", async () => {
    expect(authMigrations.map((m) => m.id)).toEqual(["miu_auth_001_users_tokens", "miu_auth_002_verify_reset", "miu_auth_003_oauth_passkeys"]);
    const database = sqlite();
    const { migrate } = await import("@miujs/db");
    await migrate(database, authMigrations.slice(0, 2));
    await database.prepare("INSERT INTO users (id, email, name, roles, password_hash, created_at) VALUES ('u1', 'old@b.co', NULL, '[]', 'h', 1)").run();
    const s = dbUserStore(database);
    expect(await s.createOAuthAccount!({ id: "o1", provider: "github", subject: "9", userId: "u1", email: null, createdAt: 1 }, env)).toBe(true);
    expect((await s.findUserById("u1", env))!.email).toBe("old@b.co");
  });

  test("deleting a user cascades to oauth accounts and passkeys", async () => {
    const database = sqlite();
    const s = dbUserStore(database);
    const u = (await s.createUser({ email: "a@b.co", roles: [], passwordHash: "h" }, env))!;
    await s.createOAuthAccount!({ id: "o1", provider: "github", subject: "9", userId: u.id, email: null, createdAt: 1 }, env);
    await s.createPasskey!({ id: "p1", userId: u.id, credentialId: "c", publicKey: { kty: "EC" }, algorithm: -7, signCount: 0, transports: [], name: null, createdAt: 1, lastUsedAt: null }, env);
    await database.prepare("DELETE FROM users WHERE id = ?").bind(u.id).run();
    expect(await s.findOAuthAccount!("github", "9", env)).toBeNull();
    expect(await s.findPasskeyByCredentialId!("c", env)).toBeNull();
  });
});
