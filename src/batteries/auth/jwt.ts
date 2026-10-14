import { HttpError } from "../../core/errors.ts";
import { fromBase64, fromBase64Url, toBase64Url, utf8 } from "./encoding.ts";

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

/**
 * Supported JWS algorithms. `EdDSA` means Ed25519 here; `Ed25519` is its fully-specified name (RFC 9864).
 */
export type JwtAlgorithm = "HS256" | "RS256" | "ES256" | "EdDSA" | "Ed25519";

/**
 * A signing or verification key:
 * - a string: an HS256 secret, or a PEM key (`PUBLIC KEY` = SPKI, `PRIVATE KEY` = PKCS#8);
 * - a WebCrypto `CryptoKey`;
 * - a JWK object.
 */
export type JwtKey = string | CryptoKey | JsonWebKey;

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [name: string]: unknown;
}

/** Resolves the verification key for a token header (see `createRemoteJwks` / `createLocalJwks`). */
export interface JwksResolver {
  resolve(header: JwtHeader): Promise<JsonWebKey | undefined>;
}

/** A JSON Web Key Set document. */
export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

export interface SignJwtOptions {
  /** Default `HS256` (string secrets only); required for every other key. */
  algorithm?: JwtAlgorithm;
  /** Key id, written to the `kid` header so verifiers can pick the key from a JWKS. */
  kid?: string;
  /** Seconds until expiry (sets `exp`). */
  expiresIn?: number;
  issuer?: string;
  audience?: string | string[];
  /** Clock in milliseconds; defaults to Date.now. */
  now?: () => number;
}

export interface VerifyJwtOptions {
  /**
   * Algorithms to accept. Never inferred from the token: the token's `alg` must be listed AND
   * match the key type. Defaults to `["HS256"]` for string secrets; required for any other key.
   */
  algorithms?: JwtAlgorithm[];
  issuer?: string;
  /** Accept tokens whose `aud` contains this (or any of these) audience(s). */
  audience?: string | string[];
  /** Clock skew tolerance in seconds for `exp` and `nbf`. Default 5. */
  leeway?: number;
  now?: () => number;
}

interface AlgSpec {
  /** importKey algorithm */
  // Derived from SubtleCrypto so the types resolve under both DOM and @cloudflare/workers-types.
  importParams: Parameters<SubtleCrypto["importKey"]>[2];
  /** sign/verify algorithm */
  signParams: Parameters<SubtleCrypto["sign"]>[0];
  kty: "oct" | "RSA" | "EC" | "OKP";
  crv?: string;
  /** Fixed signature length in bytes, when the algorithm has one. */
  sigLength?: number;
}

const ALGS: Record<JwtAlgorithm, AlgSpec> = {
  HS256: { importParams: { name: "HMAC", hash: "SHA-256" }, signParams: "HMAC", kty: "oct" },
  RS256: { importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, signParams: "RSASSA-PKCS1-v1_5", kty: "RSA" },
  ES256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    signParams: { name: "ECDSA", hash: "SHA-256" },
    kty: "EC",
    crv: "P-256",
    sigLength: 64,
  },
  EdDSA: { importParams: { name: "Ed25519" }, signParams: { name: "Ed25519" }, kty: "OKP", crv: "Ed25519", sigLength: 64 },
  Ed25519: { importParams: { name: "Ed25519" }, signParams: { name: "Ed25519" }, kty: "OKP", crv: "Ed25519", sigLength: 64 },
};

const ED = new Set(["EdDSA", "Ed25519"]);
/** A JWK's `alg` restricts it to that algorithm; EdDSA and Ed25519 name the same thing for OKP/Ed25519 keys. */
const jwkAlgAllows = (jwkAlg: string | undefined, alg: JwtAlgorithm) =>
  jwkAlg === undefined || jwkAlg === alg || (ED.has(jwkAlg) && ED.has(alg));

