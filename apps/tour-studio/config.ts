/**
 * Tour Studio configuration, read from the environment (Bun and Node).
 *
 *   PORT            HTTP port (default 3000; 0 = any free port)
 *   HOST            bind address (default 127.0.0.1)
 *   DATA_DIR        SQLite database + panorama storage (default ./.tour-studio)
 *   SESSION_SECRET  >= 32 chars; required in production (dev: random per process)
 *   ADMIN_EMAIL     seeded admin account (default admin@example.com)
 *   ADMIN_PASSWORD  seeded admin password (required in production when seeding; dev: random, printed)
 *   MIU_ENV         development | production (unset = production, the safe default)
 *   INSPECTOR_TOKEN dev only: fixed token for /__miu (default: random, printed)
 *   SEED            "0" to skip seeding the admin and demo tour on start
 *   SEED_PANORAMA_WIDTH  width of the generated demo panoramas (default 2048)
 *   LOG_REQUESTS    "0" to turn the JSON access log off
 *   COOKIE_SECURE   "0" to drop the Secure cookie flag (default: Secure outside development)
 *   AUTH_RATE_LIMIT login/signup attempts per minute per account (default 10)
 *   SQLITE_SYNCHRONOUS  FULL (SQLite default) or NORMAL (recommended with WAL; faster writes)
 *   TRUST_PROXY     "1" when behind a proxy that sets X-Forwarded-For (rate limits key on it)
 */
import { isDev } from "../../src/index.ts";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  sessionSecret: string;
  adminEmail: string;
  adminPassword: string;
  dev: boolean;
  inspectorToken?: string;
  seed: boolean;
  seedPanoramaWidth: number;
  logRequests: boolean;
  trustProxy: boolean;
  /** How long superseded panorama files are kept for in-flight downloads (ms). */
  blobRetainMs: number;
  /** `Secure` session cookie (default: on in production; COOKIE_SECURE=0 for plain-http deployments). */
  secureCookies: boolean;
  sqliteSynchronous?: "FULL" | "NORMAL";
  /** Max login/signup attempts per client per minute. */
  authRateLimit: number;
}

const random = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dev = isDev(env);
  const secret = env.SESSION_SECRET;
  if (!dev && (!secret || secret.length < 32)) {
    throw new Error("SESSION_SECRET (at least 32 characters) is required outside MIU_ENV=development");
  }
  const seed = env.SEED !== "0";
  const adminPassword = env.ADMIN_PASSWORD ?? (dev || !seed ? random(9) : "");
  if (seed && !adminPassword) throw new Error("ADMIN_PASSWORD is required to seed the admin account in production");
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
    dataDir: (env.DATA_DIR ?? ".tour-studio").replace(/\/+$/, ""),
    sessionSecret: secret ?? random(32),
    adminEmail: (env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase(),
    adminPassword,
    dev,
    inspectorToken: dev ? env.INSPECTOR_TOKEN : undefined,
    seed,
    seedPanoramaWidth: Number(env.SEED_PANORAMA_WIDTH ?? 2048),
    logRequests: env.LOG_REQUESTS !== "0",
    trustProxy: env.TRUST_PROXY === "1",
    blobRetainMs: env.BLOB_RETAIN_MS === undefined ? 60_000 : Number(env.BLOB_RETAIN_MS),
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE !== "0" : !dev,
    sqliteSynchronous: env.SQLITE_SYNCHRONOUS === "NORMAL" || env.SQLITE_SYNCHRONOUS === "FULL" ? env.SQLITE_SYNCHRONOUS : undefined,
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 10),
  };
}
