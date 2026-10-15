import type { Context } from "miujs";
import { filesErrors } from "./errors.ts";
import { checkKey } from "./keys.ts";
import type { FileObject, FileStore, ListResult, StoredFile } from "./store.ts";
import { knownSize, toStream, type FileBody } from "./stream.ts";
import { signToken, type TokenPayload } from "./token.ts";
import { handleUpload, type HandleUploadOptions, type UploadedFile } from "./upload.ts";

export interface PutOptions {
  contentType?: string;
  /** Small string key/values stored with the file (R2 customMetadata). Max 2 KB in total. */
  metadata?: Record<string, string>;
}

export interface GetOptions {
  /** Read only part of the file. `length` defaults to the rest of it. */
  range?: { offset: number; length?: number };
}

export interface SignedUrlOptions {
  /** Seconds until the URL stops working. Default 900 (15 minutes), max 7 days. */
  expiresIn?: number;
  /**
   * When the URL stops working: a Date or whole seconds since the epoch (at most 7 days ahead).
   * Instead of `expiresIn`; the same key, options and expiresAt always give the same URL.
   */
  expiresAt?: Date | number;
  /**
   * GET only. "public" serves the file with `Cache-Control: public`, so browsers and CDNs may
   * cache it. Without `expiresAt`, the expiry is rounded up to the hour so repeated calls give
   * the same (cacheable) URL. Default "private".
   */
  cache?: "private" | "public";
  /** "GET" to download (default), "PUT" to let a client upload to this exact key. */
  method?: "GET" | "PUT";
  /** PUT only: the upload must be sent with this content type. */
  contentType?: string;
  /** PUT only: maximum upload size in bytes. Default: the plugin's `maxUploadSize`. */
  maxSize?: number;
  /** GET only: serve as an attachment with this file name. */
  download?: string;
}

export interface SignedPrefixOptions {
  expiresIn?: number;
  expiresAt?: Date | number;
  cache?: "private" | "public";
}

/** `ctx.files`. */
export interface FilesClient {
  put(key: string, body: FileBody, opts?: PutOptions): Promise<StoredFile>;
  /** The file and a stream of its bytes, or `null` when it does not exist. */
  get(key: string, opts?: GetOptions): Promise<FileObject | null>;
  head(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<ListResult>;
  /** A URL to this plugin's own route that grants one method on one key until it expires. */
  signedUrl(key: string, opts?: SignedUrlOptions): Promise<string>;
  /**
   * One signed base URL for every file under `prefix` (tile pyramids, video segments): GET
   * `${base}/<rest of the key>`. Read-only, and nothing outside the prefix.
   */
  signedPrefixUrl(prefix: string, opts?: SignedPrefixOptions): Promise<string>;
  /**
   * Store the file(s) from this request (multipart/form-data or a raw body) after checking their
   * real type from their bytes. Use on routes without a `body` schema.
   */
  handleUpload(ctx: Context, opts: HandleUploadOptions): Promise<UploadedFile[]>;
}

/** How the plugin is configured, shared by every request's client and the routes. */
export interface FilesRuntime {
  basePath: string;
  publicUrl?: string;
  maxUploadSize: number;
  storeFor(env: Context["env"]): FileStore;
  secretsFor(ctx: Context): string[];
}

export const MAX_EXPIRES_IN = 7 * 86400;
const MAX_METADATA_BYTES = 2048;

const configError = (message: string, fix: string) => filesErrors.config("CONFIG", message, fix);

export function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

export function checkContentType(t: unknown): string | undefined {
  if (t === undefined) return undefined;
  if (typeof t !== "string" || t.length > 255 || /[\u0000-\u001f\u007f]/.test(t)) {
    throw configError(`Invalid contentType ${JSON.stringify(t)}`, 'Pass a media type such as "image/png" (no line breaks, max 255 chars).');
  }
  return t || undefined;
}

function checkMetadata(m: unknown): Record<string, string> | undefined {
  if (m === undefined) return undefined;
  if (typeof m !== "object" || m === null || Array.isArray(m) || Object.values(m).some((v) => typeof v !== "string")) {
    throw configError("File metadata must be an object of string values", "Pass e.g. { metadata: { owner: user.id } }; convert numbers and dates to strings.");
  }
  if (new TextEncoder().encode(JSON.stringify(m)).length > MAX_METADATA_BYTES) {
    throw configError("File metadata is larger than 2 KB", "Keep metadata small (ids, names); store larger data in your database.");
  }
  return m as Record<string, string>;
}

function checkCache(cache: unknown): boolean {
  if (cache === undefined || cache === "private") return false;
  if (cache === "public") return true;
  throw configError(`cache must be "private" or "public", got ${JSON.stringify(cache)}`, 'Pass cache: "public" for files anyone may cache, or leave it out.');
}

/** Expiry in seconds since the epoch, from expiresAt or expiresIn (rounded up to the hour for public URLs). */
function expiryOf(opts: { expiresIn?: number; expiresAt?: Date | number }, publicCache: boolean): number {
  const now = Math.floor(Date.now() / 1000);
  if (opts.expiresAt !== undefined) {
    if (opts.expiresIn !== undefined) throw configError("Pass expiresIn or expiresAt, not both", "Use expiresAt for a fixed expiry (stable URLs), or expiresIn for a relative one.");
    const at = opts.expiresAt instanceof Date ? Math.floor(opts.expiresAt.getTime() / 1000) : opts.expiresAt;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= now || at - now > MAX_EXPIRES_IN) {
      throw configError(`expiresAt must be a Date or whole seconds since the epoch within the next ${MAX_EXPIRES_IN} seconds, got ${String(opts.expiresAt)}`, "Signed URLs are bearer credentials: keep them short-lived (max 7 days).");
    }
    return at;
  }
  const expiresIn = opts.expiresIn ?? 900;
  if (!isPositiveInt(expiresIn) || expiresIn > MAX_EXPIRES_IN) {
    throw configError(`expiresIn must be a whole number of seconds from 1 to ${MAX_EXPIRES_IN}, got ${String(expiresIn)}`, "Signed URLs are bearer credentials: keep them short-lived (default 900 = 15 minutes, max 7 days).");
  }
  const e = now + expiresIn;
  if (!publicCache) return e;
  const rounded = Math.ceil(e / 3600) * 3600;
  return rounded - now <= MAX_EXPIRES_IN ? rounded : e;
}

