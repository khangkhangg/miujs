// Small Web Crypto helpers shared by @miujs/session and @miujs/auth.

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s) as Uint8Array<ArrayBuffer>;
}

export function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Standard base64 → bytes. Returns null on malformed input. */
export function base64Decode(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function base64urlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64Decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** 256-bit random identifier, base64url. */
export function randomId(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes));
}

/**
 * Constant-time byte comparison: the time depends only on the lengths, never on where the
 * inputs first differ. Use it for signatures, token hashes and password hashes.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof data === "string" ? utf8(data) : (data as Uint8Array<ArrayBuffer>);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(data)));
}

/** `value + "." + base64url(HMAC-SHA256(secret, value))`. */
export async function sign(value: string, secret: string): Promise<string> {
  return `${value}.${base64urlEncode(await hmacSha256(secret, value))}`;
}

/**
 * Verifies a `sign()`ed string against any of `secrets` (first = current, rest = rotated out).
 * Returns the value, or null when the signature is missing or wrong.
 */
export async function unsign(signed: string, secrets: string[]): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const given = base64urlDecode(signed.slice(dot + 1));
  if (!given || given.length !== 32) return null;
  let ok = false;
  for (const secret of secrets) {
    // No early exit, so the time does not reveal which secret matched.
    if (timingSafeEqual(await hmacSha256(secret, value), given)) ok = true;
  }
  return ok ? value : null;
}
