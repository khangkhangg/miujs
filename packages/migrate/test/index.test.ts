import { expect, test } from "bun:test";
import * as migrate from "../src/index.ts";

test("the package entry exports the public API", () => {
  for (const name of [
    "migrateProxy",
    "laravelSession",
    "laravelDatabaseStore",
    "laravelDecrypt",
    "laravelEncrypt",
    "djangoSession",
    "djangoDatabaseStore",
    "djangoSigningLoads",
    "bridgeAuth",
    "captureMiddleware",
    "verifyContracts",
    "formatReport",
    "fromOpenApi",
    "pydanticToT",
    "phpUnserialize",
    "phpSerialize",
  ]) {
    expect(typeof (migrate as Record<string, unknown>)[name]).toBe("function");
  }
});

test("errors carry MIU_E_MIGRATE_* codes and a fix", () => {
  try {
    migrate.migrateProxy({ upstream: "nope" });
  } catch (e) {
    const err = e as { code: string; fix?: string };
    expect(err.code).toMatch(/^MIU_E_MIGRATE_/);
    expect(err.fix).toBeTruthy();
    return;
  }
  throw new Error("expected an error");
});
