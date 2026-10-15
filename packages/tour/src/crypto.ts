// Signing for tour links (share links, unlock cookies, tile URLs), password hashing and the
// external-processor HMAC. Web Crypto only, so it runs on every runtime including Workers.
import { tourErrors } from "./errors.ts";

/** What a tour token grants. Short field names keep URLs short; the payload is signed, not secret. */
export type TourTokenPayload =
  /** A share link: opens a private or password-protected tour until `e`. `v` = the tour's share version. */
  | { p: "share"; tour: string; v: number; e: number }
  /** Set after a correct password. `v` = the tour's password version (changing the password revokes it). */
  | { p: "unlock"; tour: string; v: number; e: number };

const enc = new TextEncoder();
const dec = new TextDecoder();
const LABEL = enc.encode("miujs/tour/token/v1");
const MAX_TOKEN = 2048;

const derived = new Map<string, Promise<CryptoKey>>();
function tokenKey(secret: string): Promise<CryptoKey> {
  let k = derived.get(secret);
  if (!k) {
    k = (async () => {
      // Domain separation: a secret shared with @miujs/files or @miujs/session never yields a
      // signature that is valid in another package.
      const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sub = await crypto.subtle.sign("HMAC", root, LABEL);
      return crypto.subtle.importKey("raw", sub, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    if (derived.size > 16) derived.clear();
    derived.set(secret, k);
  }
  return k;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time comparison. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** `base64url(JSON) "." base64url(HMAC)`, signed with the first secret. Deterministic. */
export async function signTourToken(secrets: string[], payload: TourTokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await tokenKey(secrets[0]), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Checks the signature against every secret (rotation), then the purpose and the expiry (`now` in seconds). */
export async function verifyTourToken<P extends TourTokenPayload["p"]>(
  secrets: string[],
  token: string,
  purpose: P,
  now = Math.floor(Date.now() / 1000),
): Promise<Extract<TourTokenPayload, { p: P }>> {
  if (typeof token !== "string" || token.length > MAX_TOKEN) throw tourErrors.tokenInvalid("malformed");
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) throw tourErrors.tokenInvalid("malformed");
  const body = token.slice(0, dot);
  const sig = unb64url(token.slice(dot + 1));
  if (!sig || sig.length !== 32) throw tourErrors.tokenInvalid("malformed");
  let ok = false;
  for (const s of secrets) {
    const want = new Uint8Array(await crypto.subtle.sign("HMAC", await tokenKey(s), enc.encode(body)));
    if (timingSafeEqual(want, sig)) ok = true;
  }
  if (!ok) throw tourErrors.tokenInvalid("bad signature");
  let payload: any;
  try {
    payload = JSON.parse(dec.decode(unb64url(body)!));
  } catch {
    throw tourErrors.tokenInvalid("malformed");
  }
  if (!payload || typeof payload !== "object" || payload.p !== purpose || typeof payload.tour !== "string" || typeof payload.e !== "number") {
    throw tourErrors.tokenInvalid("wrong token type");
  }
  if (now > payload.e) throw tourErrors.tokenExpired();
  return payload;
}

// ---- passwords ----------------------------------------------------------------------------

// Workers cap PBKDF2 at 100 000 iterations.
const ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  const salt = unb64url(parts[2]);
  const want = unb64url(parts[3]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > ITERATIONS || !salt || !want) return false;
  return timingSafeEqual(await pbkdf2(password, salt, iterations), want);
}

// ---- external processor signatures ----------------------------------------------------------

/** Seconds a processor request or callback stays valid (against replays). */
export const SIGNATURE_TOLERANCE = 300;

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  let s = "";
  for (const b of sig) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The `x-miu-tour-signature` header for `body`: `t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export async function signProcessorBody(secret: string, body: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${now},v1=${await hmacHex(secret, `${now}.${body}`)}`;
}

/** True when `header` signs exactly `body` with one of `secrets`, within the tolerance. */
export async function verifyProcessorSignature(secrets: string[], header: string | null, body: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const m = typeof header === "string" ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim()) : null;
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > SIGNATURE_TOLERANCE) return false;
  const got = enc.encode(m[2]);
  let ok = false;
  for (const s of secrets) if (timingSafeEqual(enc.encode(await hmacHex(s, `${t}.${body}`)), got)) ok = true;
  return ok;
}
