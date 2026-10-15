import { assertSafeKey, etagOf, toBytes, type BlobMeta, type BlobStore } from "./types.ts";

/** In-process blob store for development and tests. */
export function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, { meta: BlobMeta; bytes: Uint8Array }>();
  const stream = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

  return {
    async put(key, body, opts = {}) {
      assertSafeKey(key);
      const bytes = (await toBytes(body)).slice();
      const meta: BlobMeta = {
        key,
        size: bytes.byteLength,
        contentType: opts.contentType ?? "application/octet-stream",
        etag: await etagOf(bytes),
        uploadedAt: new Date().toISOString(),
        ...(opts.metadata ? { metadata: { ...opts.metadata } } : {}),
      };
      blobs.set(key, { meta, bytes });
      return structuredClone(meta);
    },
    async get(key, opts = {}) {
      const b = blobs.get(key);
      if (!b) return undefined;
      let bytes = b.bytes;
      if (opts.range) {
        const start = Math.max(0, opts.range.offset);
        const end = opts.range.length === undefined ? bytes.length : start + opts.range.length;
        bytes = bytes.subarray(start, end);
      }
      return { meta: structuredClone(b.meta), body: stream(bytes) };
    },
    async head(key) {
      const b = blobs.get(key);
      return b && structuredClone(b.meta);
    },
    async delete(key) {
      return blobs.delete(key);
    },
    async list(prefix = "", opts = {}) {
      const keys = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = opts.cursor ? keys.findIndex((k) => k > opts.cursor!) : 0;
      if (start < 0) return { items: [] };
      const limit = Math.min(Math.max(1, opts.limit ?? 1000), 1000);
      const page = keys.slice(start, start + limit);
      const more = start + limit < keys.length;
      return { items: page.map((k) => structuredClone(blobs.get(k)!.meta)), ...(more ? { cursor: page.at(-1) } : {}) };
    },
  };
}
