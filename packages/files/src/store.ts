import type { Env } from "miujs";

/** What a store knows about an object. `size` is always the full object size. */
export interface StoredFile {
  key: string;
  size: number;
  /** Opaque, unquoted. Changes whenever the object is rewritten. */
  etag: string;
  contentType: string;
  metadata: Record<string, string>;
  uploaded: Date;
}

/** A byte range: `length` bytes starting at `offset`. */
export interface ByteRange {
  offset: number;
  length: number;
}

export interface FileObject extends StoredFile {
  body: ReadableStream<Uint8Array>;
  /** Present when only a range was read. */
  range?: ByteRange;
}

export interface StorePutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  /** Exact byte length when known (lets R2 stream instead of buffering). */
  size?: number;
}

export interface ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface ListResult {
  files: StoredFile[];
  /** Pass to the next `list` call; absent on the last page. */
  cursor?: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * A file backend: memory, local disk, Cloudflare R2, or your own. Keys arrive already
 * validated. Writes must be all-or-nothing: if the body stream errors, nothing is stored.
 */
export interface FileStore {
  /** Shown in `miu inspect`: "memory", "local", "r2", ... */
  readonly kind: string;
  put(key: string, body: ReadableStream<Uint8Array>, opts?: StorePutOptions): Promise<StoredFile>;
  get(key: string, opts?: { range?: ByteRange }): Promise<FileObject | null>;
  head(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
  /** Keys in ascending order. */
  list(opts?: ListOptions): Promise<ListResult>;

  /** Start a multipart upload; returns the store's upload id. */
  createMultipart(key: string, opts?: StorePutOptions): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>, size?: number): Promise<UploadedPart>;
  /** Join the parts, in the order given, into the object at `key`. */
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<StoredFile>;
  abortMultipart(key: string, uploadId: string): Promise<void>;

  /** Stores bound per request (R2 by binding name) return the concrete store for this env. */
  forEnv?(env: Env): FileStore;
  /** Extra details for `miu inspect`. Never secrets. */
  inspect?(): Record<string, unknown>;
}

export const DEFAULT_TYPE = "application/octet-stream";

/** Random lowercase hex, `bytes` long. */
export function randomHex(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