const MIN_RSA_BITS = 2048;
const isAlg = (a: unknown): a is JwtAlgorithm => typeof a === "string" && Object.hasOwn(ALGS, a);
const isPem = (s: string) => s.trimStart().startsWith("-----BEGIN");

/** Sign a JWT. HS256 with a string secret by default; pass `algorithm` for RS256 / ES256 / EdDSA keys. */
export async function signJwt(payload: JwtPayload, key: JwtKey, opts: SignJwtOptions = {}): Promise<string> {
  const alg = opts.algorithm ?? (typeof key === "string" && !isPem(key) ? "HS256" : undefined);
  if (!alg) throw new TypeError("signJwt: pass `algorithm` (RS256, ES256 or EdDSA) for non-HMAC keys");
  if (!isAlg(alg)) throw new TypeError(`signJwt: unsupported algorithm ${String(alg)}`);
  const cryptoKey = await toCryptoKey(key, alg, "sign");
  const iat = Math.floor((opts.now ?? Date.now)() / 1000);
  const claims: JwtPayload = { iat, ...payload };
  if (opts.expiresIn !== undefined) claims.exp = iat + opts.expiresIn;
  if (opts.issuer !== undefined) claims.iss = opts.issuer;
  if (opts.audience !== undefined) claims.aud = opts.audience;
  const header: JwtHeader = { alg, typ: "JWT" };
  if (opts.kid !== undefined) header.kid = opts.kid;
  const input = `${encodeJson(header)}.${encodeJson(claims)}`;
  const sig = await crypto.subtle.sign(ALGS[alg].signParams, cryptoKey, utf8(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verify a JWT and return its payload. `key` is an HS256 secret, a public key (PEM / JWK / CryptoKey),
 * a JWKS document (`{ keys }`) or a resolver from `createRemoteJwks()`. The token's `alg` must be in
 * `opts.algorithms` and fit the key type, so a public key can never be used as an HMAC secret.
 * Throws `HttpError(401, ..., { code: "invalid_token" })` on any token failure.
 */
export async function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  key: JwtKey | JwksResolver | JsonWebKeySet,
  opts: VerifyJwtOptions = {},
): Promise<T> {
  const algorithms = opts.algorithms ?? (typeof key === "string" && !isPem(key) ? ["HS256"] : undefined);
  if (!algorithms || algorithms.length === 0) {
    throw new TypeError("verifyJwt: pass `algorithms` (e.g. [\"EdDSA\"]) when verifying with a public key or JWKS");
  }
  for (const a of algorithms) if (!isAlg(a)) throw new TypeError(`verifyJwt: unsupported algorithm ${String(a)}`);

  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw invalid("Malformed token");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h) as JwtHeader | undefined;
  if (!header) throw invalid("Malformed header");
  const alg = header.alg;
  if (!isAlg(alg) || !algorithms.includes(alg)) throw invalid(`Unsupported alg ${JSON.stringify(alg)}; expected ${algorithms.join(", ")}`);
  if (header.crit !== undefined) throw invalid("Unsupported crit header");
  if (header.kid !== undefined && typeof header.kid !== "string") throw invalid("Malformed kid");

  let material: JwtKey;
  if (isResolver(key) || isKeySet(key)) {
    const jwk = isResolver(key) ? await key.resolve(header) : selectJwk(key.keys, header);
    if (!jwk) throw invalid("No matching key for token");
    material = jwk;
  } else {
    material = key;
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await toCryptoKey(material, alg, "verify");
  } catch (e) {
    if (e instanceof KeyMismatch) throw invalid(e.message);
    throw e;
  }
  const sig = fromBase64Url(s);
  const spec = ALGS[alg];
  if (!sig || (spec.sigLength !== undefined && sig.length !== spec.sigLength)) throw invalid("Invalid signature");
  if (!(await crypto.subtle.verify(spec.signParams, cryptoKey, sig, utf8(`${h}.${p}`)))) throw invalid("Invalid signature");
  const payload = decodeJson(p) as T | undefined;
  if (!payload) throw invalid("Malformed payload");

  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const leeway = opts.leeway ?? 5;
  if (payload.exp !== undefined && (typeof payload.exp !== "number" || now > payload.exp + leeway)) throw invalid("Token expired");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || now + leeway < payload.nbf)) throw invalid("Token not yet valid");
  if (opts.issuer !== undefined && payload.iss !== opts.issuer) throw invalid("Invalid issuer");
  if (opts.audience !== undefined) {
    const want = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
    const have = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud];
    if (!want.some((a) => have.includes(a))) throw invalid("Invalid audience");
  }
  return payload;
}

