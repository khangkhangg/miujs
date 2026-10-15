/**
 * Blob storage for uploads (panoramas, images, documents). Drivers: memory (dev/tests), local disk
 * (`miujs/node`), Cloudflare R2 (`miujs/cloudflare`). Keys are relative paths like `tours/t1/pano.jpg`.
 */
export interface BlobMeta {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  uploadedAt: string;
  metadata?: Record<string, string>;
}

export type BlobBody = ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | Blob | string;

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface GetOptions {
  /** Byte range; `length` omitted reads to the end. */
  range?: { offset: number; length?: number };
}

export interface BlobStore {
  put(key: string, body: BlobBody, opts?: PutOptions): Promise<BlobMeta>;
  /**
   * The blob's bytes (the requested range, if any). Drivers that can may also return `blob`, a lazy,
   * sized Blob with the same bytes; servers prefer it (Content-Length, sendfile) and cancel `body`.
   */
  get(key: string, opts?: GetOptions): Promise<{ meta: BlobMeta; body: ReadableStream<Uint8Array>; blob?: Blob } | undefined>;
  head(key: string): Promise<BlobMeta | undefined>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string, opts?: { cursor?: string; limit?: number }): Promise<{ items: BlobMeta[]; cursor?: string }>;
}

/** Rejects keys that could escape a storage root or confuse URL handling. Returns the key. */
export function assertSafeKey(key: string): string {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split("/").some((seg) => seg === ".." || seg === "." || seg === "")
  ) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** Read any supported body into bytes. */
export async function toBytes(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Strong etag: hex SHA-256 of the content (first 32 hex chars). */
export async function etagOf(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
