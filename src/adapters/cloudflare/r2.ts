import type { Context } from "../../core/context.ts";
import { HttpError, problem } from "../../core/errors.ts";
import {
  resolveBinding,
  type BindingRef,
  type R2Bucket,
  type R2Object,
  type R2ObjectBody,
  type R2Objects,
  type R2Range,
} from "./types.ts";

export interface R2PutFileOptions {
  contentType?: string;
  cacheControl?: string;
  /** Custom string metadata stored with the object. */
  metadata?: Record<string, string>;
}

export interface ServeOptions {
  /** `Cache-Control` header. Default: the object's own, else `no-cache` (always revalidate via ETag). */
  cacheControl?: string;
}

export interface R2Files {
  put(key: string, body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, opts?: R2PutFileOptions): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
  /** One page of objects under `prefix`; continue with the returned `cursor` while `truncated`. */
  list(prefix?: string, opts?: { cursor?: string; limit?: number }): Promise<R2Objects>;
  /** Respond with an object: `ETag`/`If-None-Match` (304), single `Range` requests (206/416), 404 when missing. */
  serve(c: Context<any, any>, key: string, opts?: ServeOptions): Promise<Response>;
}

/** Parse a single `bytes=` range. Multi-range and malformed headers are ignored (full response). */
function parseRange(header: string | null): R2Range | undefined {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const end = Number(m[2]);
  return end < offset ? undefined : { offset, length: end - offset + 1 };
}

/** First entity tag of an `If-None-Match` header, unquoted, ignoring the weak prefix. */
function parseEtag(header: string | null): string | undefined {
  const first = header?.split(",")[0]?.trim();
  if (!first || first === "*") return undefined;
  return first.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

/** Helpers over an R2 bucket (or a getter such as `() => env.FILES`). */
export function r2Files(bucket: BindingRef<R2Bucket>): R2Files {
  const b = () => resolveBinding(bucket);
  return {
    put(key, body, o = {}) {
      return b().put(key, body, {
        httpMetadata: { contentType: o.contentType, cacheControl: o.cacheControl },
        customMetadata: o.metadata,
      });
    },
    async get(key) {
      const obj = await b().get(key);
      return obj && "body" in obj ? obj : null;
    },
    delete: (key) => b().delete(key),
    list: (prefix, o = {}) => b().list({ prefix, cursor: o.cursor, limit: o.limit, include: ["httpMetadata", "customMetadata"] }),
    async serve(c, key, o = {}) {
      const range = parseRange(c.req.headers.get("range"));
      const etag = parseEtag(c.req.headers.get("if-none-match"));
      let obj: R2Object | R2ObjectBody | null;
      try {
        obj = await b().get(key, { range, onlyIf: etag ? { etagDoesNotMatch: etag } : undefined });
      } catch (e) {
        if (!range) throw e;
        // R2 throws for unsatisfiable ranges.
        const head = await b().head(key);
        if (!head) return problem(404);
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
      }
      if (!obj) return problem(404, { detail: `No object ${key}` });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
      headers.set("etag", obj.httpEtag);
      headers.set("cache-control", o.cacheControl ?? obj.httpMetadata?.cacheControl ?? "no-cache");
      headers.set("accept-ranges", "bytes");
      if (!("body" in obj)) return new Response(null, { status: 304, headers });

      if (range && obj.range) {
        const r = obj.range as { offset?: number; length?: number; suffix?: number };
        const start = r.suffix !== undefined ? Math.max(0, obj.size - r.suffix) : (r.offset ?? 0);
        const length = r.suffix !== undefined ? obj.size - start : (r.length ?? obj.size - start);
        const end = Math.min(obj.size, start + length) - 1;
        headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
        headers.set("content-length", String(end - start + 1));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set("content-length", String(obj.size));
      return new Response(obj.body, { headers });
    },
  };
}

export interface UploadHandlerOptions {
  /** The bucket, or a function of the request context such as `(c) => c.env.FILES`. */
  bucket: R2Bucket | ((c: Context<any, any>) => R2Bucket);
  /** Form field holding the file. Default "file". */
  field?: string;
  /** Maximum file size in bytes (413 above it). */
  maxBytes?: number;
  /** Allowed MIME types; `image/*` style wildcards work (415 otherwise). The type is client-supplied: do not trust it for security. */
  allowedTypes?: string[];
  /** Object key for the upload. Default: a random UUID plus the file's extension. */
  key?: (file: File, c: Context<any, any>) => string | Promise<string>;
}

const extension = (name: string) => {
  const m = name.toLowerCase().match(/\.[a-z0-9]{1,10}$/);
  return m ? m[0] : "";
};

/**
 * Route handler for `multipart/form-data` uploads into R2. Responds 201 with
 * `{ key, size, contentType, etag }`. Use with a route that has no `body` schema.
 */
export function uploadHandler(opts: UploadHandlerOptions) {
  const field = opts.field ?? "file";
  const allowed = (type: string) =>
    !opts.allowedTypes ||
    opts.allowedTypes.some((a) => (a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));

  return async (c: Context<any, any>): Promise<Response> => {
    const declared = Number(c.req.headers.get("content-length") ?? NaN);
    // The whole multipart body is larger than the file, so allow some slack for headers.
    if (opts.maxBytes !== undefined && declared > opts.maxBytes + 64 * 1024) {
      throw new HttpError(413, `File exceeds ${opts.maxBytes} bytes`);
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new HttpError(400, "Expected a multipart/form-data body");
    }
    const file = form.get(field);
    if (!(file instanceof File)) throw new HttpError(400, `Missing file field "${field}"`);
    if (opts.maxBytes !== undefined && file.size > opts.maxBytes) {
      throw new HttpError(413, `File exceeds ${opts.maxBytes} bytes`);
    }
    const contentType = file.type || "application/octet-stream";
    if (!allowed(contentType.split(";")[0]!.trim().toLowerCase())) throw new HttpError(415, `File type ${contentType} is not allowed`);

    const key = opts.key ? await opts.key(file, c) : crypto.randomUUID() + extension(file.name);
    const bucket = typeof opts.bucket === "function" ? opts.bucket(c) : opts.bucket;
    const obj = await bucket.put(key, file.stream(), { httpMetadata: { contentType } });
    return c.json({ key, size: file.size, contentType, etag: obj?.etag }, 201);
  };
}
