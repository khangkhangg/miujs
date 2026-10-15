// @miujs/migrate — move a Laravel, Django or FastAPI app to MiuJS one route at a time.
//
//   miu({
//     routes,                                   // what is ported so far
//     plugins: [
//       captureMiddleware({ sink }),            // record traffic as contract cases (redacted)
//       migrateProxy({ upstream }),             // everything else goes to the old app
//       auth(), bridgeAuth({ from: laravelSession({...}), findUser }),  // shared logins
//     ],
//   })

export { migrateProxy, NOT_PORTED_TAG, PROXIED, type MigrateProxyOptions } from "./proxy.ts";
export {
  laravelCookieDecode,
  laravelCookieEncode,
  laravelDatabaseStore,
  laravelDecrypt,
  laravelEncrypt,
  laravelLoginKey,
  laravelSession,
  parseAppKey,
  type LaravelCipher,
  type LaravelCookieOptions,
  type LaravelCryptOptions,
  type LaravelSessionOptions,
  type LaravelSessionStore,
  type LaravelStoreWriteInfo,
} from "./laravel.ts";
export {
  djangoDatabaseStore,
  djangoSaltedHmac,
  djangoSession,
  djangoSessionAuthHash,
  djangoSignedCookieStore,
  djangoSigningDumps,
  djangoSigningLoads,
  type DjangoAlgorithm,
  type DjangoCodec,
  type DjangoSessionOptions,
  type DjangoSessionStore,
  type DjangoSigningOptions,
} from "./django.ts";
export { PHP_CLASS, phpSerialize, phpUnserialize, type PhpUnserializeOptions } from "./php.ts";
export { bridgeAuth, getLegacySession, type BridgeAuthOptions } from "./bridge.ts";
export { captureMiddleware, jsonlFileSink, memorySink, parseCases, redact, type CaptureEntry, type CaptureOptions, type CaptureSink, type RedactOptions } from "./capture.ts";
export { diffJson, formatReport, matchesIgnore, verifyContracts, type CaseResult, type Diff, type DiffOptions, type Target, type VerifyOptions, type VerifyReport } from "./verify.ts";
export { fromOpenApi, jsonSchemaToT, NOT_PORTED, pydanticToT, toIdentifier, type FromOpenApiResult, type GeneratedFile, type ToTOptions } from "./openapi.ts";
export type { LegacyCookieOptions, LegacySession, LegacySessionSource } from "./types.ts";
