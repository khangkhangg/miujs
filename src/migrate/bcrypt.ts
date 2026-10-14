import { randomBytes, timingSafeEqual, utf8 } from "../batteries/auth/encoding.ts";
import { verifyPassword } from "../batteries/auth/password.ts";
import { PI_HEX } from "./blowfish-pi.ts";

/**
 * Pure-TypeScript bcrypt, compatible with PHP `password_hash()` (`$2y$`),
 * Laravel, Python `bcrypt` and OpenBSD (`$2a$`/`$2b$`). Passwords are UTF-8
 * encoded and truncated to 72 bytes, exactly like the C implementations.
 * Runs everywhere (no WebCrypto needed); cost 10 takes roughly 50-100ms.
 */

const B64 = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HASH_RE = /^\$2[aby]\$(\d\d)\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/;
// "OrpheanBeholderScryDoubt" as six big-endian words.
const MAGIC = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274];

let INIT: Int32Array | undefined;
function initState(): Int32Array {
  if (!INIT) {
    INIT = new Int32Array(1042);
    for (let i = 0; i < 1042; i++) INIT[i] = parseInt(PI_HEX.slice(i * 8, i * 8 + 8), 16) | 0;
  }
  return INIT;
}

/** Check a password against a `$2a$`/`$2b$`/`$2y$` bcrypt hash in constant time. Malformed hashes return false. */
export async function verifyBcrypt(password: string, hash: string): Promise<boolean> {
  const m = HASH_RE.exec(hash);
  if (!m) return false;
  const cost = Number(m[1]);
  if (cost < 4 || cost > 31) return false;
  const salt = decode64(m[2]!, 16);
  const computed = encode64(eksBlowfish(utf8(password), salt, cost));
  return timingSafeEqual(utf8(computed), utf8(m[3]!));
}

/** Hash a password with bcrypt as `$2y$<cost>$…` (PHP's default prefix). Cost 4–31, default 10. */
export async function hashBcrypt(password: string, cost = 10): Promise<string> {
  if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new RangeError("bcrypt cost must be an integer from 4 to 31");
  const salt = randomBytes(16);
  const out = eksBlowfish(utf8(password), salt, cost);
  return `$2y$${String(cost).padStart(2, "0")}$${encode64(salt)}${encode64(out)}`;
}

export interface LegacyPasswordOptions {
  /**
   * Also accept unsalted MD5/SHA-1 hex digests and Django's `md5$salt$hash` /
   * `sha1$salt$hash`. These are trivially crackable: verify, then re-hash immediately.
   */
  allowInsecure?: boolean;
}

/**
 * Verify a password against whatever an old PHP or Python app stored:
 * bcrypt (`$2y$`, `$2b$`, `$2a$`), Django `bcrypt$…` / `bcrypt_sha256$…`,
 * Django `pbkdf2_sha256$…`, and (opt-in) MD5/SHA-1. Unknown formats return false.
 * After a successful login, re-hash with `hashPassword()` to upgrade.
 */
export async function verifyLegacyPassword(password: string, hash: string, opts: LegacyPasswordOptions = {}): Promise<boolean> {
  if (hash.startsWith("$2")) return verifyBcrypt(password, hash);
  if (hash.startsWith("bcrypt$")) return verifyBcrypt(password, hash.slice(7));
  if (hash.startsWith("bcrypt_sha256$")) {
    const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(password))));
    return verifyBcrypt(digest, hash.slice(14));
  }
  if (hash.startsWith("pbkdf2_sha256$")) return verifyPassword(password, hash);
  if (!opts.allowInsecure) return false;
  const lower = hash.toLowerCase();
  if (/^[0-9a-f]{32}$/.test(lower)) return eqHex(hex(md5(utf8(password))), lower);
  if (/^[0-9a-f]{40}$/.test(lower)) return eqHex(await sha1Hex(password), lower);
  const dj = /^(md5|sha1)\$([^$]*)\$([0-9a-f]+)$/.exec(hash);
  if (dj) {
    const input = dj[2]! + password;
    return eqHex(dj[1] === "md5" ? hex(md5(utf8(input))) : await sha1Hex(input), dj[3]!);
  }
  return false;
}

// ---------- eksblowfish ----------

function eksBlowfish(password: Uint8Array, salt: Uint8Array, cost: number): Uint8Array {
  // Key = password bytes (max 72) + NUL terminator, used cyclically.
  const key = new Uint8Array(Math.min(password.length, 72) + 1);
  key.set(password.subarray(0, 72));
  const st = initState().slice();
  const P = st.subarray(0, 18);
  const S = st.subarray(18);
  const saltWords = toWords(salt);
  const keyWords = streamWords(key);
  const saltStream = streamWords(salt);

  expand(P, S, keyWords, saltWords);
  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i++) {
    expand(P, S, keyWords, null);
    expand(P, S, saltStream, null);
  }

  const lr = new Int32Array(MAGIC);
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 6; j += 2) encipher(lr, j, P, S);
  }
  const out = new Uint8Array(24);
  for (let i = 0; i < 6; i++) {
    out[i * 4] = lr[i]! >>> 24;
    out[i * 4 + 1] = lr[i]! >>> 16;
    out[i * 4 + 2] = lr[i]! >>> 8;
    out[i * 4 + 3] = lr[i]!;
  }
  return out.subarray(0, 23);
}

