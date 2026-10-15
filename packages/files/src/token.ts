import { filesErrors } from "./errors.ts";

/** What a token authorizes. Short field names keep URLs short; the payload is signed, not secret. */
export interface TokenPayload {
  /** Purpose: "url" for signed GET/PUT URLs, "mpu" for a multipart upload id, "pre" for a GET prefix. */
  p: "url" | "mpu" | "pre";
  /** Object key. */
  k: string;
  /** Expiry, seconds since the epoch. */
  e: number;
  /** HTTP method ("GET" or "PUT") for "url" tokens. */
  m?: "GET" | "PUT";
  /** Required content-type (PUT) or the upload's declared type (mpu). */
  ct?: string;
  /** Max upload size in bytes (PUT). */
  ms?: number;
  /** 1 = publicly cacheable download (GET). */
  c?: 1;
  /** Download filename (GET): served with Content-Disposition: attachment. */
  d?: string;
  /** Store upload id (mpu). */
  u?: string;
  /** User id that created the upload (mpu). */
  uid?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
// Domain separation: the HMAC key is derived from the secret, so a secret shared with
// @miujs/session (SESSION_SECRET) can never produce a signature valid in the other package.
const LABEL = enc.encode("miujs/files/token/v1");

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const derived = await crypto.subtle.sign("HMAC", root, LABEL);
      return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    if (keys.size > 16) keys.clear();
    keys.set(secret, k);
  }
  return k;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array | null {
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

/** Constant-time comparison: the time taken does not depend on where the inputs differ. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function mac(secret: string, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(secret), enc.encode(data)));
}

/** `base64url(JSON payload) "." base64url(HMAC-SHA256)`, signed with the first secret. */
export async function signToken(secrets: string[], payload: TokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await mac(secrets[0], body))}`;
}

/**
 * Verify the signature (against every secret, for rotation), then the purpose and expiry.
 * The HMAC covers the whole payload: key, method, expiry and every constraint.
 */
export async function verifyToken(secrets: string[], token: string, purpose: TokenPayload["p"], now = Math.floor(Date.now() / 1000)): Promise<TokenPayload> {
  if (typeof token !== "string" || token.length > 4096) throw filesErrors.tokenInvalid("malformed");
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) throw filesErrors.tokenInvalid("malformed");
  const body = token.slice(0, dot);
  const sig = unb64url(token.slice(dot + 1));
  if (!sig || sig.length !== 32) throw filesErrors.tokenInvalid("malformed");
  let ok = false;
  for (const s of secrets) if (timingSafeEqual(await mac(s, body), sig)) ok = true;
  if (!ok) throw filesErrors.tokenInvalid("bad signature");
  let payload: TokenPayload;
  try {
    payload = JSON.parse(dec.decode(unb64url(body)!));
  } catch {
    throw filesErrors.tokenInvalid("malformed");
  }
  if (typeof payload !== "object" || payload === null || payload.p !== purpose || typeof payload.k !== "string" || typeof payload.e !== "number") {
    throw filesErrors.tokenInvalid("wrong token type");
  }
  if (now > payload.e) throw filesErrors.tokenExpired();
  return payload;
}
