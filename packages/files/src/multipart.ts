// Resumable multipart uploads for large files (3D models, 360° panoramas, video). The upload id
// handed to the client is a signed token binding the key, the store's upload id, the user and
// an expiry, so the routes stay stateless (no shared state across Workers isolates).
import { route, type Context, type RouteDef } from "miujs";
import { checkContentType, isPositiveInt, MAX_EXPIRES_IN, type FilesRuntime } from "./client.ts";
import { filesErrors } from "./errors.ts";
import { cleanFilename, essence } from "./http.ts";
import { checkKey } from "./keys.ts";
import { EXTENSIONS, normalizeAllowed, sniff, SNIFF_BYTES } from "./sniff.ts";
import { randomHex, type UploadedPart } from "./store.ts";
import { collect, limitStream } from "./stream.ts";
import { signToken, verifyToken, type TokenPayload } from "./token.ts";

export interface MultipartOptions {
  /** Largest finished file, in bytes. Default 5 GiB. */
  maxSize?: number;
  /**
   * Largest single part, in bytes. Default 50 MiB (Cloudflare caps request bodies at 100 MB on
   * most plans). R2 needs every part except the last to be at least 5 MiB and the same size.
   */
  maxPartSize?: number;
  /**
   * When set, `contentType` is required on create and must be one of these, and on complete the
   * file's first bytes must match it (png, jpeg, webp, gif, pdf, glb, mp4, zip).
   */
  allowedTypes?: string[];
  /** Seconds an upload id stays valid. Default 86400 (24 h), max 7 days. */
  expiresIn?: number;
  /** Choose the key for a new upload. Default `uploads/<random><ext>`. */
  key?: (ctx: Context, file: { filename?: string; contentType?: string; ext: string }) => string;
}

const MiB = 1024 * 1024;
const config = (message: string, fix: string) => filesErrors.config("CONFIG", message, fix);
const badBody = (message: string, fix: string) => filesErrors.badRequest("BAD_REQUEST", message, fix);

async function readJson(ctx: Context): Promise<Record<string, unknown>> {
  const text = ctx.req.body ? await collect(limitStream(ctx.req.body, 256 * 1024)).then((b) => new TextDecoder().decode(b)) : "";
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v;
  } catch {}
  throw badBody("Request body must be a JSON object", 'Send JSON such as { "filename": "tour.glb", "contentType": "model/gltf-binary" }.');
}

