// A small S3-compatible server on Bun.serve (port 0). It checks every request's SigV4 signature
// (credential scope, signed headers, payload hash, clock skew) the way S3 does, keeps objects in
// memory, and answers with S3's XML shapes and error codes. Path-style URLs only.
import { sha256Hex, signV4 } from "../src/sigv4.ts";

interface Obj {
  bytes: Uint8Array;
  etag: string;
  contentType?: string;
  meta: Record<string, string>;
  lastModified: Date;
}
interface Upload {
  key: string;
  contentType?: string;
  meta: Record<string, string>;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function error(status: number, code: string, message: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><RequestId>fake</RequestId></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { status, headers: { "content-type": "application/xml" } });

let seq = 0;
const newEtag = async (bytes: Uint8Array) => (await sha256Hex(bytes)).slice(0, 24) + (++seq).toString(16).padStart(8, "0");

export function fakeS3(opts: { accessKeyId: string; secretAccessKey: string; region: string; now?: () => number }) {
  const buckets = new Map<string, Map<string, Obj>>();
  const uploads = new Map<string, Upload>();
  const requests: SeenRequest[] = [];
  const now = opts.now ?? Date.now;

  const verify = async (req: Request, url: URL, body: Uint8Array): Promise<Response | null> => {
    const auth = req.headers.get("authorization");
    const m = auth?.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/);
    if (!m) return error(403, "AccessDenied", "Missing or malformed Authorization header");
    const [, key, day, region, service, signed, signature] = m;
    if (key !== opts.accessKeyId) return error(403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.");
    if (region !== opts.region) return error(400, "AuthorizationHeaderMalformed", `the region '${region}' is wrong; expecting '${opts.region}'`);
    if (service !== "s3") return error(400, "AuthorizationHeaderMalformed", "service must be s3");
    const stamp = req.headers.get("x-amz-date") ?? "";
    if (!stamp.startsWith(day)) return error(403, "SignatureDoesNotMatch", "credential date does not match x-amz-date");
    const when = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15));
    if (!Number.isFinite(when) || Math.abs(now() - when) > 15 * 60_000) return error(403, "RequestTimeTooSkewed", "The difference between the request time and the current time is too large.");
    const names = signed.split(";");
    for (const required of ["host", "x-amz-date", "x-amz-content-sha256"]) if (!names.includes(required)) return error(403, "AccessDenied", `${required} must be signed`);
    const payloadHash = req.headers.get("x-amz-content-sha256")!;
    if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== (await sha256Hex(body))) return error(400, "XAmzContentSHA256Mismatch", "The provided 'x-amz-content-sha256' header does not match what was computed.");
    const headers: Record<string, string> = {};
    for (const n of names) {
      if (n === "host" || n === "x-amz-date" || n === "x-amz-security-token") continue;
      const v = req.headers.get(n);
      if (v === null) return error(403, "SignatureDoesNotMatch", `signed header ${n} is missing`);
      headers[n] = v;
    }
    const expected = await signV4({
      method: req.method,
      url,
      headers,
      payloadHash,
      region,
      service,
      credentials: { accessKeyId: key, secretAccessKey: opts.secretAccessKey, sessionToken: req.headers.get("x-amz-security-token") ?? undefined },
      date: new Date(when),
    });
    if (expected.signature !== signature) return error(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
    return null;
  };

  const metaOf = (req: Request) => {
    const meta: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (k.startsWith("x-amz-meta-")) meta[k.slice(11)] = v;
    });
    return meta;
  };
  const objectHeaders = (o: Obj): Record<string, string> => {
    const h: Record<string, string> = { etag: `"${o.etag}"`, "last-modified": o.lastModified.toUTCString(), "content-type": o.contentType ?? "binary/octet-stream", "accept-ranges": "bytes" };
    for (const [k, v] of Object.entries(o.meta)) h[`x-amz-meta-${k}`] = v;
    return h;
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    const seen: Record<string, string> = {};
    req.headers.forEach((v, k) => (seen[k] = v));
    requests.push({ method: req.method, url: req.url, headers: seen });
    const denied = await verify(req, url, body);
    if (denied) return denied;

    const [, bucketName, ...rest] = url.pathname.split("/");
    const key = rest.map((s) => decodeURIComponent(s)).join("/");
    const bucket = buckets.get(decodeURIComponent(bucketName ?? ""));
    if (!bucket) return error(404, "NoSuchBucket", "The specified bucket does not exist");
    const q = url.searchParams;

    if (!key) {
      if (req.method !== "GET" || q.get("list-type") !== "2") return error(400, "InvalidRequest", "fake: only ListObjectsV2 on a bucket");
      const prefix = q.get("prefix") ?? "";
      const max = Math.min(1000, Number(q.get("max-keys") ?? 1000));
      const after = q.get("continuation-token") ? atob(q.get("continuation-token")!) : (q.get("start-after") ?? "");
      const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      const contents = page
        .map((k) => {
          const o = bucket.get(k)!;
          return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        })
        .join("");
      return xml(
        `<ListBucketResult><Name>${bucketName}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${
          truncated ? `<NextContinuationToken>${btoa(page[page.length - 1])}</NextContinuationToken>` : ""
        }</ListBucketResult>`,
      );
    }

    if (q.has("uploads") && req.method === "POST") {
      const id = crypto.randomUUID().replace(/-/g, "");
      uploads.set(id, { key, contentType: req.headers.get("content-type") ?? undefined, meta: metaOf(req), parts: new Map() });
      return xml(`<InitiateMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (q.has("uploadId")) {
      const id = q.get("uploadId")!;
      const u = uploads.get(id);
      if (!u || u.key !== key) return error(404, "NoSuchUpload", "The specified upload does not exist.");
      if (req.method === "PUT") {
        const n = Number(q.get("partNumber"));
        if (!Number.isInteger(n) || n < 1 || n > 10000) return error(400, "InvalidArgument", "Part number must be an integer between 1 and 10000");
        const etag = await newEtag(body);
        u.parts.set(n, { bytes: body, etag });
        return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
      }
      if (req.method === "DELETE") {
        uploads.delete(id);
        return new Response(null, { status: 204 });
      }
      if (req.method === "POST") {
        const text = new TextDecoder().decode(body);
        const parts = [...text.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]*)<\/ETag>\s*<\/Part>/g)].map((x) => ({ n: Number(x[1]), etag: xmlUnescape(x[2]).replace(/"/g, "") }));
        if (!parts.length) return error(400, "MalformedXML", "The XML you provided was not well-formed");
        const chunks: Uint8Array[] = [];
        let last = 0;
        for (const p of parts) {
          if (p.n <= last) return error(400, "InvalidPartOrder", "The list of parts was not in ascending order.");
          last = p.n;
          const got = u.parts.get(p.n);
          if (!got || got.etag !== p.etag) return error(400, "InvalidPart", "One or more of the specified parts could not be found.");
          chunks.push(got.bytes);
        }
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.byteLength;
        }
        const etag = (await newEtag(all)) + `-${parts.length}`;
        bucket.set(key, { bytes: all, etag, contentType: u.contentType, meta: u.meta, lastModified: new Date(now()) });
        uploads.delete(id);
        // Like S3: a 200 whose body could also have been an <Error>.
        return xml(`<CompleteMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${xmlEscape(key)}</Key><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`);
      }
    }

    if (req.method === "PUT") {
      bucket.set(key, { bytes: body, etag: await newEtag(body), contentType: req.headers.get("content-type") ?? undefined, meta: metaOf(req), lastModified: new Date(now()) });
      return new Response(null, { status: 200, headers: { etag: `"${bucket.get(key)!.etag}"` } });
    }
    if (req.method === "DELETE") {
      bucket.delete(key);
      return new Response(null, { status: 204 });
    }
    const o = bucket.get(key);
    if (req.method === "HEAD") {
      if (!o) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { ...objectHeaders(o), "content-length": String(o.bytes.byteLength) } });
    }
    if (req.method === "GET") {
      if (!o) return error(404, "NoSuchKey", "The specified key does not exist.");
      const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const size = o.bytes.byteLength;
        const start = Number(range[1]);
        if (start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
        const end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
        return new Response(o.bytes.slice(start, end + 1) as Uint8Array<ArrayBuffer>, { status: 206, headers: { ...objectHeaders(o), "content-range": `bytes ${start}-${end}/${size}` } });
      }
      return new Response(o.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: objectHeaders(o) });
    }
    return error(405, "MethodNotAllowed", "fake: method not allowed");
  };

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  return {
    url: `http://127.0.0.1:${server.port}`,
    buckets,
    uploads,
    requests,
    createBucket(name: string) {
      buckets.set(name, new Map());
    },
    stop: () => server.stop(true),
  };
}
