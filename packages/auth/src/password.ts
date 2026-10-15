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
  /** @internal Override `Bun.password` (null = pretend it is absent). */
  bunPassword?: BunPasswordLike | null;
}

export const DEFAULT_ITERATIONS = 600_000;
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
    return bp.hash(password, { algorithm: "argon2id" });
  }
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  // Salt: random bytes as a base64url string, used as UTF-8 like Django's alphanumeric salts.
  const salt = base64urlEncode(randomBytes(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `${PREFIX}$${iterations}$${salt}$${base64Encode(hash)}`;
}

/**
 * Accepts `pbkdf2_sha256$…` (ours and Django's), and on Bun `$argon2id$…` and bcrypt
 * `$2a$/$2b$/$2y$…`. Throws MIU_E_AUTH_HASH_UNSUPPORTED for anything else.
 */
export async function verifyPassword(password: string, stored: string, opts: PasswordOptions = {}): Promise<boolean> {
  if (stored.startsWith(`${PREFIX}$`)) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
    const expected = base64Decode(parts[3]);
    if (!expected) return false;
    const actual = await pbkdf2(password, parts[2], iterations);
    return timingSafeEqual(actual, expected);
  }
  const isArgon = stored.startsWith("$argon2");
  const isBcrypt = /^\$2[aby]\$/.test(stored);
  if (isArgon || isBcrypt) {
    const bp = bunPassword(opts);
    if (!bp) unsupported(isArgon ? "argon2" : "bcrypt");
    try {
      return await bp.verify(password, stored);
    } catch {
      return false;
    }
  }
  return unsupported("unrecognized");
}

/** True when `stored` should be replaced by a fresh `hashPassword` (done on login). */
export function needsRehash(stored: string, opts: PasswordOptions = {}): boolean {
  const want = preferred(opts);
  if (want === "argon2id") return !stored.startsWith("$argon2id$");
  if (!stored.startsWith(`${PREFIX}$`)) return true;
  const iterations = Number(stored.split("$")[1]);
  return !(iterations >= (opts.iterations ?? DEFAULT_ITERATIONS));
}
