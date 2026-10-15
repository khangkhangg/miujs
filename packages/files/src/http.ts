// HTTP details of serving files: ranges, conditional requests and safe headers.
import type { ByteRange } from "./store.ts";

/**
 * Parse a `Range` header against a file of `size` bytes.
 * - `null`: no usable single byte range (absent, malformed, multi-range): serve the whole file.
 * - `"unsatisfiable"`: well-formed but outside the file: 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  const first = a === "" ? undefined : Number(a);
  const last = b === "" ? undefined : Number(b);
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) {
    // Suffix range: the last N bytes.
    if (last === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(last!, size);
    return { offset: size - length, length };
  }
  if (last !== undefined && last < first) return null;
  if (first >= size) return "unsatisfiable";
  const end = last === undefined ? size - 1 : Math.min(last, size - 1);
  return { offset: first, length: end - first + 1 };
}

/** Does an `If-None-Match` header match this (unquoted) etag? Weak comparison, per RFC 9110. */
export function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const want = `"${etag}"`;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === want);
}

/** `If-Range`: only a matching strong etag keeps the range. Dates are not trusted. */
export function ifRangeMatches(header: string | null, etag: string): boolean {
  return header === null || header.trim() === `"${etag}"`;
}

/** Media type without parameters, lowercased: `"Image/PNG; x=1"` → `"image/png"`. */
export function essence(type: string | null | undefined): string {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

/** Types a browser may render inline from our origin without running script. */
export function inlineSafe(type: string): boolean {
  const t = essence(type);
  if (t === "image/svg+xml") return false;
  if (t.startsWith("image/") || t.startsWith("video/") || t.startsWith("audio/")) return true;
  return ["application/pdf", "text/plain", "application/octet-stream", "application/json", "model/gltf-binary", "model/gltf+json", "application/zip"].includes(t);
}

/** Remove what must never reach a header or a file name: path parts, quotes, control chars. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 200) || "download";
}

/** `attachment; filename="ascii"; filename*=UTF-8''utf8` (RFC 6266 / 5987). */
export function contentDisposition(name: string | undefined): string {
  if (name === undefined) return "attachment";
  const clean = cleanFilename(name);
  const ascii = clean
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[\\%]/g, "_");
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** No script, no subresources: a stored file can never act as a page on the app's origin. */
export const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
