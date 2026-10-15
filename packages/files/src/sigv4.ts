// AWS Signature Version 4 with WebCrypto only, so it runs on Workers, Bun, Deno and Node.
// Checked against AWS's published test vectors (test/sigv4.test.ts).

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string | URL;
  /** Headers to send and sign. `host`, `x-amz-date` (and the session token) are added. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  date?: Date;
}

export interface Signed {
  /** Lowercase header names, including `authorization`. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const enc = new TextEncoder();

const hex = (buf: ArrayBuffer): string => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, "0");
  return s;
};

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : (data as Uint8Array<ArrayBuffer>)));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** Percent-encode everything except RFC 3986 unreserved characters (A-Z a-z 0-9 - . _ ~). */
export function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** S3-style canonical URI: each path segment decoded once and re-encoded strictly. */
export function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => encodeRfc3986(decode(seg)))
    .join("/") || "/";
}

export function canonicalQuery(search: string): string {
  const q = search.startsWith("?") ? search.slice(1) : search;
  if (!q) return "";
  return q
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const i = p.indexOf("=");
      const k = i < 0 ? p : p.slice(0, i);
      const v = i < 0 ? "" : p.slice(i + 1);
      return [encodeRfc3986(decode(k)), encodeRfc3986(decode(v))] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** `20150830T123600Z` */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Sign a request. Returns the headers to send (lowercase) and the intermediate strings. */
export async function signV4(input: SignInput): Promise<Signed> {
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const stamp = amzDate(input.date ?? new Date());
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers["x-amz-date"] = stamp;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(url.pathname), canonicalQuery(url.search), canonicalHeaders, signedHeaders, input.payloadHash].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(enc.encode("AWS4" + input.credentials.secretAccessKey), day);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
