import { describe, expect, test } from "bun:test";
import { collect, limitStream, peek, toStream } from "../src/stream.ts";

function chunked(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      onPull?.();
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

describe("stream helpers", () => {
  test("limitStream passes data under the limit", async () => {
    const s = chunked([new Uint8Array(3), new Uint8Array(3)]);
    expect((await collect(limitStream(s, 6))).length).toBe(6);
  });

  test("limitStream errors with TOO_LARGE once the limit is passed, without reading the rest", async () => {
    let pulls = 0;
    const s = chunked(Array.from({ length: 100 }, () => new Uint8Array(10)), () => pulls++);
    try {
      await collect(limitStream(s, 25));
      throw new Error("did not throw");
    } catch (err: any) {
      expect(err.code).toBe("MIU_E_FILES_TOO_LARGE");
    }
    expect(pulls).toBeLessThan(10);
  });

  test("peek returns the first bytes and a stream that still yields everything", async () => {
    const s = chunked([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])]);
    const { head, stream } = await peek(s, 4);
    expect([...head]).toEqual([1, 2, 3, 4, 5]);
    expect([...(await collect(stream))]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("peek on a short stream", async () => {
    const { head, stream } = await peek(chunked([new Uint8Array([9])]), 16);
    expect([...head]).toEqual([9]);
    expect([...(await collect(stream))]).toEqual([9]);
  });

  test("toStream accepts strings, bytes, buffers, blobs and streams", async () => {
    for (const body of ["hi", new Uint8Array([104, 105]), new Uint8Array([104, 105]).buffer, new Blob(["hi"]), chunked([new Uint8Array([104, 105])])]) {
      expect(new TextDecoder().decode(await collect(toStream(body as any)))).toBe("hi");
    }
  });
});
