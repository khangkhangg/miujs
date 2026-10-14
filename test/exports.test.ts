import { expect, test } from "bun:test";
import * as root from "../src/index.ts";
import * as sqlite from "../src/sqlite.ts";
import pkg from "../package.json";

test("root entry exports the portable batteries", () => {
  for (const name of [
    "memoryStore", "sessions", "session", "auth", "login", "logout", "requireAuth", "currentUser",
    "hashPassword", "verifyPassword", "signJwt", "verifyJwt", "createApiKey", "verifyApiKey",
    "cors", "secureHeaders", "requestId", "logger", "rateLimit", "cache", "remember",
    "createQueue", "memoryQueueDriver", "llms", "generateLlmsTxt",
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

const walkGraph = async (entry: string) => {
  const seen = new Set<string>();
  const walk = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await Bun.file(file).text();
    for (const m of src.matchAll(/^(?:import|export)(?!\s+type)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      await walk(new URL(m[1]!, `file://${file}`).pathname);
    }
  };
  await walk(new URL(`../${entry}`, import.meta.url).pathname);
  return [...seen];
};

test("package exports every public entry point and each resolves", async () => {
  const exportsMap = pkg.exports as unknown as Record<string, Record<string, string>>;
  expect(Object.keys(exportsMap).sort()).toEqual(
    [".", "./client", "./cloudflare", "./migrate", "./node", "./realtime", "./sqlite"].sort(),
  );
  for (const [key, target] of Object.entries(exportsMap)) {
    // "types" first; "bun" serves the TS source; import/default point at dist (covered by test/build).
    expect({ key, conditions: Object.keys(target) }).toEqual({ key, conditions: ["types", "bun", "import", "default"] });
    const mod = await import(new URL(`../${target.bun}`, import.meta.url).pathname);
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  }
  expect((pkg as { bin?: Record<string, string> }).bin).toEqual({ miu: "./dist/bin/miu.js" });
  expect(pkg.files).toEqual(expect.arrayContaining(["dist", "src", "bin", "templates"]));
});

test("edge entry points never pull in native SQLite or Node built-ins", async () => {
  for (const entry of ["src/index.ts", "src/adapters/cloudflare/index.ts", "src/realtime/index.ts", "src/migrate/index.ts", "src/client/index.ts"]) {
    const files = await walkGraph(entry);
    expect({ entry, offenders: files.filter((f) => /\/(batteries\/sqlite|store\/sqlite|queue\/sqlite|adapters\/node|adapters\/node-ws)\.ts$/.test(f)) }).toEqual({ entry, offenders: [] });
    for (const f of files) {
      const src = await Bun.file(f).text();
      expect({ f, native: /from\s+"(node:|bun:|bun")/.test(src) }).toEqual({ f, native: false });
    }
  }
});
