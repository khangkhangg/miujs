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