/**
 * Import a PEM / JWK key for one algorithm (public for verify, private for sign).
 * Useful to import once at startup instead of on every call.
 */
export function importJwtKey(key: string | JsonWebKey, alg: JwtAlgorithm, use: "sign" | "verify" = "verify"): Promise<CryptoKey> {
  if (!isAlg(alg)) throw new TypeError(`importJwtKey: unsupported algorithm ${String(alg)}`);
  return toCryptoKey(key, alg, use);
}

// ---------- JWKS ----------

/** A fixed set of keys (e.g. from config). Picks the key by `kid`, or the only key that fits `alg`. */
export function createLocalJwks(set: JsonWebKeySet): JwksResolver {
  const keys = [...set.keys];
  return { resolve: async (header) => selectJwk(keys, header) };
}

export interface RemoteJwksOptions {
  /** Seconds to cache the key set. Default 600. */
  cacheTtl?: number;
  /** Minimum seconds between refetches triggered by unknown `kid`s or failures. Default 30. */
  cooldown?: number;
  /** Request timeout in ms. Default 5000. */
  timeout?: number;
  /** Injectable fetch (tests, custom agents). */
  fetch?: typeof fetch;
  /** Clock in milliseconds. */
  now?: () => number;
}

/**
 * Keys from an issuer's JWKS URL (e.g. `https://issuer/.well-known/jwks.json`). Cached for `cacheTtl`;
 * an unknown `kid` triggers one refetch (rate-limited by `cooldown`) so key rotation just works.
 * When a refresh fails, the last good set keeps being used; with no keys at all, verification
 * fails with a 503 (`jwks_unavailable`).
 */