export function multipartRoutes(basePath: string, rt: FilesRuntime, opts: MultipartOptions): RouteDef[] {
  const maxSize = opts.maxSize ?? 5 * 1024 * MiB;
  const maxPartSize = opts.maxPartSize ?? 50 * MiB;
  const expiresIn = opts.expiresIn ?? 86400;
  if (!isPositiveInt(maxSize)) throw config("multipart.maxSize must be a positive number of bytes", "Pass e.g. multipart: { maxSize: 2 * 1024 ** 3 }.");
  if (!isPositiveInt(maxPartSize)) throw config("multipart.maxPartSize must be a positive number of bytes", "Pass e.g. multipart: { maxPartSize: 50 * 1024 ** 2 }.");
  if (!isPositiveInt(expiresIn) || expiresIn > MAX_EXPIRES_IN) throw config(`multipart.expiresIn must be 1..${MAX_EXPIRES_IN} seconds`, "Pass e.g. multipart: { expiresIn: 86400 }.");
  const allowed = opts.allowedTypes ? normalizeAllowed(opts.allowedTypes) : undefined;
  const now = () => Math.floor(Date.now() / 1000);

  /** Verify the upload id and that it belongs to the signed-in user. */
  const open = async (ctx: Context): Promise<TokenPayload & { u: string }> => {
    const p = await verifyToken(rt.secretsFor(ctx), ctx.params.id, "mpu", now());
    if (typeof p.u !== "string" || p.uid !== ctx.user?.id) throw filesErrors.tokenInvalid("this upload belongs to another user");
    checkKey(p.k);
    return p as TokenPayload & { u: string };
  };

  const create = route.post(`${basePath}/uploads`, {
    name: "files_multipart_create",
    summary: "Start a resumable multipart upload",
    tags: ["files"],
    auth: "required",
    mcp: false,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const body = await readJson(ctx);
      if (body.filename !== undefined && typeof body.filename !== "string") throw badBody("filename must be a string", 'Send e.g. { "filename": "tour.glb" }.');
      let contentType: string | undefined;
      try {
        contentType = checkContentType(body.contentType);
      } catch {
        throw badBody("contentType must be a media type string", 'Send e.g. { "contentType": "model/gltf-binary" }.');
      }
      const filename = body.filename ? cleanFilename(body.filename as string) : undefined;
      if (allowed) {
        const t = essence(contentType);
        if (!allowed.includes(t)) throw filesErrors.typeNotAllowed(t || null, allowed);
        contentType = t;
      }
      const fromName = filename?.match(/\.[A-Za-z0-9]{1,10}$/)?.[0]?.toLowerCase();
      const ext = (contentType && EXTENSIONS[essence(contentType)]) ?? fromName ?? "";
      const key = checkKey(opts.key ? opts.key(ctx, { filename, contentType, ext }) : `uploads/${randomHex()}${ext}`);
      const metadata: Record<string, string> = { uploadedBy: ctx.user!.id };
      if (filename) metadata.filename = filename;
      const storeId = await rt.storeFor(ctx.env).createMultipart(key, { contentType, metadata });
      const e = now() + expiresIn;
      const payload: TokenPayload = { p: "mpu", k: key, u: storeId, uid: ctx.user!.id, e };
      if (contentType) payload.ct = contentType;
      const uploadId = await signToken(rt.secretsFor(ctx), payload);
      ctx.set.status = 201;
      return { uploadId, key, expiresAt: new Date(e * 1000).toISOString(), maxPartSize, maxSize };
    },
  });

  const part = route.put(`${basePath}/uploads/:id/parts/:n`, {
    name: "files_multipart_part",
    summary: "Upload one part of a multipart upload",
    tags: ["files"],
    auth: "required",
    mcp: false,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const p = await open(ctx);
      const raw = ctx.params.n as string;
      const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
      if (!(n >= 1 && n <= 10000)) throw filesErrors.partInvalid(raw);
      const cl = ctx.headers.get("content-length");
      const declared = cl !== null && /^\d{1,15}$/.test(cl) ? Number(cl) : undefined;
      if (declared !== undefined && declared > maxPartSize) throw filesErrors.tooLarge(maxPartSize);
      const body = ctx.req.body ?? new Blob([]).stream();
      return rt.storeFor(ctx.env).uploadPart(p.k, p.u, n, limitStream(body, maxPartSize), declared);
    },
  });

  const complete = route.post(`${basePath}/uploads/:id/complete`, {
    name: "files_multipart_complete",
    summary: "Finish a multipart upload",
    tags: ["files"],
    auth: "required",
    mcp: false,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const p = await open(ctx);
      const { parts } = await readJson(ctx);
      if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10000) throw filesErrors.partInvalid("(parts must be a non-empty array)");
      const seen = new Set<number>();
      for (const x of parts as UploadedPart[]) {
        const ok = typeof x === "object" && x !== null && Number.isInteger(x.partNumber) && x.partNumber >= 1 && x.partNumber <= 10000 && typeof x.etag === "string" && x.etag !== "" && x.etag.length <= 256;
        if (!ok || seen.has(x.partNumber)) throw filesErrors.partInvalid(x?.partNumber);
        seen.add(x.partNumber);
      }
      const ordered = (parts as UploadedPart[]).map((x) => ({ partNumber: x.partNumber, etag: x.etag })).sort((a, b) => a.partNumber - b.partNumber);
      const st = rt.storeFor(ctx.env);
      const info = await st.completeMultipart(p.k, p.u, ordered);
      if (info.size > maxSize) {
        await st.delete(p.k);
        throw filesErrors.tooLarge(maxSize);
      }
      if (allowed) {
        const head = await st.get(p.k, { range: { offset: 0, length: SNIFF_BYTES } });
        const type = head ? sniff(await collect(head.body)) : null;
        if (!type || type !== essence(p.ct)) {
          await st.delete(p.k);
          throw filesErrors.typeNotAllowed(type, allowed);
        }
      }
      return { key: info.key, size: info.size, etag: info.etag, contentType: info.contentType };
    },
  });

  const abort = route.delete(`${basePath}/uploads/:id`, {
    name: "files_multipart_abort",
    summary: "Abort a multipart upload",
    tags: ["files"],
    auth: "required",
    mcp: false,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const p = await open(ctx);
      await rt.storeFor(ctx.env).abortMultipart(p.k, p.u);
      return undefined;
    },
  });

  return [create, part, complete, abort];
}
