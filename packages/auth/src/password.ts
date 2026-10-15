// Password hashing. Argon2id via Bun.password when available, else PBKDF2-SHA256 via Web Crypto
// in Django's format, so hashes move between MiuJS and Django apps.

import { errors } from "miujs";
import { base64Decode, base64Encode, base64urlEncode, randomBytes, timingSafeEqual, utf8 } from "@miujs/session";

/** The bits of `Bun.password` used here. */
export interface BunPasswordLike {
  hash(password: string, opts?: unknown): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface PasswordOptions {
  /** Default `argon2id` when Bun.password exists, else `pbkdf2`. */
  algorithm?: "argon2id" | "pbkdf2";
  /** PBKDF2 iterations. Default 600,000 (OWASP 2023). Lower only in tests. */
  iterations?: number;
  /** Argon2id memory in KiB. Default 19,456 (19 MiB, OWASP's argon2id setting); each hash in flight uses this much. */
  memoryCost?: number;
  /** Argon2id passes. Default 2. */
  timeCost?: number;
  /**
   * Hashes and verifications allowed at once in this process (default 4); the rest wait. Caps
   * memory (concurrency x memoryCost) and CPU when many sign-ins arrive together.
   */
  concurrency?: number;
  /**
   * Cloudflare Workers: the CPU time per request your Worker may use, in ms (wrangler `[limits]
   * cpu_ms`). Default 10, the Free plan's limit. On Workers, auth() warns once at startup when one
   * PBKDF2 hash is estimated to need more. Set it to your plan's limit, or false to skip the check.
   */
  workersCpuMs?: number | false;
  /** @internal Override `Bun.password` (null = pretend it is absent). */
  bunPassword?: BunPasswordLike | null;
}

export const DEFAULT_ITERATIONS = 600_000;
export const DEFAULT_MEMORY_COST = 19_456;
export const DEFAULT_TIME_COST = 2;
export const DEFAULT_PASSWORD_CONCURRENCY = 4;

/** A counting semaphore per configured limit, shared by every call in the process. */
const gates = new Map<number, { active: number; waiting: (() => void)[] }>();

async function limited<T>(opts: PasswordOptions, fn: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_PASSWORD_CONCURRENCY));
  let gate = gates.get(limit);
  if (!gate) gates.set(limit, (gate = { active: 0, waiting: [] }));
  if (gate.active >= limit) await new Promise<void>((r) => gate!.waiting.push(r));
  gate.active++;
  try {
    return await fn();
  } finally {
    gate.active--;
    gate.waiting.shift()?.();
  }
}

/** m and t from a "$argon2id$v=19$m=…,t=…,p=…$…" hash. */
function argonParams(stored: string): { m: number; t: number } | null {
  const m = /[$,]m=(\d+)/.exec(stored);
  const t = /[$,]t=(\d+)/.exec(stored);
  return m && t ? { m: Number(m[1]), t: Number(t[1]) } : null;
}

/** Stored for accounts with no password (made by OAuth sign-in). Never matches anything, like Django's `!` hashes. */
export const UNUSABLE_PASSWORD = "!";

/** A unique unusable hash (`!` + random), so the column still differs per user. */
export function unusablePasswordHash(): string {
  return `!${base64urlEncode(randomBytes(16))}`;
}
const PREFIX = "pbkdf2_sha256";

function bunPassword(opts: PasswordOptions): BunPasswordLike | null {
  if (opts.bunPassword !== undefined) return opts.bunPassword;
  const g = globalThis as { Bun?: { password?: BunPasswordLike } };
  return g.Bun?.password ?? null;
}

function preferred(opts: PasswordOptions): "argon2id" | "pbkdf2" {
  if (opts.algorithm) return opts.algorithm;
  return bunPassword(opts) ? "argon2id" : "pbkdf2";
}

/** How new passwords are hashed on this runtime, e.g. "pbkdf2-sha256, 600000 iterations". No secrets. */
export function describePasswordHashing(opts: PasswordOptions = {}): string {
  if (preferred(opts) === "argon2id") return `argon2id, m=${opts.memoryCost ?? DEFAULT_MEMORY_COST} KiB, t=${opts.timeCost ?? DEFAULT_TIME_COST}`;
  return `pbkdf2-sha256, ${opts.iterations ?? DEFAULT_ITERATIONS} iterations`;
}

/** CPU time per request on the Cloudflare Workers Free plan, in ms (not configurable there). */
export const WORKERS_FREE_CPU_MS = 10;
/** Measured on workerd: one PBKDF2-SHA256 hash at 600,000 iterations costs about 250 ms of CPU. */
const WORKERD_MS_PER_100K_ITERATIONS = 42;

/** Estimated CPU time of one PBKDF2-SHA256 hash on workerd, in ms. */
export function pbkdf2WorkersCpuMs(iterations: number): number {
  return Math.ceil((iterations / 100_000) * WORKERD_MS_PER_100K_ITERATIONS);
}

/**
 * The `[limits] cpu_ms` a Worker hashing passwords with PBKDF2 should have: a sign-in can verify
 * and then rehash (two hashes), doubled for headroom, rounded up to 100 ms.
 */
