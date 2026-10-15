import { MiuError, processEnv, type Env } from "miujs";
import { filesErrors } from "./errors.ts";
import { encodeRfc3986, sha256Hex, signV4, type SigV4Credentials } from "./sigv4.ts";
import { DEFAULT_TYPE, type FileObject, type FileStore, type StoredFile, type StorePutOptions, type UploadedPart } from "./store.ts";
import { collect, sliceStream } from "./stream.ts";

/** A literal value, or the name of an env var to read it from (per request on Workers). */
export type S3Setting = string | { env: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface S3StoreOptions {
  /** e.g. "https://s3.eu-central-1.amazonaws.com", "https://<account>.r2.cloudflarestorage.com", "http://localhost:9000". Default: S3_ENDPOINT, else AWS for `region`. */
  endpoint?: S3Setting;
  /** Default: S3_REGION, AWS_REGION, else "us-east-1". Use "auto" for R2. */
  region?: S3Setting;
  /** Default: S3_BUCKET. */
  bucket?: S3Setting;
  /** Default: S3_ACCESS_KEY_ID, then AWS_ACCESS_KEY_ID. */
  accessKeyId?: S3Setting;
  /** Default: S3_SECRET_ACCESS_KEY, then AWS_SECRET_ACCESS_KEY. */
  secretAccessKey?: S3Setting;
  /** Temporary credentials. Default: S3_SESSION_TOKEN, then AWS_SESSION_TOKEN. */
  sessionToken?: S3Setting;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. Needed for MinIO and most self-hosted servers. Default false. */
  forcePathStyle?: boolean;
  /** Custom fetch (tests, proxies). Default: global fetch. */
  fetch?: FetchLike;
}

const DEFAULT_ENV = {
  endpoint: ["S3_ENDPOINT"],
  region: ["S3_REGION", "AWS_REGION"],
  bucket: ["S3_BUCKET"],
  accessKeyId: ["S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
  secretAccessKey: ["S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
  sessionToken: ["S3_SESSION_TOKEN", "AWS_SESSION_TOKEN"],
} as const;
type Name = keyof typeof DEFAULT_ENV;

interface Resolved {
  endpoint: URL;
  region: string;
  bucket: string;
  credentials: SigV4Credentials;
}

const names = (s: S3Setting | undefined, n: Name): readonly string[] => (typeof s === "object" && s ? [s.env] : DEFAULT_ENV[n]);

function resolve(o: S3StoreOptions, env: Env): Resolved {
  const pe = processEnv();
  const missing: string[] = [];
  const read = (n: Name, required: boolean): string | undefined => {
    const s = o[n];
    if (typeof s === "string" && s !== "") return s;
    for (const name of names(s, n)) {
      const v = env?.[name] ?? pe[name];
      if (typeof v === "string" && v !== "") return v;
    }
    if (required) missing.push(`${n} (${names(s, n).join(" or ")})`);
    return undefined;
  };
  const region = read("region", false) ?? "us-east-1";
  const endpointText = read("endpoint", false) ?? `https://s3.${region}.amazonaws.com`;
  const bucket = read("bucket", true);
  const accessKeyId = read("accessKeyId", true);
  const secretAccessKey = read("secretAccessKey", true);
  const sessionToken = read("sessionToken", false);
  if (missing.length) {
    throw filesErrors.config(
      "S3_CONFIG",
      `s3Store is missing ${missing.join(", ")}`,
      "Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (plus S3_ENDPOINT and S3_REGION for non-AWS services), or pass them to s3Store({ ... }), as values or as { env: \"VAR_NAME\" }. On Workers: `wrangler secret put S3_SECRET_ACCESS_KEY`.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    throw filesErrors.config("S3_CONFIG", `s3Store endpoint ${JSON.stringify(endpointText)} is not an http(s) URL`, 'Pass an endpoint such as "https://s3.eu-central-1.amazonaws.com" or "https://<account>.r2.cloudflarestorage.com".');
  }
  return { endpoint, region, bucket: bucket!, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, sessionToken } };
}

// --- tiny XML helpers for S3's fixed response shapes ------------------------------------------

const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|apos|lt|gt|amp);/g, (_, e: string) =>
    e === "quot" ? '"' : e === "apos" ? "'" : e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : undefined;
};
const unquote = (etag: string | null | undefined) => (etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");

// --- errors -----------------------------------------------------------------------------------

function s3Fix(code: string, r: Resolved): string {
  switch (code) {
    case "SignatureDoesNotMatch":
    case "InvalidAccessKeyId":
    case "AccessDenied":
    case "ExpiredToken":
    case "InvalidToken":
    case "Forbidden":
      return `Check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (or the env names you passed to s3Store), that the key may access bucket "${r.bucket}", and that region "${r.region}" is right for this endpoint.`;
    case "AuthorizationHeaderMalformed":
    case "PermanentRedirect":
    case "IllegalLocationConstraintException":
      return `Bucket "${r.bucket}" is in another region than "${r.region}". Set S3_REGION (or region) to the bucket's region ("auto" for R2).`;
    case "NoSuchBucket":
      return `Create bucket "${r.bucket}" at ${r.endpoint.origin}, or point S3_BUCKET / S3_ENDPOINT at an existing one. MinIO and other self-hosted servers usually need forcePathStyle: true.`;
    case "RequestTimeTooSkewed":
      return "This machine's clock is off by more than 15 minutes. Sync it (NTP).";
    case "SlowDown":
    case "ServiceUnavailable":
    case "InternalError":
      return "The storage service is overloaded or failing; retry with backoff.";
    default:
      return `See the S3 error code "${code}" in your provider's docs. Endpoint: ${r.endpoint.origin}, bucket "${r.bucket}".`;
  }
}

function s3Error(op: string, status: number, code: string, message: string, r: Resolved, cause?: unknown): MiuError {
  return new MiuError({
    code: "MIU_E_FILES_S3",
    status: 502,
    message: `S3 ${op} failed: ${status} ${code}${message ? ` (${message})` : ""}`,
    fix: s3Fix(code, r),
    details: { status, s3Code: code, bucket: r.bucket, endpoint: r.endpoint.origin },
    cause,
  });
}

const STATUS_CODES: Record<number, string> = { 400: "BadRequest", 403: "Forbidden", 404: "NotFound", 412: "PreconditionFailed", 500: "InternalError", 503: "ServiceUnavailable" };

// --- the store over one resolved bucket -------------------------------------------------------

function bucketStore(r: Resolved, pathStyle: boolean, fetchFn: FetchLike): FileStore {
  const basePath = r.endpoint.pathname.replace(/\/+$/, "");
  const urlFor = (key: string | undefined, query: [string, string | undefined][] = []): string => {
    const keyPath = key === undefined ? "" : "/" + key.split("/").map(encodeRfc3986).join("/");
    const origin = pathStyle ? r.endpoint.origin : `${r.endpoint.protocol}//${r.bucket}.${r.endpoint.host}`;
    const path = pathStyle ? `${basePath}/${encodeRfc3986(r.bucket)}${keyPath}` : `${basePath}${keyPath || "/"}`;
    const qs = query.map(([k, v]) => (v === undefined ? encodeRfc3986(k) : `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)).join("&");
    return origin + path + (qs ? `?${qs}` : "");
  };

  const send = async (op: string, method: string, url: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Response> => {
    const payload = body ?? new Uint8Array();
    const hash = await sha256Hex(payload);
    const signed = await signV4({ method, url, headers: { ...headers, "x-amz-content-sha256": hash }, payloadHash: hash, region: r.region, service: "s3", credentials: r.credentials });
    delete signed.headers.host; // fetch sets it (same value)
    try {
      return await fetchFn(url, { method, headers: signed.headers, body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : (payload as Uint8Array<ArrayBuffer>) });
    } catch (err) {
      throw new MiuError({
        code: "MIU_E_FILES_S3",
        status: 502,
        message: `S3 ${op} could not reach ${r.endpoint.origin}: ${String((err as Error)?.message ?? err)}`,
        fix: "Check S3_ENDPOINT (or endpoint) and that the service is reachable from here.",
        details: { endpoint: r.endpoint.origin },
        cause: err,
      });
    }
  };

  /** Read an S3 error response and throw the matching MiuError. */
  const fail = async (op: string, res: Response, partNumber?: number): Promise<never> => {
    const text = res.body && op !== "head" ? await res.text().catch(() => "") : "";
    const code = tag(text, "Code") ?? STATUS_CODES[res.status] ?? `HTTP${res.status}`;
    if (code === "NoSuchUpload") throw filesErrors.uploadNotFound();
    if (code === "InvalidPart" || code === "InvalidPartOrder") throw filesErrors.partInvalid(partNumber ?? "?");
    throw s3Error(op, res.status, code, tag(text, "Message") ?? "", r);
  };

  const metaHeaders = (o: StorePutOptions): Record<string, string> => {
    const h: Record<string, string> = { "content-type": o.contentType || DEFAULT_TYPE };
    for (const [k, v] of Object.entries(o.metadata ?? {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(k) || !/^[\x20-\x7e]*$/.test(v)) {
        throw filesErrors.badRequest(
          "METADATA_INVALID",
          `S3 metadata ${JSON.stringify(k)} must have a [A-Za-z0-9_-] name and a printable ASCII value`,
          "Use simple ASCII metadata (encode other text yourself, e.g. with encodeURIComponent). S3 also lowercases metadata names.",
        );
      }
      h[`x-amz-meta-${k.toLowerCase()}`] = v;
    }
    return h;
  };

  const info = (key: string, res: Response, size: number): StoredFile => {
    const metadata: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith("x-amz-meta-")) metadata[k.slice(11)] = v;
    });
    const lm = res.headers.get("last-modified");
    const type = res.headers.get("content-type");
    return { key, size, etag: unquote(res.headers.get("etag")), contentType: type && type !== "binary/octet-stream" ? type : DEFAULT_TYPE, metadata, uploaded: lm ? new Date(lm) : new Date() };
  };

  const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

  const head = async (key: string): Promise<StoredFile | null> => {
    const res = await send("head", "HEAD", urlFor(key));
    if (res.status === 404) return null;
    if (!res.ok) return fail("head", res);
    return info(key, res, Number(res.headers.get("content-length") ?? 0));
  };

  return {
    kind: "s3",
    async put(key, body, opts = {}) {
      const headers = metaHeaders(opts);
      const bytes = await collect(body); // S3 needs the length and hash up front; an erroring body sends nothing
      const res = await send("put", "PUT", urlFor(key), headers, bytes);
      if (!res.ok) return fail("put", res);
      await res.body?.cancel();
      return { key, size: bytes.byteLength, etag: unquote(res.headers.get("etag")), contentType: headers["content-type"], metadata: { ...opts.metadata }, uploaded: new Date() };
    },
    async get(key, opts = {}): Promise<FileObject | null> {
      const range = opts.range;
      if (range && range.length <= 0) {
        const h = await head(key);
        return h && { ...h, body: empty(), range: { offset: range.offset, length: 0 } };
      }
      const res = await send("get", "GET", urlFor(key), range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {});
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (res.status === 416) {
        await res.body?.cancel();
        const h = await head(key);
        return h && { ...h, body: empty(), range: { offset: range!.offset, length: 0 } };
      }
      if (!res.ok) return fail("get", res);
      const cr = res.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
      if (res.status === 206 && cr) {
        const size = cr[3] === "*" ? Number(cr[2]) + 1 : Number(cr[3]);
        return { ...info(key, res, size), body: res.body ?? empty(), range: { offset: Number(cr[1]), length: Number(cr[2]) - Number(cr[1]) + 1 } };
      }
      if (!range) return { ...info(key, res, Number(res.headers.get("content-length") ?? 0)), body: res.body ?? empty() };
      // The server ignored the Range header: cut the slice out of the stream, never reading past it.
      const total = Number(res.headers.get("content-length") ?? NaN);
      if (res.body && Number.isSafeInteger(total)) {
        const offset = Math.min(range.offset, total);
        const length = Math.min(range.length, total - offset);
        return { ...info(key, res, total), body: sliceStream(res.body, offset, length), range: { offset, length } };
      }
      const all = new Uint8Array(await res.arrayBuffer());
      const offset = Math.min(range.offset, all.byteLength);
      const slice = all.subarray(offset, Math.min(all.byteLength, offset + range.length));
      return { ...info(key, res, all.byteLength), body: new Response(slice).body!, range: { offset, length: slice.byteLength } };
    },
    head,
    async delete(key) {
      const res = await send("delete", "DELETE", urlFor(key));
      if (!res.ok && res.status !== 404) return fail("delete", res);
      await res.body?.cancel();
    },
    async list(opts = {}) {
      const query: [string, string | undefined][] = [["list-type", "2"]];
      if (opts.cursor) query.push(["continuation-token", opts.cursor]);
      query.push(["max-keys", String(opts.limit ?? 1000)]);
      if (opts.prefix) query.push(["prefix", opts.prefix]);
      const res = await send("list", "GET", urlFor(undefined, query));
      if (!res.ok) return fail("list", res);
      const xml = await res.text();
      const files: StoredFile[] = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
        const c = m[1];
        const lm = tag(c, "LastModified");
        return { key: tag(c, "Key") ?? "", size: Number(tag(c, "Size") ?? 0), etag: unquote(tag(c, "ETag")), contentType: DEFAULT_TYPE, metadata: {}, uploaded: lm ? new Date(lm) : new Date(0) };
      });
      const truncated = tag(xml, "IsTruncated") === "true";
      return { files, cursor: truncated ? tag(xml, "NextContinuationToken") : undefined };
    },
    async createMultipart(key, opts = {}) {
      const res = await send("create multipart upload", "POST", urlFor(key, [["uploads", undefined]]), metaHeaders(opts));
      if (!res.ok) return fail("create multipart upload", res);
      const id = tag(await res.text(), "UploadId");
      if (!id) throw s3Error("create multipart upload", res.status, "MalformedResponse", "no UploadId in the response", r);
      return id;
    },
    async uploadPart(key, uploadId, partNumber, body): Promise<UploadedPart> {
      const bytes = await collect(body);
      const res = await send("upload part", "PUT", urlFor(key, [["partNumber", String(partNumber)], ["uploadId", uploadId]]), {}, bytes);
      if (!res.ok) return fail("upload part", res, partNumber);
      await res.body?.cancel();
      return { partNumber, etag: unquote(res.headers.get("etag")) };
    },
    async completeMultipart(key, uploadId, parts) {
      const xml =
        "<CompleteMultipartUpload>" + parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${escapeXml(p.etag)}"</ETag></Part>`).join("") + "</CompleteMultipartUpload>";
      const res = await send("complete multipart upload", "POST", urlFor(key, [["uploadId", uploadId]]), { "content-type": "application/xml" }, new TextEncoder().encode(xml));
      if (!res.ok) return fail("complete multipart upload", res);
      const text = await res.text();
      // S3 can answer 200 and still fail: the error is in the body.
      if (/<Error>/.test(text)) return fail("complete multipart upload", new Response(text, { status: 500 }));
      const h = await head(key);
      if (!h) throw s3Error("complete multipart upload", 404, "NotFound", "the object is missing right after completing it", r);
      return h;
    },
    async abortMultipart(key, uploadId) {
      const res = await send("abort multipart upload", "DELETE", urlFor(key, [["uploadId", uploadId]]));
      if (res.ok || res.status === 404) {
        await res.body?.cancel();
        return;
      }
      await fail("abort multipart upload", res);
    },
  };
}

/**
 * Any S3-compatible object store: AWS S3, Cloudflare R2's S3 API, MinIO, Backblaze B2, ...
 * Requests are signed with AWS Signature V4 using WebCrypto, so it works on Workers, Bun, Deno
 * and Node. Settings fall back to S3_* env vars (and AWS_* for credentials); on Workers they are
 * read from the request env, so secrets can stay in `wrangler secret`.
 *
 * Notes: `put` and each multipart part are buffered to sign them (bounded by the files plugin's
 * `maxSize`; use multipart uploads for large files). `list` returns key, size, etag and date
 * only (ListObjectsV2 does not return content type or metadata). Metadata must be ASCII; S3
 * lowercases its names.
 */
export function s3Store(opts: S3StoreOptions = {}): FileStore {
  const pathStyle = opts.forcePathStyle ?? false;
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const byEnv = new WeakMap<object, FileStore>();
  let fromProcess: FileStore | undefined;
  const make = (env: Env) => bucketStore(resolve(opts, env), pathStyle, fetchFn);
  const proc = (): FileStore => (fromProcess ??= make({}));
  const lazy =
    <K extends keyof FileStore>(k: K) =>
    async (...a: unknown[]) =>
      ((proc()[k] as (...x: unknown[]) => unknown)(...a));

  const show = (n: Name): string => {
    const s = opts[n];
    return typeof s === "string" ? s : `$${names(s, n)[0]}`;
  };
  const cred = (n: "accessKeyId" | "secretAccessKey") => (typeof opts[n] === "string" ? "(inline)" : names(opts[n], n)[0]);
  return {
    kind: "s3",
    put: lazy("put") as FileStore["put"],
    get: lazy("get") as FileStore["get"],
    head: lazy("head") as FileStore["head"],
    delete: lazy("delete") as FileStore["delete"],
    list: lazy("list") as FileStore["list"],
    createMultipart: lazy("createMultipart") as FileStore["createMultipart"],
    uploadPart: lazy("uploadPart") as FileStore["uploadPart"],
    completeMultipart: lazy("completeMultipart") as FileStore["completeMultipart"],
    abortMultipart: lazy("abortMultipart") as FileStore["abortMultipart"],
    forEnv(env: Env) {
      if (typeof env !== "object" || env === null) return proc();
      let s = byEnv.get(env);
      if (!s) byEnv.set(env, (s = make(env)));
      return s;
    },
    inspect: () => ({
      endpoint: opts.endpoint === undefined ? `$S3_ENDPOINT` : show("endpoint"),
      region: show("region"),
      bucket: show("bucket"),
      forcePathStyle: pathStyle,
      credentials: typeof opts.accessKeyId === "string" && typeof opts.secretAccessKey === "string" ? "inline" : `env ${cred("accessKeyId")} / ${cred("secretAccessKey")}`,
    }),
  };
}
