import type { Context } from "../../core/context.ts";
import { HttpError } from "../../core/errors.ts";
import { newId } from "../data/types.ts";
import { imageInfo, type ImageInfo } from "./image.ts";
import type { BlobStore } from "./types.ts";

/** What was learned about one uploaded file before it is stored (passed to `key` and `validate`). */
export interface UploadInfo {
  /** Position among the uploaded files (0-based). */
  index: number;
  field: string;
  /** Client-supplied file name: display only, never use it as a path. */
  name: string;
  size: number;
  /** Client-supplied MIME type (untrusted). */
  declaredType: string;
  /** Type detected from the bytes (or an explicitly allowed declared type for formats that cannot be sniffed). */
  contentType: string;
  /** Extension for `contentType`, without the dot (`jpg`, `png`, ...). */
  ext: string;
  /** Format and dimensions when the file is a supported image. */
  image?: ImageInfo;
}

export interface UploadedFile {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  width?: number;
  height?: number;
}

/** A store, or a function of the request context such as `(c) => r2BlobStore(c.env.FILES)`. */
export type BlobStoreRef = BlobStore | ((c: Context<any, any>) => BlobStore);

export interface UploadOptions {
  /** Form field holding the file(s). Default "file". */
  field?: string;
  /** Maximum size of each file in bytes (413 above it). Default 10 MiB. */
  maxBytes?: number;
  /** Maximum number of files in the field (400 above it). Default 1. */
  maxFiles?: number;
  /**
   * Allowed content types, checked against the type detected from the file's bytes; `image/*`
   * wildcards work. Default: JPEG, PNG, WebP and GIF. Formats that cannot be sniffed (e.g.
   * `text/plain`) are accepted with their declared type only when listed here exactly.
   */
  allowed?: string[];
  /** Reject anything that is not a recognised image (415). */
  requireImage?: boolean;
  /** Extra checks; return an error message to reject the upload with 422 (e.g. panorama aspect ratio). */
  validate?: (info: UploadInfo, file: File) => string | undefined | Promise<string | undefined>;
  /** Storage key. Default `${prefix}/${newId()}.${ext}`; never derived from the client's file name. */
  key?: (file: File, info: UploadInfo, c: Context<any, any>) => string | Promise<string>;
  /** Key prefix for the default key. Default "uploads". */
  prefix?: string;
  /** Custom metadata stored with every blob. */
  metadata?: (info: UploadInfo, c: Context<any, any>) => Record<string, string> | undefined;
}

const DEFAULT_ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Room for multipart boundaries and part headers on top of the files themselves. */
const MULTIPART_SLACK = 64 * 1024;

/** Types recognised from magic bytes; a client declaring one of these must send matching bytes. */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "application/zip": "zip",
};
const SNIFFABLE = new Set([...Object.keys(EXT), "image/jpg", "image/pjpeg"]);
/** Extensions for allowed formats that cannot be sniffed (unknown ones get `bin`). */
const PASSIVE_EXT: Record<string, string> = {
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "text/markdown": "md",
  "application/octet-stream": "bin",
};

/** Detect a file's real type from its first bytes: images via {@link imageInfo}, plus PDF and ZIP. */
export function sniffType(bytes: Uint8Array): { contentType: string; image?: ImageInfo } | undefined {
  const image = imageInfo(bytes);
  if (image) return { contentType: image.mime, image };
  const at = (sig: number[]) => sig.every((v, i) => bytes[i] === v);
  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return { contentType: "application/pdf" };
  if (at([0x50, 0x4b, 0x03, 0x04])) return { contentType: "application/zip" };
  return undefined;
}

const typeOnly = (t: string) => t.split(";")[0]!.trim().toLowerCase();

const isAllowed = (allowed: string[], type: string) =>
  allowed.some((a) => {
    const t = a.toLowerCase();
    return t.endsWith("/*") ? type.startsWith(t.slice(0, -1)) : type === t;
  });

const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  new HttpError(status, message, { code, details });

/** Read a request body with a hard byte cap (for bodies without a trustworthy Content-Length). */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw fail(413, "request_too_large", `Request body exceeds ${cap} bytes`, { limit: cap });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

async function parseForm(c: Context<any, any>, cap: number): Promise<FormData> {
  const type = c.req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) {
    throw fail(400, "multipart_required", "Expected a multipart/form-data body", { contentType: type || undefined });
  }
  const declared = c.req.headers.get("content-length");
  const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
  if (length !== undefined && length > cap) {
    throw fail(413, "request_too_large", `Request body exceeds ${cap} bytes`, { limit: cap, contentLength: length });
  }
  try {
    if (length !== undefined || !c.req.body) return await c.req.formData();
    const bytes = await readCapped(c.req.body, cap);
    return await new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } }).formData();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw fail(400, "multipart_invalid", "Malformed multipart/form-data body");
  }
}

