import { filesErrors } from "./errors.ts";
import { DEFAULT_TYPE, randomHex, type FileStore, type ListOptions, type ListResult, type StoredFile, type UploadedPart } from "./store.ts";
import { collect, concat } from "./stream.ts";

interface Entry {
  info: StoredFile;
  bytes: Uint8Array;
}

interface Upload {
  key: string;
  created: number;
  contentType: string;
  metadata: Record<string, string>;
  parts: Map<number, { etag: string; bytes: Uint8Array }>;
}

/** Sorted keys → one page. Shared by the stores that list by scanning (memory, local). */
export function pageOf(keys: string[], opts: ListOptions = {}): { keys: string[]; cursor?: string } {
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
  const prefix = opts.prefix ?? "";
  const after = opts.cursor;
  const matching = keys.filter((k) => k.startsWith(prefix) && (after === undefined || k > after)).sort();
  const page = matching.slice(0, limit);
  return { keys: page, cursor: matching.length > limit ? page[page.length - 1] : undefined };
}

export function copyInfo(i: StoredFile): StoredFile {
  return { ...i, metadata: { ...i.metadata }, uploaded: new Date(i.uploaded) };
}

// Copied out in chunks as the reader pulls: consumers cannot mutate the stored bytes, and a slow or
// abandoned download of a big file holds one chunk, not a full copy.
const COPY_CHUNK = 256 * 1024;

export function bytesStream(b: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= b.byteLength) return c.close();
      const end = Math.min(b.byteLength, at + COPY_CHUNK);
      c.enqueue(b.slice(at, end));
      at = end;
      if (at >= b.byteLength) c.close();
    },
  });
}

export interface MemoryStoreOptions {
  /** Most unfinished multipart uploads kept; starting another drops the oldest. Default 1000. */
  maxPendingUploads?: number;
  /** Unfinished multipart uploads older than this are dropped. Default 7 days (the longest upload id lifetime). */
  uploadTtlMs?: number;
}

/**
 * Files in process memory. The development default: nothing survives a restart and every
 * process has its own copy. Multipart uploads are emulated; abandoned ones (never completed or
 * aborted) are dropped after `uploadTtlMs` or once more than `maxPendingUploads` are open.
 */
export function memoryStore(opts: MemoryStoreOptions = {}): FileStore {
  const maxPending = opts.maxPendingUploads ?? 1000;
  const ttl = opts.uploadTtlMs ?? 7 * 24 * 3600 * 1000;
  const objects = new Map<string, Entry>();
  const uploads = new Map<string, Upload>();

  /** Drop expired uploads, then the oldest while over the cap (Map order is creation order). */
  const sweep = (now: number) => {
    for (const [id, u] of uploads) {
      if (uploads.size < maxPending && now - u.created < ttl) break;
      uploads.delete(id);
    }
  };

  const upload = (key: string, id: string): Upload => {
    const u = uploads.get(id);
    if (u && Date.now() - u.created >= ttl) uploads.delete(id);
    if (!u || u.key !== key || !uploads.has(id)) throw filesErrors.uploadNotFound();
    return u;
  };

  const store = (key: string, bytes: Uint8Array, contentType?: string, metadata?: Record<string, string>): StoredFile => {
    const info: StoredFile = { key, size: bytes.byteLength, etag: randomHex(), contentType: contentType || DEFAULT_TYPE, metadata: { ...metadata }, uploaded: new Date() };
    objects.set(key, { info, bytes });
    return copyInfo(info);
  };

  return {
    kind: "memory",
    async put(key, body, opts = {}) {
      // Read fully before touching the map: a failing stream leaves the old version in place.
      const bytes = await collect(body);
      return store(key, bytes, opts.contentType, opts.metadata);
    },
    async get(key, opts = {}) {
      const e = objects.get(key);
      if (!e) return null;
      const r = opts.range;
      if (!r) return { ...copyInfo(e.info), body: bytesStream(e.bytes) };
      const offset = Math.min(r.offset, e.bytes.byteLength);
      const end = Math.min(offset + r.length, e.bytes.byteLength);
      return { ...copyInfo(e.info), body: bytesStream(e.bytes.subarray(offset, end)), range: { offset, length: end - offset } };
    },
    async head(key) {
      const e = objects.get(key);
      return e ? copyInfo(e.info) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(opts): Promise<ListResult> {
      const page = pageOf([...objects.keys()], opts);
      return { files: page.keys.map((k) => copyInfo(objects.get(k)!.info)), cursor: page.cursor };
    },
    async createMultipart(key, opts = {}) {
      const id = randomHex();
      const now = Date.now();
      sweep(now);
      uploads.set(id, { key, created: now, contentType: opts.contentType || DEFAULT_TYPE, metadata: { ...opts.metadata }, parts: new Map() });
      return id;
    },
    async uploadPart(key, id, partNumber, body): Promise<UploadedPart> {
      upload(key, id);
      const bytes = await collect(body);
      const u = upload(key, id); // still there after the body was read?
      const etag = randomHex();
      u.parts.set(partNumber, { etag, bytes });
      return { partNumber, etag };
    },
    async completeMultipart(key, id, parts) {
      const u = upload(key, id);
      const chunks: Uint8Array[] = [];
      for (const p of parts) {
        const got = u.parts.get(p.partNumber);
        if (!got || got.etag !== p.etag) throw filesErrors.partInvalid(p.partNumber);
        chunks.push(got.bytes);
      }
      uploads.delete(id);
      return store(key, concat(chunks), u.contentType, u.metadata);
    },
    async abortMultipart(key, id) {
      if (uploads.get(id)?.key === key) uploads.delete(id);
    },
    inspect: () => ({ objects: objects.size }),
  };
}
