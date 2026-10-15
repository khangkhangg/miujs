import type { Env } from "miujs";
import { filesErrors } from "./errors.ts";
import { DEFAULT_TYPE, type FileStore, type StoredFile, type UploadedPart } from "./store.ts";
import { collect } from "./stream.ts";

// The parts of Cloudflare's R2 API this store uses. A real `R2Bucket` binding satisfies them.

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  range?: { offset?: number; length?: number; suffix?: number };
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
}

type R2Value = ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string | Blob | null;

export interface R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: R2Value): Promise<{ partNumber: number; etag: string }>;
  abort(): Promise<void>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<R2ObjectLike>;
}

export interface R2BucketLike {
  put(key: string, value: R2Value, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<R2ObjectLike | null>;
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number; include?: ("httpMetadata" | "customMetadata")[] }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
}

export function isR2Bucket(v: unknown): v is R2BucketLike {
  const o = v as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && typeof o.put === "function" && typeof o.get === "function" && typeof o.head === "function" && typeof o.createMultipartUpload === "function";
}

function info(o: R2ObjectLike): StoredFile {
  return { key: o.key, size: o.size, etag: o.etag, contentType: o.httpMetadata?.contentType || DEFAULT_TYPE, metadata: { ...o.customMetadata }, uploaded: new Date(o.uploaded) };
}

/**
 * R2 needs a stream of known length. On Workers, pipe through `FixedLengthStream` when the size is
 * known (no buffering, and R2 rejects a body whose length differs). Otherwise buffer it; callers
 * have already bounded the size with `limitStream`.
 */
async function r2Body(body: ReadableStream<Uint8Array>, size: number | undefined): Promise<R2Value> {
  const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (FLS && size !== undefined) return body.pipeThrough(new FLS(size));
  return collect(body);
}

/** R2 reports multipart problems as Errors with numeric codes in the message. */
function mapMultipartError(err: unknown, partNumber?: number): unknown {
  const msg = String((err as Error)?.message ?? err);
  if (msg.includes("10024")) return filesErrors.uploadNotFound();
  if (msg.includes("10025")) return filesErrors.partInvalid(partNumber ?? "?");
  return err;
}

function bucketStore(bucket: R2BucketLike, binding?: string): FileStore {
  const meta = (o?: { contentType?: string; metadata?: Record<string, string> }) => ({
    httpMetadata: o?.contentType ? { contentType: o.contentType } : {},
    customMetadata: { ...o?.metadata },
  });
  return {
    kind: "r2",
    async put(key, body, opts = {}) {
      const o = await bucket.put(key, await r2Body(body, opts.size), meta(opts));
      return info(o ?? (await bucket.head(key))!);
    },
    async get(key, opts = {}) {
      const o = await bucket.get(key, opts.range ? { range: opts.range } : undefined);
      if (!o) return null;
      const out = { ...info(o), body: o.body };
      if (!opts.range) return out;
      const offset = o.range?.offset ?? opts.range.offset;
      const length = o.range?.length ?? Math.max(0, Math.min(opts.range.length, o.size - offset));
      return { ...out, range: { offset, length } };
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? info(o) : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(opts = {}) {
      const r = await bucket.list({ prefix: opts.prefix, cursor: opts.cursor, limit: opts.limit ?? 1000, include: ["httpMetadata", "customMetadata"] });
      return { files: r.objects.map(info), cursor: r.truncated ? r.cursor : undefined };
    },
    async createMultipart(key, opts = {}) {
      return (await bucket.createMultipartUpload(key, meta(opts))).uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body, size): Promise<UploadedPart> {
      try {
        const p = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, await r2Body(body, size));
        return { partNumber: p.partNumber, etag: p.etag };
      } catch (err) {
        throw mapMultipartError(err, partNumber);
      }
    },
    async completeMultipart(key, uploadId, parts) {
      try {
        return info(await bucket.resumeMultipartUpload(key, uploadId).complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))));
      } catch (err) {
        throw mapMultipartError(err);
      }
    },
    async abortMultipart(key, uploadId) {
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
      } catch (err) {
        const mapped = mapMultipartError(err);
        if ((mapped as { code?: string })?.code !== "MIU_E_FILES_UPLOAD_NOT_FOUND") throw mapped;
      }
    },
    inspect: () => (binding ? { binding } : {}),
  };
}

/**
 * Cloudflare R2. Pass the bucket binding itself, or its name to look it up in `ctx.env` on each
 * request: `files({ store: r2Store("FILES") })`. Multipart uploads use R2's native multipart API.
 */
export function r2Store(binding: R2BucketLike | string): FileStore {
  if (typeof binding !== "string") return bucketStore(binding);
  const name = binding;
  const byBucket = new WeakMap<object, FileStore>();
  const unbound = (): Promise<never> => Promise.reject(filesErrors.binding(name));
  return {
    kind: "r2",
    put: unbound,
    get: unbound,
    head: unbound,
    delete: unbound,
    list: unbound,
    createMultipart: unbound,
    uploadPart: unbound,
    completeMultipart: unbound,
    abortMultipart: unbound,
    forEnv(env: Env) {
      const bucket = env[name];
      if (!isR2Bucket(bucket)) throw filesErrors.binding(name);
      let s = byBucket.get(bucket);
      if (!s) byBucket.set(bucket, (s = bucketStore(bucket, name)));
      return s;
    },
    inspect: () => ({ binding: name }),
  };
}
