import { expect, test } from "bun:test";
import * as root from "../src/index.ts";
import * as sqlite from "../src/sqlite.ts";

test("root entry exports the portable batteries", () => {
  for (const name of [
    "memoryStore", "sessions", "session", "auth", "login", "logout", "requireAuth", "currentUser",
    "hashPassword", "verifyPassword", "signJwt", "verifyJwt", "createApiKey", "verifyApiKey",
    "cors", "secureHeaders", "requestId", "logger", "rateLimit", "cache", "remember",
    "createQueue", "memoryQueueDriver",
  ]) {
    expect(typeof (root as Record<string, unknown>)[name]).toBe("function");
  }
});

test("SQLite drivers live in miujs/sqlite so Workers bundles never see bun:sqlite/node:sqlite", async () => {
  expect("sqliteStore" in root).toBe(false);
  expect("sqliteQueueDriver" in root).toBe(false);
  expect(typeof sqlite.sqliteStore).toBe("function");
  expect(typeof sqlite.sqliteQueueDriver).toBe("function");
  expect(typeof sqlite.openDatabase).toBe("function");

  // Walk the root module graph and make sure no file imports the sqlite module.
  const seen = new Set<string>();
  const walk = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await Bun.file(file).text();
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      await walk(new URL(m[1]!, `file://${file}`).pathname);
    }
  };
  await walk(new URL("../src/index.ts", import.meta.url).pathname);
  const offenders = [...seen].filter((f) => /\/sqlite\.ts$/.test(f));
  expect(offenders).toEqual([]);
});