export function createRemoteJwks(url: string | URL, opts: RemoteJwksOptions = {}): JwksResolver & { refresh(): Promise<void> } {
  const u = new URL(String(url));
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new TypeError(`createRemoteJwks: JWKS URL must use https (got ${u.protocol}//${u.host})`);
  }
  const now = opts.now ?? Date.now;
  const ttl = (opts.cacheTtl ?? 600) * 1000;
  const cooldown = (opts.cooldown ?? 30) * 1000;
  const timeout = opts.timeout ?? 5000;
  let keys: JsonWebKey[] | undefined;
  let fetchedAt = 0;
  let lastAttempt = -Infinity;
  let inflight: Promise<void> | undefined;

  const load = () => {
    inflight ??= (async () => {
      lastAttempt = now();
      try {
        const doFetch = opts.fetch ?? fetch;
        const res = await doFetch(u.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: unknown };
        if (!body || !Array.isArray(body.keys)) throw new Error("response has no `keys` array");
        keys = body.keys.filter((k): k is JsonWebKey => !!k && typeof k === "object");
        fetchedAt = now();
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  const tryLoad = async () => {
    try {
      await load();
    } catch (e) {
      if (!keys) {
        throw new HttpError(503, `JWKS unavailable: ${e instanceof Error ? e.message : String(e)}`, { code: "jwks_unavailable" });
      }
      // keep serving the last good set
    }
  };

  return {
    async resolve(header) {
      if (!keys || now() - fetchedAt >= ttl) {
        if (inflight || now() - lastAttempt >= cooldown) await tryLoad();
        else if (!keys) throw new HttpError(503, "JWKS unavailable (recent fetch failed)", { code: "jwks_unavailable" });
      }
      let jwk = selectJwk(keys ?? [], header);
      if (!jwk && header.kid !== undefined && now() - lastAttempt >= cooldown) {
        await tryLoad();
        jwk = selectJwk(keys ?? [], header);
      }
      return jwk;
    },
    refresh: () => tryLoad(),
  };
}

function selectJwk(keys: JsonWebKey[], header: JwtHeader): JsonWebKey | undefined {
  if (!isAlg(header.alg)) return undefined;
  const spec = ALGS[header.alg];
  const fits = keys.filter((k) => {
    const x = k as JsonWebKey & { kid?: string; use?: string };
    if (x.use !== undefined && x.use !== "sig") return false;
    if (!jwkAlgAllows(x.alg, header.alg as JwtAlgorithm)) return false;
    return x.kty === spec.kty && (spec.crv === undefined || x.crv === spec.crv);
  });
  if (header.kid !== undefined) {
    const match = fits.filter((k) => (k as { kid?: string }).kid === header.kid);
    return match.length === 1 ? match[0] : undefined;
  }
  return fits.length === 1 ? fits[0] : undefined;
}

// ---------- keys ----------

class KeyMismatch extends Error {}

// Imported keys, cached per key material and algorithm (importKey is not free on the hot path).
const objectCache = new WeakMap<object, Map<string, CryptoKey>>();
const stringCache = new Map<string, Map<string, CryptoKey>>();
const STRING_CACHE_MAX = 256;

async function toCryptoKey(key: JwtKey, alg: JwtAlgorithm, use: "sign" | "verify"): Promise<CryptoKey> {
  if (isCryptoKey(key)) {
    checkCryptoKey(key, alg, use);
    return key;
  }
  const slot = `${alg}:${use}`;
  let cache: Map<string, CryptoKey> | undefined;
  if (typeof key === "string") {
    cache = stringCache.get(key);
    if (!cache) {
      if (stringCache.size >= STRING_CACHE_MAX) stringCache.delete(stringCache.keys().next().value!);
      stringCache.set(key, (cache = new Map()));
    }
  } else if (key && typeof key === "object") {
    cache = objectCache.get(key);
    if (!cache) objectCache.set(key, (cache = new Map()));
  } else {
    throw new TypeError("JWT key must be a string, CryptoKey or JWK");
  }
  const hit = cache.get(slot);
  if (hit) return hit;
  const imported = await importFresh(key, alg, use);
  checkCryptoKey(imported, alg, use);
  cache.set(slot, imported);
  return imported;
}

async function importFresh(key: string | JsonWebKey, alg: JwtAlgorithm, use: "sign" | "verify"): Promise<CryptoKey> {
  const spec = ALGS[alg];
  if (typeof key === "string") {
    if (!isPem(key)) {
      if (alg !== "HS256") throw new KeyMismatch(`A plain string is an HMAC secret and cannot be used for ${alg}`);
      return crypto.subtle.importKey("raw", utf8(key), spec.importParams, false, [use]);
    }
    if (alg === "HS256") throw new KeyMismatch("A PEM key cannot be used as an HS256 secret");
    const { label, der } = parsePem(key);
    const format = label === "PUBLIC KEY" ? "spki" : "pkcs8";
    if (format === "spki" && use === "sign") throw new TypeError("signJwt needs a private key (PEM `PRIVATE KEY`), got a public key");
    if (format === "pkcs8" && use === "verify") throw new TypeError("verifyJwt needs a public key (PEM `PUBLIC KEY`), got a private key");
    try {
      return await crypto.subtle.importKey(format, der, spec.importParams, false, [use]);
    } catch {
      throw new KeyMismatch(`Key cannot be used for ${alg}`);
    }
  }
  const jwk = key as JsonWebKey & { kid?: string; use?: string };
  if (jwk.kty !== spec.kty || (spec.crv !== undefined && jwk.crv !== spec.crv)) {
    throw new KeyMismatch(`JWK (kty ${String(jwk.kty)}${jwk.crv ? ` ${jwk.crv}` : ""}) cannot be used for ${alg}`);
  }
  if (!jwkAlgAllows(jwk.alg, alg)) throw new KeyMismatch(`JWK is restricted to alg ${jwk.alg}`);
  const isPrivate = jwk.d !== undefined;
  if (alg !== "HS256") {
    if (use === "sign" && !isPrivate) throw new TypeError("signJwt needs a private key (JWK with `d`), got a public key");
    if (use === "verify" && isPrivate) throw new TypeError("verifyJwt needs a public key, got a private JWK (`d` present)");
  }
  // Strip members WebCrypto would cross-check against the import (we checked them above).
  const { alg: _a, use: _u, key_ops: _o, ext: _e, kid: _k, ...bare } = jwk as unknown as Record<string, unknown>;
  try {
    return await crypto.subtle.importKey("jwk", bare as unknown as JsonWebKey, spec.importParams, false, [use]);
  } catch {
    throw new KeyMismatch(`Key cannot be used for ${alg}`);
  }
}

function checkCryptoKey(key: CryptoKey, alg: JwtAlgorithm, use: "sign" | "verify"): void {
  const a = key.algorithm as CryptoKey["algorithm"] & { hash?: { name: string }; namedCurve?: string; modulusLength?: number };
  const ok =
    alg === "HS256"
      ? a.name === "HMAC" && a.hash?.name === "SHA-256"
      : alg === "RS256"
        ? a.name === "RSASSA-PKCS1-v1_5" && a.hash?.name === "SHA-256"
        : alg === "ES256"
          ? a.name === "ECDSA" && a.namedCurve === "P-256"
          : a.name === "Ed25519" || (a.name === "NODE-ED25519" && a.namedCurve === "NODE-ED25519");
  if (!ok) throw new KeyMismatch(`Key (${a.name}) cannot be used for ${alg}`);
  if (alg !== "HS256") {
    if (use === "verify" && key.type !== "public") throw new TypeError(`verifyJwt needs a public key, got a ${key.type} key`);
    if (use === "sign" && key.type !== "private") throw new TypeError(`signJwt needs a private key, got a ${key.type} key`);
  }
  if (alg === "RS256" && (a.modulusLength ?? 0) < MIN_RSA_BITS) {
    throw new KeyMismatch(`RSA keys must be at least ${MIN_RSA_BITS} bits (got ${a.modulusLength})`);
  }
}

function parsePem(pem: string): { label: "PUBLIC KEY" | "PRIVATE KEY"; der: Uint8Array<ArrayBuffer> } {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!m) throw new TypeError("Malformed PEM key");
  const label = m[1]!;
  if (label !== "PUBLIC KEY" && label !== "PRIVATE KEY") {
    throw new TypeError(
      `Unsupported PEM type "${label}": use SPKI ("PUBLIC KEY") or PKCS#8 ("PRIVATE KEY"), ` +
        "e.g. `openssl pkey -in key.pem -pubout` / `openssl pkcs8 -topk8 -nocrypt -in key.pem`",
    );
  }
  const der = fromBase64(m[2]!.replace(/\s+/g, ""));
  if (!der) throw new TypeError("Malformed PEM key");
  return { label, der };
}

function isCryptoKey(k: unknown): k is CryptoKey {
  return typeof CryptoKey !== "undefined" && k instanceof CryptoKey;
}

function isResolver(k: unknown): k is JwksResolver {
  return !!k && typeof k === "object" && typeof (k as JwksResolver).resolve === "function";
}

function isKeySet(k: unknown): k is JsonWebKeySet {
  return !!k && typeof k === "object" && !isCryptoKey(k) && Array.isArray((k as JsonWebKeySet).keys);
}

function invalid(message: string): HttpError {
  return new HttpError(401, message, { code: "invalid_token", headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
}

function encodeJson(v: unknown): string {
  return toBase64Url(utf8(JSON.stringify(v)));
}

function decodeJson(part: string): Record<string, any> | undefined {
  const bytes = fromBase64Url(part);
  if (!bytes) return undefined;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
