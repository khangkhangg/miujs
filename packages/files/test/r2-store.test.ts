import { afterEach, describe, expect, test } from "bun:test";
import { r2Store } from "../src/r2.ts";
import { collect, toStream } from "../src/stream.ts";
import { FakeFixedLengthStream, fakeR2 } from "./fake-r2.ts";
import { str } from "./fixtures.ts";
import { storeSuite } from "./store-suite.ts";

describe("r2Store (binding)", () => {
  storeSuite(() => r2Store(fakeR2() as any));

  test("stores content type and metadata as R2 httpMetadata/customMetadata", async () => {
    const bucket = fakeR2();
    await r2Store(bucket as any).put("a.png", toStream("x"), { contentType: "image/png", metadata: { by: "u1" } });
    const o = bucket.objects.get("a.png")!;
    expect(o.httpMetadata.contentType).toBe("image/png");
    expect(o.customMetadata).toEqual({ by: "u1" });
  });

  test("list asks R2 to include metadata", async () => {
    const bucket = fakeR2();
    const st = r2Store(bucket as any);
    await st.put("a", toStream("1"), { contentType: "text/plain" });
    const { files } = await st.list({ prefix: "a" });
    expect(files[0].contentType).toBe("text/plain");
  });
});

describe("r2Store streaming", () => {
  const g = globalThis as any;
  afterEach(() => {
    delete g.FixedLengthStream;
  });

  test("with a known size and FixedLengthStream (Workers), streams instead of buffering", async () => {
    g.FixedLengthStream = FakeFixedLengthStream;
    const bucket = fakeR2();
    await r2Store(bucket as any).put("s", toStream("hello"), { size: 5 });
    expect(str(await collect((await bucket.get("s"))!.body))).toBe("hello");
  });

  test("a body longer than its declared size is rejected", async () => {
    g.FixedLengthStream = FakeFixedLengthStream;
    const bucket = fakeR2();
    await expect(r2Store(bucket as any).put("s", toStream("hello!"), { size: 5 })).rejects.toThrow();
    expect(bucket.objects.has("s")).toBe(false);
  });
});

describe("r2Store(name)", () => {
  test("resolves the binding from env per request", async () => {
    const bucket = fakeR2();
    const st = r2Store("FILES");
    const bound = st.forEnv!({ FILES: bucket });
    await bound.put("k", toStream("v"));
    expect(bucket.objects.has("k")).toBe(true);
    expect(st.forEnv!({ FILES: bucket })).toBe(bound);
  });

  test("a missing binding is a clear error", async () => {
    const st = r2Store("FILES");
    expect(() => st.forEnv!({})).toThrow(/FILES/);
    try {
      st.forEnv!({ FILES: "not a bucket" });
    } catch (err: any) {
      expect(err.code).toBe("MIU_E_FILES_BINDING");
      expect(err.fix).toContain("r2_buckets");
    }
    await expect(st.get("k")).rejects.toMatchObject({ code: "MIU_E_FILES_BINDING" });
  });

  test("inspect reports the binding", () => {
    expect(r2Store("FILES").inspect!()).toEqual({ binding: "FILES" });
  });
});
