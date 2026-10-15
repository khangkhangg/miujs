// An in-memory stand-in for Cloudflare's R2Bucket, implementing the documented methods
// r2Store uses (put/get/head/delete/list/createMultipartUpload/resumeMultipartUpload) with the
// same shapes. Like real R2, `put` refuses a ReadableStream of unknown length.

const enc = new TextEncoder();
const KNOWN_LENGTH = Symbol("knownLength");

/** Stand-in for Workers' FixedLengthStream: its readable side counts as "known length". */
export class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0;
    super({
      transform(chunk, c) {
        seen += chunk.byteLength;
        if (seen > length) throw new Error("FixedLengthStream: too many bytes");
        c.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw new Error("FixedLengthStream: too few bytes");
      },
    });
    (this.readable as any)[KNOWN_LENGTH] = length;
  }
}

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === "string") return enc.encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) {
    if ((value as any)[KNOWN_LENGTH] === undefined) {
      throw new TypeError("Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)");
    }
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  throw new TypeError("unsupported R2 value");
}

interface Obj {
  key: string;
  bytes: Uint8Array;
  etag: string;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  uploaded: Date;
}

let n = 0;
const etag = () => (++n).toString(16).padStart(32, "0");

function r2Object(o: Obj, include = true) {
  return {
    key: o.key,
    version: o.etag,
    size: o.bytes.byteLength,
    etag: o.etag,
    httpEtag: `"${o.etag}"`,
    uploaded: o.uploaded,
    httpMetadata: include ? { ...o.httpMetadata } : undefined,
    customMetadata: include ? { ...o.customMetadata } : undefined,
  };
}

export function fakeR2() {
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, { key: string; opts: any; parts: Map<number, { etag: string; bytes: Uint8Array }> }>();
  const calls: string[] = [];

  const multipart = (key: string, uploadId: string) => ({
    key,
    uploadId,
    async uploadPart(partNumber: number, value: unknown) {
      calls.push(`uploadPart:${partNumber}`);
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("uploadPart: The specified multipart upload does not exist. (10024)");
      const bytes = await bytesOf(value);
      const e = etag();
      u.parts.set(partNumber, { etag: e, bytes });
      return { partNumber, etag: e };
    },
    async abort() {
      uploads.delete(uploadId);
    },
    async complete(parts: { partNumber: number; etag: string }[]) {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("complete: The specified multipart upload does not exist. (10024)");
      const chunks: Uint8Array[] = [];
      for (const p of parts) {
        const got = u.parts.get(p.partNumber);
        if (!got || got.etag !== p.etag) throw new Error("complete: One or more of the specified parts could not be found. (10025)");
        chunks.push(got.bytes);
      }
      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      uploads.delete(uploadId);
      const o: Obj = { key, bytes, etag: etag(), httpMetadata: { ...u.opts?.httpMetadata }, customMetadata: { ...u.opts?.customMetadata }, uploaded: new Date() };
      objects.set(key, o);
      return r2Object(o);
    },
  });

  return {
    calls,
    objects,
    async put(key: string, value: unknown, opts: any = {}) {
      calls.push(`put:${key}`);
      const bytes = await bytesOf(value);
      const o: Obj = { key, bytes, etag: etag(), httpMetadata: { ...opts.httpMetadata }, customMetadata: { ...opts.customMetadata }, uploaded: new Date() };
      objects.set(key, o);
      return r2Object(o);
    },
    async get(key: string, opts: any = {}) {
      calls.push(`get:${key}`);
      const o = objects.get(key);
      if (!o) return null;
      let bytes = o.bytes;
      let range: { offset: number; length: number } | undefined;
      if (opts.range) {
        const offset = opts.range.offset ?? 0;
        const length = opts.range.length ?? bytes.byteLength - offset;
        bytes = bytes.slice(offset, offset + length);
        range = { offset, length: bytes.byteLength };
      }
      const copy = bytes.slice();
      return {
        ...r2Object(o),
        range,
        body: new ReadableStream({
          start(c) {
            if (copy.byteLength) c.enqueue(copy);
            c.close();
          },
        }),
        bodyUsed: false,
        arrayBuffer: async () => copy.buffer,
      };
    },
    async head(key: string) {
      calls.push(`head:${key}`);
      const o = objects.get(key);
      return o ? r2Object(o) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of ([] as string[]).concat(keys)) objects.delete(k);
    },
    async list(opts: any = {}) {
      calls.push(`list:${JSON.stringify(opts)}`);
      const include = Array.isArray(opts.include) && opts.include.includes("httpMetadata");
      const limit = opts.limit ?? 1000;
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      const start = opts.cursor ? Number(atob(opts.cursor)) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((k) => r2Object(objects.get(k)!, include)), truncated, cursor: truncated ? btoa(String(start + limit)) : undefined, delimitedPrefixes: [] };
    },
    async createMultipartUpload(key: string, opts: any = {}) {
      const id = `up-${etag()}`;
      uploads.set(id, { key, opts, parts: new Map() });
      return multipart(key, id);
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return multipart(key, uploadId);
    },
  };
}