export function suggestedWorkersCpuMs(iterations: number): number {
  return Math.ceil((4 * pbkdf2WorkersCpuMs(iterations)) / 100) * 100;
}

/** Why PBKDF2 will not fit the Workers CPU budget and what to do, or null when it fits. */
export function workersCpuWarning(opts: PasswordOptions = {}): string | null {
  if (opts.workersCpuMs === false || preferred({ ...opts, bunPassword: null }) !== "pbkdf2") return null;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const budget = opts.workersCpuMs ?? WORKERS_FREE_CPU_MS;
  const cost = pbkdf2WorkersCpuMs(iterations);
  if (cost <= budget) return null;
  const suggested = suggestedWorkersCpuMs(iterations);
  const fits = Math.floor((budget / WORKERD_MS_PER_100K_ITERATIONS) * 100_000);
  return (
    `auth(): PBKDF2-SHA256 at ${iterations} iterations costs about ${cost} ms of CPU per password hash on Workers, ` +
    `over the ${budget} ms CPU budget${budget === WORKERS_FREE_CPU_MS ? " (the Workers Free plan limit)" : ""}, so sign-up, sign-in and password changes may fail (error 1102). ` +
    `Options: (1) a Workers Paid plan with [limits] cpu_ms = ${suggested} or more in wrangler.toml (miu deploy cloudflare writes it), then auth({ password: { workersCpuMs: ${suggested} } }); ` +
    `(2) fewer iterations, auth({ password: { iterations: ${fits} } }) fits ${budget} ms, but a leaked hash becomes ${Math.max(1, Math.round(iterations / Math.max(1, fits)))}x cheaper to guess offline (OWASP recommends 600000); ` +
    `(3) sign users in without passwords on Workers (passkeys or OAuth), or delegate sign-in to an external identity provider. ` +
    `Set auth({ password: { workersCpuMs: false } }) to silence this.`
  );
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

function unsupported(kind: string): never {
  throw errors.custom({
    code: "MIU_E_AUTH_HASH_UNSUPPORTED",
    status: 500,
    message: `Cannot verify ${kind} password hashes on this runtime`,
    fix: "bcrypt and argon2 hashes need Bun (Bun.password). Run on Bun, or have users reset their password so it is stored as pbkdf2_sha256.",
  });
}

export async function hashPassword(password: string, opts: PasswordOptions = {}): Promise<string> {
  if (preferred(opts) === "argon2id") {
    const bp = bunPassword(opts);
    if (!bp) unsupported("argon2id");
    return limited(opts, () => bp.hash(password, { algorithm: "argon2id", memoryCost: opts.memoryCost ?? DEFAULT_MEMORY_COST, timeCost: opts.timeCost ?? DEFAULT_TIME_COST }));
  }
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  // Salt: random bytes as a base64url string, used as UTF-8 like Django's alphanumeric salts.
  const salt = base64urlEncode(randomBytes(16));
  const hash = await limited(opts, () => pbkdf2(password, salt, iterations));
  return `${PREFIX}$${iterations}$${salt}$${base64Encode(hash)}`;
}

/**
 * Accepts `pbkdf2_sha256$…` (ours and Django's), and on Bun `$argon2id$…` and bcrypt
 * `$2a$/$2b$/$2y$…`. Throws MIU_E_AUTH_HASH_UNSUPPORTED for anything else.
 */
export async function verifyPassword(password: string, stored: string, opts: PasswordOptions = {}): Promise<boolean> {
  if (stored.startsWith(UNUSABLE_PASSWORD)) return false;
  if (stored.startsWith(`${PREFIX}$`)) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
    const expected = base64Decode(parts[3]);
    if (!expected) return false;
    const actual = await limited(opts, () => pbkdf2(password, parts[2], iterations));
    return timingSafeEqual(actual, expected);
  }
  const isArgon = stored.startsWith("$argon2");
  const isBcrypt = /^\$2[aby]\$/.test(stored);
  if (isArgon || isBcrypt) {
    const bp = bunPassword(opts);
    if (!bp) unsupported(isArgon ? "argon2" : "bcrypt");
    try {
      return await limited(opts, () => bp.verify(password, stored));
    } catch {
      return false;
    }
  }
  return unsupported("unrecognized");
}

/** True when `stored` should be replaced by a fresh `hashPassword` (done on login). */
export function needsRehash(stored: string, opts: PasswordOptions = {}): boolean {
  const want = preferred(opts);
  if (want === "argon2id") {
    if (!stored.startsWith("$argon2id$")) return true;
    // Upgrade weaker hashes; never downgrade stronger ones (e.g. Bun's older 64 MiB default).
    const p = argonParams(stored);
    return !p || p.m < (opts.memoryCost ?? DEFAULT_MEMORY_COST) || p.t < (opts.timeCost ?? DEFAULT_TIME_COST);
  }
  if (!stored.startsWith(`${PREFIX}$`)) return true;
  const iterations = Number(stored.split("$")[1]);
  return !(iterations >= (opts.iterations ?? DEFAULT_ITERATIONS));
}
