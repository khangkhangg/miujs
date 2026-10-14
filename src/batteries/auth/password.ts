import { fromBase64, randomBytes, timingSafeEqual, toBase64, utf8 } from "./encoding.ts";

/**
 * Default PBKDF2 iterations. 100,000 is the maximum Cloudflare Workers' WebCrypto
 * allows for PBKDF2, so hashes made here verify on every supported runtime.
 */
export const DEFAULT_ITERATIONS = 100_000;

const ALGORITHM = "pbkdf2_sha256";
const SALT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Hash a password as Django-compatible `pbkdf2_sha256$<iterations>$<salt>$<base64 hash>`
 * (PBKDF2-HMAC-SHA256, 32-byte key), so existing Django user tables can be reused as-is.
 * Note: iterations above 100,000 fail on Cloudflare Workers.
 */
export async function hashPassword(password: string, opts: { iterations?: number } = {}): Promise<string> {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = randomSalt(22);
  const hash = await pbkdf2(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${salt}$${toBase64(hash)}`;
}

/**
 * Check a password against an encoded hash in constant time. Unknown formats return false.
 * Only `pbkdf2_sha256` is supported today; bcrypt (`$2y$`/`$2b$`, e.g. from PHP/Laravel) is on the roadmap.
 * Django hashes with more than 100,000 iterations throw on Cloudflare Workers.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;
  const expected = fromBase64(parsed.hash);
  if (!expected || expected.length === 0) return false;
  const actual = await pbkdf2(password, parsed.salt, parsed.iterations, expected.length);
  return timingSafeEqual(actual, expected);
}

/** True when the hash uses another algorithm or a different iteration count than desired. */
export function needsRehash(encoded: string, opts: { iterations?: number } = {}): boolean {
  const parsed = parse(encoded);
  return !parsed || parsed.iterations !== (opts.iterations ?? DEFAULT_ITERATIONS);
}

function parse(encoded: string): { iterations: number; salt: string; hash: string } | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return undefined;
  const [, iter, salt, hash] = parts as [string, string, string, string];
  if (!/^[1-9]\d*$/.test(iter) || !salt || !hash) return undefined;
  return { iterations: Number(iter), salt, hash };
}

async function pbkdf2(password: string, salt: string, iterations: number, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(salt), iterations }, key, length * 8);
  return new Uint8Array(bits);
}

function randomSalt(length: number): string {
  // Rejection sampling keeps the alphabet unbiased (62 * 4 = 248 < 256).
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += SALT_CHARS[b % 62];
    }
  }
  return out;
}
