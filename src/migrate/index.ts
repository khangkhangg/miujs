/**
 * Migration kit: run Miu in front of a legacy PHP or Python app and port it
 * route by route. Everything here is Web-standard (Bun, Node, Workers).
 */
export { legacyProxy, legacyFallback } from "./proxy.ts";
export type { LegacyProxyOptions } from "./proxy.ts";
export { unserializePhp, serializePhp, decodePhpSession, phpSessionBridge } from "./php-session.ts";
export type { PhpObject, PhpSessionHandler, PhpSessionBridgeOptions } from "./php-session.ts";
export {
  DJANGO_SIGNED_COOKIE_SALT,
  DJANGO_SESSION_STORE_SALT,
  saltedHmac,
  djangoSign,
  djangoUnsign,
  signingLoads,
  signingDumps,
  decodeDjangoSessionData,
  djangoSessionBridge,
} from "./django-session.ts";
export type { DjangoAlgorithm, SignerOptions, LoadsOptions, DumpsOptions, SessionDataOptions, DjangoSessionBridgeOptions } from "./django-session.ts";
export { verifyBcrypt, hashBcrypt, verifyLegacyPassword, md5 } from "./bcrypt.ts";
export type { LegacyPasswordOptions } from "./bcrypt.ts";
export { recordContract, verifyContract, formatDiffs, VOLATILE_HEADERS } from "./contract.ts";
export type { Contract, ContractRequest, RecordedResponse, ContractDiff, RecordOptions, VerifyOptions, NormalizeOptions, BodyNormalizer } from "./contract.ts";
export { introspect, introspectMongo, mapColumnType, toSchemaSource, toCrudSource } from "./introspect.ts";
export type { Dialect, QueryFn, Column, Table, IntrospectOptions, IntrospectMongoOptions, SchemaSourceOptions, CrudSourceOptions } from "./introspect.ts";