/** 18 words read cyclically from `key` (what bcrypt's stream2word yields per expansion). */
function streamWords(key: Uint8Array): Int32Array {
  const w = new Int32Array(18);
  let j = 0;
  for (let i = 0; i < 18; i++) {
    let x = 0;
    for (let k = 0; k < 4; k++) {
      x = (x << 8) | key[j]!;
      j = (j + 1) % key.length;
    }
    w[i] = x;
  }
  return w;
}

function toWords(b: Uint8Array): Int32Array {
  const w = new Int32Array(b.length / 4);
  for (let i = 0; i < w.length; i++) w[i] = (b[i * 4]! << 24) | (b[i * 4 + 1]! << 16) | (b[i * 4 + 2]! << 8) | b[i * 4 + 3]!;
  return w;
}

/**
 * Blowfish key schedule. `keyWords` XORs into P; `salt` (4 words, cycled) is mixed
 * into the data blocks (bcrypt's expandstate); null salt is plain expand0state.
 */
function expand(P: Int32Array, S: Int32Array, keyWords: Int32Array, salt: Int32Array | null): void {
  for (let i = 0; i < 18; i++) P[i] = P[i]! ^ keyWords[i]!;
  const lr = new Int32Array(2);
  let s = 0;
  for (let i = 0; i < 18; i += 2) {
    if (salt) {
      lr[0] = lr[0]! ^ salt[s++ & 3]!;
      lr[1] = lr[1]! ^ salt[s++ & 3]!;
    }
    encipher(lr, 0, P, S);
    P[i] = lr[0]!;
    P[i + 1] = lr[1]!;
  }
  for (let i = 0; i < 1024; i += 2) {
    if (salt) {
      lr[0] = lr[0]! ^ salt[s++ & 3]!;
      lr[1] = lr[1]! ^ salt[s++ & 3]!;
    }
    encipher(lr, 0, P, S);
    S[i] = lr[0]!;
    S[i + 1] = lr[1]!;
  }
}

function encipher(lr: Int32Array, off: number, P: Int32Array, S: Int32Array): void {
  let l = lr[off]! ^ P[0]!;
  let r = lr[off + 1]!;
  for (let i = 1; i <= 16; i += 2) {
    r ^= (((S[l >>> 24]! + S[256 | ((l >>> 16) & 255)]!) ^ S[512 | ((l >>> 8) & 255)]!) + S[768 | (l & 255)]!) ^ P[i]!;
    l ^= (((S[r >>> 24]! + S[256 | ((r >>> 16) & 255)]!) ^ S[512 | ((r >>> 8) & 255)]!) + S[768 | (r & 255)]!) ^ P[i + 1]!;
  }
  lr[off] = r ^ P[17]!;
  lr[off + 1] = l;
}

// ---------- bcrypt's base64 variant ----------

function encode64(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const c1 = b[i]!;
    const c2 = b[i + 1];
    const c3 = b[i + 2];
    out += B64[c1 >> 2];
    out += B64[((c1 & 3) << 4) | ((c2 ?? 0) >> 4)];
    if (c2 === undefined) break;
    out += B64[((c2 & 15) << 2) | ((c3 ?? 0) >> 6)];
    if (c3 === undefined) break;
    out += B64[c3 & 63];
  }
  return out;
}

function decode64(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < s.length && o < len; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

// ---------- legacy digests ----------

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function eqHex(a: string, b: string): boolean {
  return timingSafeEqual(utf8(a), utf8(b.toLowerCase()));
}

async function sha1Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", utf8(s))));
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

/** Minimal MD5 (RFC 1321). WebCrypto has no MD5; used only to verify legacy hashes. */
export function md5(msg: Uint8Array): Uint8Array {
  const len = ((msg.length + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(len);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(len - 8, (msg.length * 8) >>> 0, true);
  dv.setUint32(len - 4, Math.floor(msg.length / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) (f = (b & c) | (~b & d)), (g = i);
      else if (i < 32) (f = (d & b) | (~d & c)), (g = (5 * i + 1) & 15);
      else if (i < 48) (f = b ^ c ^ d), (g = (3 * i + 5) & 15);
      else (f = c ^ (b | ~d)), (g = (7 * i) & 15);
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i]! + M[g]!) | 0;
      const s = MD5_S[(i >> 4) * 4 + (i & 3)]!;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true);
  ov.setInt32(4, b0, true);
  ov.setInt32(8, c0, true);
  ov.setInt32(12, d0, true);
  return out;
}
