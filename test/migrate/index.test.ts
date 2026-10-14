import { expect, test } from "bun:test";
import * as migrate from "../../src/migrate/index.ts";

test("migrate index re-exports the kit", () => {
  for (const name of [
    "legacyProxy", "legacyFallback", "unserializePhp", "serializePhp", "decodePhpSession", "phpSessionBridge",
    "signingLoads", "signingDumps", "decodeDjangoSessionData", "djangoSessionBridge", "verifyBcrypt", "hashBcrypt",
    "verifyLegacyPassword", "recordContract", "verifyContract", "introspect", "introspectMongo", "toSchemaSource", "toCrudSource",
  ]) expect(typeof (migrate as Record<string, unknown>)[name]).toBe("function");
});