export class Files implements FilesClient {
  declare private ctx: Context;
  declare private rt: FilesRuntime;

  constructor(ctx: Context, rt: FilesRuntime) {
    this.ctx = ctx;
    this.rt = rt;
  }

  private store(): FileStore {
    return this.rt.storeFor(this.ctx.env);
  }

  async put(key: string, body: FileBody, opts: PutOptions = {}): Promise<StoredFile> {
    checkKey(key);
    const contentType = checkContentType(opts.contentType);
    const metadata = checkMetadata(opts.metadata);
    return this.store().put(key, toStream(body), { contentType, metadata, size: knownSize(body) });
  }

  async get(key: string, opts: GetOptions = {}): Promise<FileObject | null> {
    checkKey(key);
    const r = opts.range;
    if (!r) return this.store().get(key);
    if (!Number.isSafeInteger(r.offset) || r.offset < 0 || (r.length !== undefined && !isPositiveInt(r.length))) {
      throw configError(`Invalid range ${JSON.stringify(r)}`, "Pass { offset: n >= 0, length?: n > 0 } in bytes.");
    }
    let length = r.length;
    if (length === undefined) {
      const info = await this.store().head(key);
      if (!info) return null;
      length = Math.max(0, info.size - r.offset);
    }
    return this.store().get(key, { range: { offset: r.offset, length } });
  }

  async head(key: string): Promise<StoredFile | null> {
    checkKey(key);
    return this.store().head(key);
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    await this.store().delete(key);
  }

  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<ListResult> {
    if (opts.limit !== undefined && (!isPositiveInt(opts.limit) || opts.limit > 1000)) {
      throw configError(`list limit must be an integer from 1 to 1000, got ${String(opts.limit)}`, "Pass { limit: 100 } or omit it (default 1000).");
    }
    return this.store().list(opts);
  }

  async signedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    checkKey(key);
    const method = opts.method ?? "GET";
    if (method !== "GET" && method !== "PUT") throw configError(`signedUrl method must be "GET" or "PUT", got ${JSON.stringify(method)}`, 'Use method: "GET" to download or "PUT" to upload.');
    const publicCache = checkCache(opts.cache);
    if (publicCache && method !== "GET") throw configError("cache only applies to GET URLs", "Remove `cache`, or sign a GET URL.");
    const payload: TokenPayload = { p: "url", k: key, m: method, e: expiryOf(opts, publicCache) };
    if (publicCache) payload.c = 1;
    if (method === "GET") {
      if (opts.contentType !== undefined || opts.maxSize !== undefined) throw configError("contentType and maxSize only apply to PUT URLs", 'Pass method: "PUT" to sign an upload URL.');
      if (opts.download !== undefined) {
        if (typeof opts.download !== "string") throw configError("download must be a file name", 'Pass e.g. download: "report.pdf".');
        payload.d = opts.download;
      }
    } else {
      if (opts.download !== undefined) throw configError("download only applies to GET URLs", "Remove `download`, or sign a GET URL.");
      const ct = checkContentType(opts.contentType);
      if (ct) payload.ct = ct;
      if (opts.maxSize !== undefined) {
        if (!isPositiveInt(opts.maxSize)) throw configError(`maxSize must be a positive whole number of bytes, got ${String(opts.maxSize)}`, "Pass e.g. maxSize: 10 * 1024 * 1024 for 10 MB.");
        payload.ms = opts.maxSize;
      }
    }
    const token = await signToken(this.rt.secretsFor(this.ctx), payload);
    return `${this.origin()}${this.rt.basePath}/${token}`;
  }

  async signedPrefixUrl(prefix: string, opts: SignedPrefixOptions = {}): Promise<string> {
    checkKey(prefix);
    const publicCache = checkCache(opts.cache);
    const payload: TokenPayload = { p: "pre", k: prefix, e: expiryOf(opts, publicCache) };
    if (publicCache) payload.c = 1;
    const token = await signToken(this.rt.secretsFor(this.ctx), payload);
    return `${this.origin()}${this.rt.basePath}/p/${token}`;
  }

  /** publicUrl, else the request's origin; "" (relative URLs) outside a request. */
  private origin(): string {
    if (this.rt.publicUrl) return this.rt.publicUrl;
    const url = (this.ctx as { url?: URL }).url;
    return url ? url.origin : "";
  }

  handleUpload(ctx: Context, opts: HandleUploadOptions): Promise<UploadedFile[]> {
    return handleUpload(ctx, this.store(), opts);
  }
}
