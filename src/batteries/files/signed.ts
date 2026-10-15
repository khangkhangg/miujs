import type { Middleware } from "../../core/app.ts";
import { problem } from "../../core/errors.ts";
import { fromBase64Url, hmacKey, timingSafeEqual, toBase64Url, utf8 } from "../auth/encoding.ts";
import { serveBlob, type ServeBlobOptions } from "./serve.ts";
import { assertSafeKey } from "./types.ts";
import type { BlobStoreRef } from "./upload.ts";

export interface SignBlobUrlOptions {
  /** HMAC secret, at least 32 characters. */
  secret: string;
  /** Lifetime in seconds. */
  expiresIn: number;
  /** HTTP method the link is valid for. Default "GET" (HEAD is accepted for GET links). */
  method?: string;
  /** Path prefix the blobs are served under. Default "/files". */
  basePath?: string;
  /** Current time in ms (tests). */
  now?: number;
}

export interface VerifySignedBlobUrlOptions {
  method?: string;
  basePath?: string;
}

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Signed blob URLs need a secret of at least 32 characters");
  let k = keys.get(secret);
  if (!k) {
    if (keys.size >= 16) keys.delete(keys.keys().next().value!);
    keys.set(secret, (k = hmacKey(secret)));
  }
  return k;
}

const normBase = (p = "/files") => "/" + p.replace(/^\/+|\/+$/g, "");
const payload = (method: string, key: string, exp: number) => utf8(`miu-blob-v1\n${method.toUpperCase()}\n${key}\n${exp}`);
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * A time-limited link to a blob: `/files/<key>?exp=<unix seconds>&sig=<base64url HMAC-SHA256>`.
 * The signature covers the method, the key and the expiry, so none can be altered.
 */
export async function signBlobUrl(key: string, opts: SignBlobUrlOptions): Promise<string> {
  assertSafeKey(key);
  if (!Number.isFinite(opts.expiresIn) || opts.expiresIn <= 0) throw new Error("expiresIn must be a positive number of seconds");
  const exp = Math.floor((opts.now ?? Date.now()) / 1000 + opts.expiresIn);
  const mac = await crypto.subtle.sign("HMAC", await keyFor(opts.secret), payload(opts.method ?? "GET", key, exp));
  return `${normBase(opts.basePath)}/${encodeKey(key)}?exp=${exp}&sig=${toBase64Url(new Uint8Array(mac))}`;
}

/** The key a signed URL grants (path or absolute URL), or undefined when expired, tampered or malformed. */
export async function verifySignedBlobUrl(
  url: string | URL,
  secret: string,
  now: number = Date.now(),
  opts: VerifySignedBlobUrlOptions = {},
): Promise<string | undefined> {
  const cryptoKey = keyFor(secret);
  let u: URL;
  try {
    u = new URL(url, "http://localhost");
  } catch {
    return undefined;
  }
  const base = normBase(opts.basePath) + "/";
  if (!u.pathname.startsWith(base)) return undefined;
  const exp = u.searchParams.get("exp");
  const sig = fromBase64Url(u.searchParams.get("sig") ?? "");
  if (!exp || !/^\d{1,12}$/.test(exp) || !sig || sig.length !== 32) return undefined;
  if (Number(exp) * 1000 <= now) return undefined;

  let key: string;
  try {
    const segs = u.pathname.slice(base.length).split("/").map((s) => decodeURIComponent(s));
    if (segs.some((s) => s.includes("/"))) return undefined;
    key = assertSafeKey(segs.join("/"));
  } catch {
    return undefined;
  }
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", await cryptoKey, payload(opts.method ?? "GET", key, Number(exp))));
  return timingSafeEqual(expected, sig) ? key : undefined;
}

export interface SignedBlobsOptions extends Pick<ServeBlobOptions, "allowActiveContent"> {
  store: BlobStoreRef;
  secret: string;
  /** Default "/files". */
  basePath?: string;
  /** Default `private, no-cache`: a signed link is a capability, so shared caches must not keep it. */
  cacheControl?: string;
}

/**
 * Serves `GET|HEAD <basePath>/<key>?exp=…&sig=…` from a store via {@link serveBlob}; anything under
 * `basePath` without a valid, unexpired signature gets 403. Other paths pass through.
 */
export function signedBlobs(opts: SignedBlobsOptions): Middleware {
  const base = normBase(opts.basePath) + "/";
  keyFor(opts.secret);
  return async (c, next) => {
    const method = c.req.method;
    if ((method !== "GET" && method !== "HEAD") || !c.url.pathname.startsWith(base)) return next();
    const key = await verifySignedBlobUrl(c.url, opts.secret, Date.now(), { basePath: opts.basePath });
    if (!key) {
      return problem(403, { code: "invalid_signature", detail: "This file link is invalid or has expired" }, { "referrer-policy": "no-referrer" });
    }
    const store = typeof opts.store === "function" ? opts.store(c) : opts.store;
    const res = await serveBlob(c, store, key, { cacheControl: opts.cacheControl ?? "private, no-cache", allowActiveContent: opts.allowActiveContent });
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  };
}
