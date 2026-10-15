import type { Context } from "../../core/context.ts";
import { problem } from "../../core/errors.ts";
import { assertSafeKey, type BlobMeta, type BlobStore } from "./types.ts";

export interface ServeBlobOptions {
  /** `Cache-Control` header. Default `no-cache` (always revalidate via ETag). */
  cacheControl?: string;
  /** Force a download with this file name (`Content-Disposition: attachment`). */
  download?: string;
  /**
   * Serve content the browser can execute (HTML, SVG, XML, JavaScript) inline. Off by default: such
   * blobs are sent as attachments with `Content-Security-Policy: sandbox`, so a user upload can never
   * run script on your origin. Only enable it for blobs you authored.
   */
  allowActiveContent?: boolean;
}

/** A satisfiable byte range: inclusive `start`/`end`. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Resolve a `Range` header against a size. Returns `undefined` to serve the whole body (no header,
 * another unit, multiple ranges or a malformed spec), `"unsatisfiable"` for a 416, else the range.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  return { start, end: Math.min(end, size - 1) };
}

/** True when an `If-None-Match` header matches `etag` (weak comparison, lists and `*`). */
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  for (const raw of header.split(",")) {
    const t = raw.trim();
    if (t === "*") return true;
    if (t.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") === etag) return true;
  }
  return false;
}

const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/xsl|[a-z0-9.+-]+\/[a-z0-9.+-]+\+xml|(text|application)\/(x-)?(java|ecma)script|text\/jscript|application\/x-shockwave-flash)$/;

/** Content types a browser may execute or render with script (served sandboxed by default). */
export function isActiveContentType(contentType: string): boolean {
  return ACTIVE.test(contentType.split(";")[0]!.trim().toLowerCase());
}

/** `Content-Disposition: attachment` with an ASCII fallback and an RFC 5987 UTF-8 name; strips control chars. */
export function contentDisposition(filename: string): string {
  const name = filename.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[/\\]/g, "_").slice(0, 200) || "download";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The representation headers for a blob: type, etag, caching, nosniff and active-content sandboxing. */
export function blobHeaders(meta: Pick<BlobMeta, "key" | "contentType" | "etag">, opts: ServeBlobOptions = {}, cacheControl?: string): Headers {
  const type = meta.contentType || "application/octet-stream";
  const h = new Headers({
    "content-type": type,
    etag: `"${meta.etag}"`,
    "cache-control": opts.cacheControl ?? cacheControl ?? "no-cache",
    "accept-ranges": "bytes",
  });
  hardenBlobHeaders(h, meta.key, opts);
  return h;
}

/**
 * Apply `nosniff`, an optional download name, and the active-content sandbox (attachment +
 * `Content-Security-Policy: sandbox` for HTML/SVG/XML/JS unless `allowActiveContent`) to headers
 * that already carry the blob's `content-type`.
 */
export function hardenBlobHeaders(h: Headers, key: string, opts: Pick<ServeBlobOptions, "download" | "allowActiveContent"> = {}): void {
  h.set("x-content-type-options", "nosniff");
  if (opts.download !== undefined) h.set("content-disposition", contentDisposition(opts.download));
  if (!opts.allowActiveContent && isActiveContentType(h.get("content-type") ?? "")) {
    if (opts.download === undefined) h.set("content-disposition", contentDisposition(key.split("/").pop()!));
    h.set("content-security-policy", "sandbox");
  }
}

/** 416 response for a blob of `size` bytes. */
export function rangeNotSatisfiable(size: number, headers?: Headers): Response {
  const h = new Headers(headers);
  h.delete("content-type");
  h.set("content-range", `bytes */${size}`);
  return new Response(null, { status: 416, headers: h });
}

/** Set the 206 headers for `range` of a `size`-byte blob. */
export function setRangeHeaders(h: Headers, range: ByteRange, size: number): void {
  h.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  h.set("content-length", String(range.end - range.start + 1));
}

function isSafeKey(key: string): boolean {
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Respond with a blob from any {@link BlobStore}: 404 problem+json when missing, `ETag` +
 * `If-None-Match` (304), a single `Range` (206 / 416), `Accept-Ranges`, `Content-Length` and
 * `X-Content-Type-Options: nosniff`. HTML/SVG/XML/JS are sent as sandboxed attachments unless
 * `allowActiveContent` is set. HEAD requests get headers only (no body is opened).
 */
export async function serveBlob(c: Context<any, any>, store: BlobStore, key: string, opts: ServeBlobOptions = {}): Promise<Response> {
  if (!isSafeKey(key)) return problem(404, { detail: "No such file" });
  const req = c.req.headers;
  const rangeHeader = req.get("range");
  const head = c.req.method === "HEAD";

  // Fast path: one store call for a plain, unconditional GET. Conditional requests go through head()
  // first so a 304 never opens the blob.
  if (!rangeHeader && !head && !req.has("if-none-match")) {
    const got = await store.get(key);
    if (!got) return problem(404, { detail: `No such file: ${key}` });
    const h = blobHeaders(got.meta, opts);
    h.set("content-length", String(got.meta.size));
    return new Response(bodyOf(got), { headers: h });
  }

  const meta = await store.head(key);
  if (!meta) return problem(404, { detail: `No such file: ${key}` });
  const h = blobHeaders(meta, opts);
  if (etagMatches(req.get("if-none-match"), meta.etag)) return new Response(null, { status: 304, headers: h });

  const range = parseRange(rangeHeader, meta.size);
  if (range === "unsatisfiable") return rangeNotSatisfiable(meta.size, h);
  if (range) setRangeHeaders(h, range, meta.size);
  else h.set("content-length", String(meta.size));
  const status = range ? 206 : 200;
  if (head) return new Response(null, { status, headers: h });

  const got = await store.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
  if (!got) return problem(404, { detail: `No such file: ${key}` });
  return new Response(bodyOf(got), { status, headers: h });
}

/** Prefer a sized Blob when the store offers one: runtimes keep Content-Length and can use sendfile. */
function bodyOf(got: { body: ReadableStream<Uint8Array>; blob?: Blob }): BodyInit {
  if (got.blob) {
    got.body.cancel().catch(() => {});
    return got.blob;
  }
  return got.body;
}
