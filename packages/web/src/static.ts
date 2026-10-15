import { definePlugin, type Context } from "miujs";
import { webErrors } from "./errors.ts";
import { defaultFileSource, type FileSource, type FileStat } from "./fs.ts";
import { mimeType } from "./mime.ts";

export interface StaticOptions {
  /** Directory to serve, relative to the working directory. */
  dir: string;
  /** URL path the directory is mounted at. Default `/`. */
  prefix?: string;
  /** File served for unknown paths when the request accepts HTML, e.g. `"index.html"`. */
  spa?: string;
  /** File served for directory requests. Default `index.html`. */
  index?: string;
  /** File names that get `Cache-Control: public, max-age=31536000, immutable`. Default: hashed names like `main-BxY12abc.js`. */
  immutable?: RegExp;
  /** Serve `file.br` / `file.gz` siblings when the client accepts them. Default `true`. */
  precompressed?: boolean;
  /** Where files come from. Default: `Bun.file` on Bun, `node:fs` streams on Node and Deno. */
  source?: FileSource;
}

export const DEFAULT_IMMUTABLE = /-[A-Za-z0-9_-]{8,}\./;
const IMMUTABLE_CC = "public, max-age=31536000, immutable";
const ENCODINGS = [
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
] as const;

interface AssetsBinding {
  fetch(req: Request): Promise<Response>;
}

function normalizePrefix(prefix: string): string {
  let p = prefix.trim();
  if (!p.startsWith("/")) p = "/" + p;
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Quality value of `token` in an Accept / Accept-Encoding header, 0 when absent. */
function quality(header: string | null, token: string): number {
  if (!header) return 0;
  let star = 0;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = Number(v);
    }
    if (!(q >= 0)) q = 0;
    if (name === token) return q;
    if (name === "*") star = q;
  }
  return star;
}

function acceptsHtml(req: Request): boolean {
  const accept = req.headers.get("accept");
  return !!accept && accept.toLowerCase().includes("text/html") && quality(accept, "text/html") > 0;
}

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

type Range = { start: number; end: number } | "unsatisfiable" | null;

/** Single `bytes=` ranges only; anything else is ignored (full response), as RFC 9110 allows. */
function parseRange(header: string, size: number): Range {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === "" ? Infinity : Number(m[2]);
  if (last < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(last, size - 1) };
}

/**
 * Split the path below the prefix into decoded segments, refusing anything that could
 * leave the directory. Returns `null` for hidden files (fall through to 404).
 */
const SHORT_NAME = /^[^.~]{1,6}~\d+(?:\.[^.]{0,3})?$/;

function safeSegments(rest: string): { segs: string[]; raw: string[] } | null {
  const raw = rest.split("/").filter((s) => s !== "");
  const segs: string[] = [];
  for (const r of raw) {
    let d: string;
    try {
      d = decodeURIComponent(r);
    } catch {
      throw webErrors.badPath(rest);
    }
    if (d === "." || d === ".." || /[/\\:\0]/.test(d) || r.includes("\\")) throw webErrors.badPath(rest);
    if (d.startsWith(".") && d !== ".well-known") return null;
    // NTFS 8.3 short names ("ENV~1" is ".env", "GIT~1" is ".git") would reach hidden files.
    if (SHORT_NAME.test(d)) return null;
    segs.push(d);
  }
  return { segs, raw };
}

export interface StaticHandler {
  (ctx: Context): Promise<Response | void>;
}

