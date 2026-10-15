import { definePlugin, route, type CloudflareNeeds, type Context, type RouteDef } from "miujs";
import { Files, isPositiveInt, type FilesClient, type FilesRuntime } from "./client.ts";
import { filesErrors } from "./errors.ts";
import { contentDisposition, essence, etagMatches, ifRangeMatches, inlineSafe, parseRange, SANDBOX_CSP } from "./http.ts";
import { checkKey } from "./keys.ts";
import { memoryStore } from "./memory.ts";
import { multipartRoutes, type MultipartOptions } from "./multipart.ts";
import { randomHex, type FileStore } from "./store.ts";
import { limitStream } from "./stream.ts";
import { verifyToken } from "./token.ts";

declare module "miujs" {
  interface Context {
    /** File storage from `@miujs/files`. */
    files: FilesClient;
  }
}

export interface FilesOptions {
  /** Where files live. Default: memoryStore() in development; required in production. */
  store?: FileStore;
  /**
   * HMAC secret for signed URLs, 32+ characters. An array rotates keys: the first signs, all
   * verify. Default: env.FILES_SECRET, then env.SESSION_SECRET.
   */
  secret?: string | string[];
  /** Where the plugin serves signed URLs and uploads. Default "/_files". */
  basePath?: string;
  /** Origin used in signed URLs, e.g. "https://files.example.com". Default: the request's origin. */
  publicUrl?: string;
  /** Size limit for signed PUT uploads that don't set `maxSize`. Default 100 MiB. */
  maxUploadSize?: number;
  /** Resumable multipart upload routes under `{basePath}/uploads`. `false` turns them off. */
  multipart?: false | MultipartOptions;
  /** Where dev-mode warnings go. Default: the request logger. */
  onWarning?: (message: string) => void;
}

export const MIN_SECRET = 32;
const MiB = 1024 * 1024;

function checkBasePath(p: string): string {
  if (typeof p !== "string" || !/^(\/[A-Za-z0-9._~-]+)+$/.test(p)) {
    throw filesErrors.config("CONFIG", `Invalid basePath ${JSON.stringify(p)}`, 'Use an absolute path without a trailing slash or params, e.g. "/_files" or "/media".');
  }
  return p;
}

/**
 * Adds `ctx.files` and the routes that serve signed URLs.
 *
 * ```ts
 * miu({ plugins: [files()] })                                    // memory store in dev
 * miu({ plugins: [files({ store: r2Store("FILES") })] })         // Cloudflare R2
 * miu({ plugins: [files({ store: localStore("./data/files") })] })
 * ```
 */
