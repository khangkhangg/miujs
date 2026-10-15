import type { Context } from "miujs";
import { filesErrors } from "./errors.ts";
import { cleanFilename, essence } from "./http.ts";
import { checkKey } from "./keys.ts";
import { EXTENSIONS, normalizeAllowed, sniff, SNIFF_BYTES } from "./sniff.ts";
import { randomHex, type FileStore } from "./store.ts";
import { limitStream, peek } from "./stream.ts";

export interface HandleUploadOptions {
  /** Form field holding the file(s), for multipart/form-data. Default "file". */
  field?: string;
  /** Maximum size of each file, in bytes. */
  maxSize: number;
  /** Accepted types, checked against the file's bytes: png, jpeg, webp, gif, pdf, glb, mp4, zip (or their mime types). */
  allowedTypes: string[];
  /** Most files accepted in one request (multipart). Default 1. */
  maxFiles?: number;
  /** Prefix of generated keys. Default "uploads/". Keys look like `uploads/<random>.png`. */
  prefix?: string;
  /** Choose the key yourself. `ext` comes from the detected type; `filename` is the client's (cleaned) name. */
  key?: (file: { filename?: string; contentType: string; ext: string; index: number }) => string;
  /** Extra metadata stored with each file (the cleaned client file name is added as `filename`). */
  metadata?: Record<string, string>;
}

export interface UploadedFile {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  /** The client's file name, cleaned (multipart only). Never used in the key. */
  filename?: string;
}

const FORM_OVERHEAD = 64 * 1024;

const config = (message: string, fix: string) => filesErrors.config("CONFIG", message, fix);
const noFile = (field: string) => filesErrors.badRequest("NO_FILE", `No file in the request (field "${field}")`, `Send multipart/form-data with the file in the "${field}" field, or the raw file bytes as the body.`);

function isInt(n: unknown, min: number): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= min;
}

/**
 * Read the upload, check every file's real type against `allowedTypes` and its size against
 * `maxSize`, then store them. All-or-nothing: if any file is rejected, none are kept.
 */
export async function handleUpload(ctx: Context, store: FileStore, opts: HandleUploadOptions): Promise<UploadedFile[]> {
  if (!opts || !isInt(opts.maxSize, 1)) throw config("handleUpload needs maxSize (bytes per file)", "Pass e.g. { maxSize: 10 * 1024 * 1024, allowedTypes: [\"png\", \"jpeg\"] }.");
  const allowed = normalizeAllowed(opts.allowedTypes);
  const maxFiles = opts.maxFiles ?? 1;
  if (!isInt(maxFiles, 1)) throw config("maxFiles must be a positive integer", "Pass e.g. { maxFiles: 5 }, or omit it to accept one file.");
  const field = opts.field ?? "file";
  const prefix = opts.prefix ?? "uploads/";
  if (prefix !== "") checkKey(prefix + "x");
  if (ctx.req.bodyUsed) {
    throw filesErrors.config("BODY_USED", "The request body was already read before handleUpload", "Remove the `body` schema from this route (and don't read ctx.req yourself): handleUpload streams the raw body.");
  }

  const maxSize = opts.maxSize;
  const keyFor = (contentType: string, index: number, filename?: string): string => {
    const ext = EXTENSIONS[contentType] ?? "";
    return checkKey(opts.key ? opts.key({ filename, contentType, ext, index }) : `${prefix}${randomHex()}${ext}`);
  };
  const metaFor = (filename?: string) => ({ ...opts.metadata, ...(filename ? { filename } : {}) });
  const checkType = (head: Uint8Array): string => {
    const type = sniff(head);
    if (!type || !allowed.includes(type)) throw filesErrors.typeNotAllowed(type, allowed);
    return type;
  };
  const cl = ctx.headers.get("content-length");
  const declared = cl !== null && /^\d{1,15}$/.test(cl) ? Number(cl) : undefined;
  const body = ctx.req.body;

  if (essence(ctx.headers.get("content-type")) === "multipart/form-data") {
    const bodyLimit = maxSize * maxFiles + FORM_OVERHEAD;
    if (declared !== undefined && declared > bodyLimit) throw filesErrors.tooLarge(maxSize);
    if (!body) throw noFile(field);
    let exceeded = false;
    const limited = limitStream(body, bodyLimit, () => {
      exceeded = true;
      return filesErrors.tooLarge(maxSize);
    });
    let form: FormData;
    try {
      form = await new Response(limited, { headers: { "content-type": ctx.headers.get("content-type")! } }).formData();
    } catch (err) {
      if (exceeded) throw filesErrors.tooLarge(maxSize);
      throw filesErrors.badRequest("BAD_FORM", "The multipart/form-data body could not be parsed", "Send a well-formed multipart/form-data body (let the browser or fetch build it from a FormData).");
    }
    const list = form.getAll(field).filter((v): v is File => typeof v !== "string");
    if (list.length === 0) throw noFile(field);
    if (list.length > maxFiles) {
      throw filesErrors.badRequest("TOO_MANY_FILES", `Got ${list.length} files, at most ${maxFiles} allowed`, `Send at most ${maxFiles} file(s) per request.`);
    }
    // Check everything before storing anything.
    const checked: { file: File; type: string; filename?: string }[] = [];
    for (const file of list) {
      if (file.size > maxSize) throw filesErrors.tooLarge(maxSize);
      const type = checkType(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
      checked.push({ file, type, filename: file.name ? cleanFilename(file.name) : undefined });
    }
    const out: UploadedFile[] = [];
    try {
      for (const [i, c] of checked.entries()) {
        const key = keyFor(c.type, i, c.filename);
        const info = await store.put(key, c.file.stream(), { contentType: c.type, metadata: metaFor(c.filename), size: c.file.size });
        out.push({ key, size: info.size, contentType: info.contentType, etag: info.etag, ...(c.filename ? { filename: c.filename } : {}) });
      }
    } catch (err) {
      await Promise.all(out.map((f) => store.delete(f.key).catch(() => {})));
      throw err;
    }
    return out;
  }

  // Raw body: the bytes are the file.
  if (declared !== undefined && declared > maxSize) throw filesErrors.tooLarge(maxSize);
  if (!body) throw noFile(field);
  const { head, stream } = await peek(limitStream(body, maxSize), SNIFF_BYTES);
  if (head.byteLength === 0) {
    await stream.cancel().catch(() => {});
    throw noFile(field);
  }
  let type: string;
  try {
    type = checkType(head);
  } catch (err) {
    await stream.cancel().catch(() => {});
    throw err;
  }
  const key = keyFor(type, 0);
  const info = await store.put(key, stream, { contentType: type, metadata: metaFor(), size: declared });
  return [{ key, size: info.size, contentType: info.contentType, etag: info.etag }];
}