/** The request handler behind `staticFiles`, for plugins that serve files themselves (e.g. `vite()`). */
export function createStaticHandler(opts: StaticOptions): StaticHandler {
  const prefix = normalizePrefix(opts.prefix ?? "/");
  const index = opts.index ?? "index.html";
  const immutable = opts.immutable ?? DEFAULT_IMMUTABLE;
  const precompressed = opts.precompressed ?? true;
  let source: FileSource | undefined = opts.source;
  let rootP: Promise<{ root: string; sep: string }> | undefined;

  async function serve(ctx: Context, file: string, name: string, st: FileStat, cacheable: boolean): Promise<Response> {
    const req = ctx.req;
    const type = mimeType(file);
    const headers = new Headers({ "content-type": type, "accept-ranges": "bytes" });
    headers.set("cache-control", cacheable && !type.startsWith("text/html") && immutable.test(name) ? IMMUTABLE_CC : "no-cache");
    if (precompressed) headers.set("vary", "Accept-Encoding");

    const rangeHeader = req.headers.get("range");
    let path = file;
    let size = st.size;
    let enc = "";
    if (precompressed && !rangeHeader) {
      const ae = req.headers.get("accept-encoding");
      for (const e of ENCODINGS) {
        if (quality(ae, e.name) <= 0) continue;
        const s = await source!.stat(file + e.ext);
        if (s?.isFile) {
          path = file + e.ext;
          size = s.size;
          enc = e.name;
          headers.set("content-encoding", e.name);
          break;
        }
      }
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${enc ? "-" + enc : ""}"`;
    headers.set("etag", etag);
    headers.set("last-modified", new Date(st.mtimeMs).toUTCString());

    const inm = req.headers.get("if-none-match");
    const ims = req.headers.get("if-modified-since");
    const notModified = inm !== null ? etagMatches(inm, etag) : ims !== null && Math.floor(st.mtimeMs / 1000) <= Date.parse(ims) / 1000;
    if (notModified) {
      headers.delete("content-type");
      return new Response(null, { status: 304, headers });
    }

    let start = 0;
    let end = size - 1;
    let status = 200;
    const ifRange = req.headers.get("if-range");
    if (rangeHeader && (ifRange === null || ifRange.trim() === etag)) {
      const r = parseRange(rangeHeader, size);
      if (r === "unsatisfiable") {
        headers.set("content-range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      if (r) {
        ({ start, end } = r);
        status = 206;
        headers.set("content-range", `bytes ${start}-${end}/${size}`);
      }
    }
    headers.set("content-length", String(end - start + 1));
    if (req.method === "HEAD") return new Response(null, { status, headers });
    return new Response(await source!.body(path, start, end), { status, headers });
  }

  return async (ctx) => {
    const method = ctx.method;
    if (method !== "GET" && method !== "HEAD") return;
    const path = ctx.path;
    if (prefix && path !== prefix && !path.startsWith(prefix + "/")) return;
    const rest = path.slice(prefix.length) || "/";
    const parts = safeSegments(rest);

    if (ctx.runtime === "workerd") {
      const assets = (ctx.env as Record<string, unknown>).ASSETS as AssetsBinding | undefined;
      if (!parts || !assets || typeof assets.fetch !== "function") return;
      const url = new URL(ctx.req.url);
      url.pathname = rest;
      const res = await assets.fetch(new Request(url, ctx.req));
      return res.status === 404 ? undefined : res;
    }
    if (!parts) return;

    source ??= defaultFileSource();
    const { root, sep } = await (rootP ??= source.root(opts.dir));
    let file = parts.segs.length ? root + sep + parts.segs.join(sep) : root;
    if (file !== root && !file.startsWith(root + sep)) throw webErrors.badPath(rest);
    let st = await source.stat(file);
    if (st?.isDirectory) {
      if (parts.segs.length && !rest.endsWith("/")) {
        const location = `${prefix}/${parts.raw.join("/")}/${ctx.url.search}`;
        return new Response(null, { status: 301, headers: { location } });
      }
      file = file + sep + index;
      st = await source.stat(file);
    }
    if (st?.isFile) return serve(ctx, file, file.slice(file.lastIndexOf(sep) + 1), st, true);

    if (opts.spa && acceptsHtml(ctx.req)) {
      const spaFile = root + sep + opts.spa;
      const s = await source.stat(spaFile);
      if (s?.isFile) return serve(ctx, spaFile, opts.spa, s, false);
    }
  };
}

/**
 * Serve a directory for GET/HEAD requests no route matched.
 *
 * ```ts
 * miu({ plugins: [staticFiles({ dir: "public" })] })
 * miu({ plugins: [staticFiles({ dir: "dist", spa: "index.html" })] })   // client-side routing
 * ```
 *
 * On Cloudflare Workers it delegates to the `ASSETS` binding (Workers Static Assets) instead.
 */
export function staticFiles(opts: StaticOptions) {
  if (!opts || typeof opts.dir !== "string" || opts.dir === "") {
    throw webErrors.config("staticFiles() needs a `dir`", 'Pass the folder to serve: staticFiles({ dir: "public" }).');
  }
  const handler = createStaticHandler(opts);
  return definePlugin({
    name: "static-files",
    onRequest(ctx: Context) {
      if (ctx.route !== null) return;
      return handler(ctx);
    },
    inspect() {
      return {
        dir: opts.dir,
        prefix: normalizePrefix(opts.prefix ?? "/") || "/",
        index: opts.index ?? "index.html",
        spa: opts.spa ?? null,
        immutable: (opts.immutable ?? DEFAULT_IMMUTABLE).source,
        precompressed: opts.precompressed ?? true,
        workers: "delegates to env.ASSETS (Workers Static Assets) when bound",
      };
    },
  });
}
