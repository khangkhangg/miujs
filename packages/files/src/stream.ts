import { filesErrors } from "./errors.ts";

/** Anything `put` accepts as a body. */
export type FileBody = ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | Blob | string;

const enc = new TextEncoder();

export function toStream(body: FileBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  if (body instanceof Blob) return body.stream();
  const bytes = typeof body === "string" ? enc.encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
  return new ReadableStream({
    start(c) {
      if (bytes.length) c.enqueue(bytes);
      c.close();
    },
  });
}

/** Byte length when it is known without reading the body. */
export function knownSize(body: FileBody): number | undefined {
  if (typeof body === "string") return enc.encode(body).length;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return undefined;
}

/**
 * Pass bytes through until more than `max` have been seen, then error the stream with
 * TOO_LARGE and cancel the source, so an oversized upload is never read (or buffered) in full.
 */
export function limitStream(src: ReadableStream<Uint8Array>, max: number, onExceed: () => Error = () => filesErrors.tooLarge(max)): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) return c.close();
      seen += value.byteLength;
      if (seen > max) {
        reader.cancel().catch(() => {});
        c.error(onExceed());
        return;
      }
      c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Read the whole stream into one buffer. Callers bound its size with `limitStream`. */
export async function collect(src: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = src.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  return concat(chunks, total);
}

export function concat(chunks: Uint8Array[], total = chunks.reduce((n, c) => n + c.byteLength, 0)): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Read at least `n` bytes (or to the end), and return them plus a stream replaying everything. */
export async function peek(src: ReadableStream<Uint8Array>, n: number): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = src.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    total += r.value.byteLength;
  }
  const head = concat(chunks, total);
  let sentHead = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!sentHead) {
        sentHead = true;
        if (head.byteLength) c.enqueue(head);
        if (done) c.close();
        return;
      }
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, stream };
}

/**
 * Bytes `offset .. offset+length` of `src`, read lazily: bytes before the range are skipped as
 * they stream past, and the source is cancelled as soon as the range is complete.
 */
export function sliceStream(src: ReadableStream<Uint8Array>, offset: number, length: number): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let pos = 0;
  const end = offset + length;
  const finish = (c: ReadableStreamDefaultController<Uint8Array>) => {
    reader.cancel().catch(() => {});
    c.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      for (;;) {
        if (pos >= end) return finish(c);
        const { done, value } = await reader.read();
        if (done) return c.close();
        const from = pos;
        pos += value.byteLength;
        if (pos <= offset) continue;
        const a = Math.max(0, offset - from);
        const b = Math.min(value.byteLength, end - from);
        c.enqueue(a === 0 && b === value.byteLength ? value : value.subarray(a, b));
        if (pos >= end) finish(c);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
