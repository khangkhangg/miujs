import { HttpError } from "../../core/errors.ts";
import { fromBase64Url, hmacKey, toBase64Url, utf8 } from "./encoding.ts";

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

export interface SignJwtOptions {
  /** Seconds until expiry (sets `exp`). */
  expiresIn?: number;
  issuer?: string;
  audience?: string | string[];
  /** Clock in milliseconds; defaults to Date.now. */
  now?: () => number;
}

export interface VerifyJwtOptions {
  issuer?: string;
  /** Accept tokens whose `aud` contains this (or any of these) audience(s). */
  audience?: string | string[];
  /** Clock skew tolerance in seconds for `exp` and `nbf`. Default 5. */
  leeway?: number;
  now?: () => number;
}

const HEADER = toBase64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));

/** Sign a JWT with HS256. Adds `iat`, and `exp`/`iss`/`aud` when given. */
export async function signJwt(payload: JwtPayload, secret: string, opts: SignJwtOptions = {}): Promise<string> {
  const iat = Math.floor((opts.now ?? Date.now)() / 1000);
  const claims: JwtPayload = { iat, ...payload };
  if (opts.expiresIn !== undefined) claims.exp = iat + opts.expiresIn;
  if (opts.issuer !== undefined) claims.iss = opts.issuer;
  if (opts.audience !== undefined) claims.aud = opts.audience;
  const input = `${HEADER}.${toBase64Url(utf8(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), utf8(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verify an HS256 JWT and return its payload. Only HS256 is accepted (never `none`).
 * Throws `HttpError(401, ..., { code: "invalid_token" })` on any failure.
 */
export async function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  secret: string,
  opts: VerifyJwtOptions = {},
): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid("Malformed token");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  if (!header || header.alg !== "HS256") throw invalid("Unsupported alg; expected HS256");
  const sig = fromBase64Url(s);
  const key = await hmacKey(secret, ["verify"]);
  if (!sig || !(await crypto.subtle.verify("HMAC", key, sig, utf8(`${h}.${p}`)))) throw invalid("Invalid signature");
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

function invalid(message: string): HttpError {
  return new HttpError(401, message, { code: "invalid_token", headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
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
