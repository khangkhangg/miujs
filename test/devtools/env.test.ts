import { describe, expect, test } from "bun:test";
import { isDev, isProduction } from "../../src/devtools/index.ts";

describe("isDev / isProduction", () => {
  test("explicit development or test means dev", () => {
    expect(isDev({ MIU_ENV: "development" })).toBe(true);
    expect(isDev({ NODE_ENV: "development" })).toBe(true);
    expect(isDev({ NODE_ENV: "test" })).toBe(true);
    expect(isDev({ MIU_ENV: " Dev " })).toBe(true);
  });

  test("production wins whichever variable says it", () => {
    expect(isDev({ NODE_ENV: "production" })).toBe(false);
    expect(isDev({ MIU_ENV: "production", NODE_ENV: "development" })).toBe(false);
    expect(isDev({ MIU_ENV: "development", NODE_ENV: "production" })).toBe(false);
    expect(isProduction({ MIU_ENV: "development", NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ NODE_ENV: "development" })).toBe(false);
  });

  test("MIU_ENV overrides NODE_ENV for non-production values", () => {
    expect(isDev({ MIU_ENV: "staging", NODE_ENV: "development" })).toBe(false);
    expect(isDev({ MIU_ENV: "test", NODE_ENV: "staging" })).toBe(true);
  });

  test("an unknown environment is treated as production-like (not dev)", () => {
    const proc = (globalThis as any).process;
    const saved = { MIU_ENV: proc.env.MIU_ENV, NODE_ENV: proc.env.NODE_ENV };
    delete proc.env.MIU_ENV;
    delete proc.env.NODE_ENV;
    try {
      expect(isDev()).toBe(false);
      expect(isDev({})).toBe(false);
      expect(isDev({ NODE_ENV: "staging" })).toBe(false);
      expect(isProduction()).toBe(false); // not *explicitly* production
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) proc.env[k] = v;
    }
  });

  test("Workers-style bindings take precedence over process.env and non-strings are ignored", () => {
    // bun test runs with NODE_ENV=test
    expect(isDev()).toBe(true);
    expect(isDev({ NODE_ENV: "production" })).toBe(false);
    expect(isDev({ NODE_ENV: { not: "a string" } } as any)).toBe(true);
  });
});