/**
 * Parse a multipart upload, check every file and store them. Types come from the file's bytes
 * (never the client's MIME type or extension); keys are generated. All files are validated before
 * any is stored. Throws {@link HttpError} 400 / 413 / 415 / 422 with a `code` and details.
 */
export async function uploadFiles(c: Context<any, any>, store: BlobStore, opts: UploadOptions = {}): Promise<UploadedFile[]> {
  const field = opts.field ?? "file";
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? 1;
  const allowed = opts.allowed ?? DEFAULT_ALLOWED;
  const prefix = (opts.prefix ?? "uploads").replace(/\/+$/, "");

  const form = await parseForm(c, maxBytes * maxFiles + MULTIPART_SLACK);
  const files = form.getAll(field).filter((v): v is File => typeof v !== "string");
  if (files.length === 0) throw fail(400, "file_missing", `Missing file field "${field}"`, { field });
  if (files.length > maxFiles) {
    throw fail(400, "too_many_files", `At most ${maxFiles} file(s) allowed in "${field}"`, { field, maxFiles, received: files.length });
  }

  const checked: { file: File; bytes: Uint8Array; info: UploadInfo }[] = [];
  for (const [index, file] of files.entries()) {
    const where = { field, index, name: file.name };
    if (file.size > maxBytes) {
      throw fail(413, "file_too_large", `File "${file.name}" exceeds ${maxBytes} bytes`, { ...where, size: file.size, limit: maxBytes });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const declaredType = typeOnly(file.type);
    const sniffed = sniffType(bytes);
    const detected = sniffed?.contentType ?? "application/octet-stream";
    const declaredSniffable = SNIFFABLE.has(declaredType);
    const normalizedDeclared = declaredType === "image/jpg" || declaredType === "image/pjpeg" ? "image/jpeg" : declaredType;

    // A client claiming a format we can recognise must send bytes of that format.
    if (declaredSniffable && normalizedDeclared !== detected) {
      throw fail(415, "file_type_mismatch", `File "${file.name}" is not a valid ${declaredType}`, { ...where, declared: declaredType, detected, allowed });
    }
    // Unrecognised bytes keep their declared type only when that exact type is explicitly allowed.
    const contentType =
      sniffed?.contentType ??
      (declaredType && !declaredSniffable && allowed.some((a) => a.toLowerCase() === declaredType) ? declaredType : "application/octet-stream");

    if (opts.requireImage && !sniffed?.image) {
      throw fail(415, "file_not_image", `File "${file.name}" is not a supported image (JPEG, PNG, WebP or GIF)`, { ...where, declared: declaredType, detected });
    }
    if (!isAllowed(allowed, contentType)) {
      throw fail(415, "file_type_not_allowed", `File type ${contentType} is not allowed`, { ...where, declared: declaredType, detected: contentType, allowed });
    }
    const info: UploadInfo = {
      index,
      field,
      name: file.name,
      size: bytes.byteLength,
      declaredType,
      contentType,
      ext: EXT[contentType] ?? PASSIVE_EXT[contentType] ?? "bin",
      ...(sniffed?.image ? { image: sniffed.image } : {}),
    };
    const problem = await opts.validate?.(info, file);
    if (problem) throw fail(422, "file_invalid", problem, { ...where, contentType, ...(info.image ? { width: info.image.width, height: info.image.height } : {}) });
    checked.push({ file, bytes, info });
  }

  const out: UploadedFile[] = [];
  for (const { file, bytes, info } of checked) {
    const key = opts.key ? await opts.key(file, info, c) : `${prefix ? prefix + "/" : ""}${newId()}.${info.ext}`;
    const meta = await store.put(key, bytes, { contentType: info.contentType, metadata: opts.metadata?.(info, c) });
    out.push({
      key: meta.key,
      size: meta.size,
      contentType: meta.contentType,
      etag: meta.etag,
      ...(info.image ? { width: info.image.width, height: info.image.height } : {}),
    });
  }
  return out;
}

/** A ready route handler: {@link uploadFiles}, then `201 { files: UploadedFile[] }`. Use on a route without a `body` schema. */
export function uploadRoute(store: BlobStoreRef, opts: UploadOptions = {}) {
  return async (c: Context<any, any>): Promise<Response> => {
    const s = typeof store === "function" ? store(c) : store;
    return c.json({ files: await uploadFiles(c, s, opts) }, 201);
  };
}
