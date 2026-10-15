import { assertSafeKey, toBytes, type BlobMeta, type BlobStore } from "../../batteries/files/types.ts";
import { resolveBinding, type BindingRef, type R2Bucket, type R2Object } from "./types.ts";

function toMeta(o: R2Object): BlobMeta {
  const custom = o.customMetadata && Object.keys(o.customMetadata).length ? { metadata: { ...o.customMetadata } } : {};
  return {
    key: o.key,
    size: o.size,
    contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
    etag: o.etag,
    uploadedAt: o.uploaded.toISOString(),
    ...custom,
  };
}

/**
 * {@link BlobStore} over a Cloudflare R2 bucket (or a getter such as `() => env.FILES`), so uploads,
 * `serveBlob` and signed links work the same on Workers as on disk. The etag is R2's own.
 */
export function r2BlobStore(bucket: BindingRef<R2Bucket>): BlobStore {
  const b = () => resolveBinding(bucket);
  return {
    async put(key, body, o = {}) {
      assertSafeKey(key);
      // R2 only accepts streams of known length (FixedLengthStream); buffer arbitrary streams.
      const value = body instanceof ReadableStream ? await toBytes(body) : body;
      const obj = await b().put(key, value, {
        httpMetadata: { contentType: o.contentType ?? "application/octet-stream" },
        ...(o.metadata ? { customMetadata: { ...o.metadata } } : {}),
      });
      if (!obj) throw new Error(`R2 put of ${JSON.stringify(key)} returned no object`);
      return toMeta(obj);
    },
    async get(key, o = {}) {
      assertSafeKey(key);
      const r = o.range;
      const obj = await b().get(key, r ? { range: r.length === undefined ? { offset: r.offset } : { offset: r.offset, length: r.length } } : undefined);
      if (!obj || !("body" in obj)) return undefined;
      return { meta: toMeta(obj), body: obj.body as ReadableStream<Uint8Array> };
    },
    async head(key) {
      assertSafeKey(key);
      const obj = await b().head(key);
      return obj ? toMeta(obj) : undefined;
    },
    async delete(key) {
      assertSafeKey(key);
      if (!(await b().head(key))) return false;
      await b().delete(key);
      return true;
    },
    async list(prefix = "", o = {}) {
      const limit = Math.min(Math.max(1, o.limit ?? 1000), 1000);
      const res = await b().list({ prefix, cursor: o.cursor, limit, include: ["httpMetadata", "customMetadata"] });
      return { items: res.objects.map(toMeta), ...(res.truncated && res.cursor ? { cursor: res.cursor } : {}) };
    },
  };
}