export function files(opts: FilesOptions = {}) {
  const basePath = checkBasePath(opts.basePath ?? "/_files");
  const maxUploadSize = opts.maxUploadSize ?? 100 * MiB;
  if (!isPositiveInt(maxUploadSize)) throw filesErrors.config("CONFIG", "maxUploadSize must be a positive number of bytes", "Pass e.g. maxUploadSize: 50 * 1024 * 1024.");
  const publicUrl = opts.publicUrl?.replace(/\/+$/, "");
  const configured = opts.store;
  let store: FileStore = configured ?? memoryStore();
  let dev = true;
  let devSecret: string | undefined;
  let warned = false;

  const rt: FilesRuntime = {
    basePath,
    publicUrl,
    maxUploadSize,
    storeFor: (env) => (store.forEnv ? store.forEnv(env) : store),
    secretsFor(ctx: Context): string[] {
      const env = ctx.env ?? {};
      const raw = opts.secret ?? ((env.FILES_SECRET as string) || (env.SESSION_SECRET as string) || undefined);
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((s) => typeof s === "string" && s !== "");
      if (list.length === 0) {
        if (!dev) throw filesErrors.secretMissing();
        if (!warned) {
          warned = true;
          const msg = "FILES_SECRET is not set; signing file URLs with a random secret for this process, so signed URLs stop working on restart. Set FILES_SECRET (32+ chars) before deploying.";
          if (opts.onWarning) opts.onWarning(msg);
          else ctx.log.warn(msg);
        }
        return [(devSecret ??= randomHex(32))];
      }
      if (list.some((s) => s.length < MIN_SECRET)) throw filesErrors.secretWeak();
      return list;
    },
  };

  const now = () => Math.floor(Date.now() / 1000);

  const download = route.get(`${basePath}/:token`, {
    name: "files_download",
    summary: "Download a file through a signed URL",
    tags: ["files"],
    mcp: false,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const p = await verifyToken(rt.secretsFor(ctx), ctx.params.token, "url", now());
      if (p.m !== "GET") throw filesErrors.tokenInvalid("this URL was signed for PUT");
      const key = checkKey(p.k);
      const st = rt.storeFor(ctx.env);
      const info = await st.head(key);
      if (!info) throw filesErrors.notFound(key);

      const h = new Headers();
      h.set("cache-control", `private, max-age=${Math.max(0, p.e - now())}`);
      h.set("x-content-type-options", "nosniff");
      h.set("etag", `"${info.etag}"`);
      const inm = ctx.headers.get("if-none-match");
      if (inm !== null && etagMatches(inm, info.etag)) return new Response(null, { status: 304, headers: h });

      h.set("accept-ranges", "bytes");
      h.set("content-type", info.contentType);
      if (p.d !== undefined) h.set("content-disposition", contentDisposition(p.d));
      else if (!inlineSafe(info.contentType)) h.set("content-disposition", "attachment");
      if (essence(info.contentType) !== "application/pdf") h.set("content-security-policy", SANDBOX_CSP);

      let range = parseRange(ctx.headers.get("range"), info.size);
      if (range !== null && !ifRangeMatches(ctx.headers.get("if-range"), info.etag)) range = null;
      if (range === "unsatisfiable") {
        h.set("content-range", `bytes */${info.size}`);
        h.delete("content-type");
        return new Response(null, { status: 416, headers: h });
      }
      if (ctx.method === "HEAD") {
        h.set("content-length", String(range ? range.length : info.size));
        if (range) h.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${info.size}`);
        return new Response(null, { status: range ? 206 : 200, headers: h });
      }
      const obj = await st.get(key, range ? { range } : undefined);
      if (!obj) throw filesErrors.notFound(key);
      // The object may have been replaced since `head`: describe what is actually sent.
      h.set("etag", `"${obj.etag}"`);
      h.set("content-type", obj.contentType);
      if (range && obj.range) {
        h.set("content-length", String(obj.range.length));
        h.set("content-range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
        return new Response(obj.body, { status: 206, headers: h });
      }
      h.set("content-length", String(obj.size));
      return new Response(obj.body, { status: 200, headers: h });
    },
  });

  const upload = route.put(`${basePath}/:token`, {
    name: "files_upload_signed",
    summary: "Upload a file through a signed PUT URL",
    // The signed token is the credential, not a cookie, so cross-site PUTs are fine.
    tags: ["files", "csrf-exempt"],
    mcp: false,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const p = await verifyToken(rt.secretsFor(ctx), ctx.params.token, "url", now());
      if (p.m !== "PUT") throw filesErrors.tokenInvalid("this URL was signed for GET");
      const key = checkKey(p.k);
      const limit = p.ms ?? maxUploadSize;
      const cl = ctx.headers.get("content-length");
      const declared = cl !== null && /^\d{1,15}$/.test(cl) ? Number(cl) : undefined;
      if (declared !== undefined && declared > limit) throw filesErrors.tooLarge(limit);
      const sent = ctx.headers.get("content-type");
      if (p.ct !== undefined && essence(sent) !== essence(p.ct)) throw filesErrors.typeNotAllowed(essence(sent) || null, [p.ct]);
      const contentType = p.ct ?? (sent && !/[\u0000-\u001f\u007f]/.test(sent) ? sent.slice(0, 255) : undefined);
      const body = ctx.req.body ?? new Blob([]).stream();
      const info = await rt.storeFor(ctx.env).put(key, limitStream(body, limit), { contentType, size: declared });
      return { key: info.key, size: info.size, etag: info.etag, contentType: info.contentType };
    },
  });

  const routes: RouteDef[] = [download, upload];
  if (opts.multipart !== false) routes.push(...multipartRoutes(basePath, rt, opts.multipart ?? {}));

  return definePlugin({
    name: "files",
    routes,
    setup(app) {
      dev = app.dev;
      if (!configured && !dev) throw filesErrors.storeMissing();
    },
    onRequest(ctx: Context) {
      ctx.files = new Files(ctx, rt);
    },
    inspect() {
      return {
        store: store.kind,
        basePath,
        ...store.inspect?.(),
        multipart: opts.multipart !== false,
        maxUploadSize,
        secret: opts.secret ? "(option)" : "env.FILES_SECRET or env.SESSION_SECRET",
      };
    },
    cloudflare(): CloudflareNeeds {
      const binding = configured?.forEnv && configured.kind === "r2" ? configured.inspect?.().binding : undefined;
      return typeof binding === "string" ? { r2: [binding] } : {};
    },
  });
}
