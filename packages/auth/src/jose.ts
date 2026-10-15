// The JWT/JWS pieces OAuth and passkeys need: RS256/ES256 verification against JWKs, ES256 signing
// (Apple's client secret), and DER → raw ECDSA signatures. Web Crypto only.

import { base64Decode, base64urlDecode, base64urlEncode, utf8 } from "@miujs/session";

export type JwsAlgorithm = "RS256" | "ES256";

/**
 * A JSON Web Key (RFC 7517). Same shape as the DOM's `JsonWebKey`, declared here so the package's
 * types work without lib "dom" (Node projects with @types/node).
 */
export interface Jwk {
  kty?: string;
  crv?: string;
  alg?: string;
  kid?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  k?: string;
}

/** The key object Web Crypto returns (`CryptoKeyLike`), named without lib "dom". */
export type CryptoKeyLike = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [key: string]: unknown;
}

const dec = new TextDecoder("utf-8", { fatal: true });

function fail(why: string): never {
  throw new Error(`JWT: ${why}`);
}

function part(s: string): unknown {
  const bytes = base64urlDecode(s);
  if (!bytes) fail("bad base64url");
  try {
    return JSON.parse(dec.decode(bytes));
  } catch {
    return fail("bad JSON");
  }
}

/** Splits and parses a compact JWS without checking anything. Never trust the result on its own. */
export function decodeJwt(token: string): { header: JwsHeader; payload: Record<string, unknown>; signingInput: string; signature: Uint8Array } {
  if (typeof token !== "string" || token.length > 16_384) fail("not a token");
  const parts = token.split(".");
  if (parts.length !== 3) fail("expected three parts");
  const header = part(parts[0]) as JwsHeader;
  const payload = part(parts[1]) as Record<string, unknown>;
  if (!header || typeof header !== "object" || typeof header.alg !== "string") fail("bad header");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("bad payload");
  const signature = base64urlDecode(parts[2]);
  if (!signature) fail("bad signature encoding");
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature };
}

/** Imports a public JWK for `alg`, refusing keys of another type or declared for another use. */
export async function importVerifyKey(jwk: Jwk, alg: JwsAlgorithm): Promise<CryptoKeyLike> {
  if (jwk.alg !== undefined && jwk.alg !== alg) fail(`key is for ${jwk.alg}, token says ${alg}`);
  if (jwk.use !== undefined && jwk.use !== "sig") fail("key is not a signing key");
  if (alg === "RS256") {
    if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") fail("RS256 needs an RSA key");
    return crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  if (alg !== "ES256") fail(`algorithm ${String(alg)} is not allowed`);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") fail("ES256 needs a P-256 key");
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** Verifies a raw signature made with `alg` (ES256 signatures in the 64-byte r||s form). */
export async function verifySignature(alg: JwsAlgorithm, key: CryptoKeyLike, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    if (alg === "RS256") return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
    if (signature.length !== 64) return false;
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

/**
 * Verifies a compact JWS. Only RS256 and ES256 are accepted (never `none` or HMAC), and the key's
 * type must match the header's `alg`. Checks the signature only: callers check the claims.
 */
export async function verifyJws(
  token: string,
  resolveKey: (header: JwsHeader) => Promise<(Jwk) | null>,
): Promise<{ header: JwsHeader; payload: Record<string, unknown> }> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== "RS256" && header.alg !== "ES256") fail(`algorithm ${header.alg} is not allowed`);
  if (header.crit !== undefined) fail("critical header extensions are not supported");
  const jwk = await resolveKey(header);
  if (!jwk) fail("no key matches the token");
  const key = await importVerifyKey(jwk, header.alg);
  if (!(await verifySignature(header.alg, key, signature, utf8(signingInput)))) fail("bad signature");
  return { header, payload };
}

/** Imports an ES256 private key from PKCS#8 PEM (e.g. the `.p8` file Apple gives you). */
export async function importEs256PrivateKey(pem: string): Promise<CryptoKeyLike> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = body ? base64Decode(body) : null;
  if (!der || !/-----BEGIN PRIVATE KEY-----/.test(pem)) fail("expected a PKCS#8 PEM private key (-----BEGIN PRIVATE KEY-----)");
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Signs `payload` as an ES256 JWT. */
export async function signJwt(payload: Record<string, unknown>, header: { kid?: string }, key: CryptoKeyLike): Promise<string> {
  const h = base64urlEncode(utf8(JSON.stringify({ alg: "ES256", ...header, typ: "JWT" })));
  const p = base64urlEncode(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${h}.${p}`)));
  return `${h}.${p}.${base64urlEncode(sig)}`;
}

/** ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` → 64-byte r||s for P-256. Null when malformed. */
export function derToRawSignature(der: Uint8Array, size = 32): Uint8Array | null {
  let i = 0;
  if (der.length < 8 || der[i++] !== 0x30) return null;
  const len = der[i++];
  if (len & 0x80 || len !== der.length - 2) return null;
  const out = new Uint8Array(size * 2);
  for (let n = 0; n < 2; n++) {
    if (der[i++] !== 0x02) return null;
    const l = der[i++];
    if (l === undefined || l < 1 || l > size + 1 || i + l > der.length) return null;
    let v = der.subarray(i, i + l);
    i += l;
    if (v.length === size + 1) {
      if (v[0] !== 0) return null;
      v = v.subarray(1);
    }
    out.set(v, n * size + (size - v.length));
  }
  return i === der.length ? out : null;
}
