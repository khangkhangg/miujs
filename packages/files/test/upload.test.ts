import { describe, expect, test } from "bun:test";
import { collect } from "../src/stream.ts";
import { samples, text } from "./fixtures.ts";
import { makeApp } from "./helpers.ts";

const form = (entries: [string, Uint8Array, string, string?][]) => {
  const fd = new FormData();
  for (const [field, bytes, name, type] of entries) fd.append(field, new File([bytes as Uint8Array<ArrayBuffer>], name, { type: type ?? "application/octet-stream" }));
  return fd;
};

const png = samples.png;
const KB = 1024;

describe("ctx.files.handleUpload", () => {
  test("stores a multipart file under a generated key, typed from its bytes", async () => {
    const { inCtx, store } = makeApp();
    const out = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png", "jpeg"] }), {
      body: form([["file", png, "cat.png", "text/html"]]),
    });
    expect(out.length).toBe(1);
    expect(out[0].key).toMatch(/^uploads\/[0-9a-f]{32}\.png$/);
    expect(out[0]).toMatchObject({ size: png.length, contentType: "image/png", filename: "cat.png" });
    const stored = (await store.get(out[0].key))!;
    expect(stored.contentType).toBe("image/png");
    expect(stored.metadata.filename).toBe("cat.png");
    expect([...(await collect(stored.body))]).toEqual([...png]);
  });

  test("rejects a file whose bytes don't match an allowed type, whatever the client claims", async () => {
    const { inCtx, store } = makeApp();
    const html = text("<!doctype html><script>alert(1)</script>");
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] }), { body: form([["file", html, "cat.png", "image/png"]]) }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_TYPE_NOT_ALLOWED", status: 415 });
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] }), { body: form([["file", samples.jpeg, "x.png", "image/png"]]) }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_TYPE_NOT_ALLOWED" });
    expect((await store.list()).files).toEqual([]);
  });

  test.each(Object.entries(samples))("accepts %s when allowed", async (name, bytes) => {
    const { inCtx } = makeApp();
    const out = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: [name] }), { body: form([["file", bytes, `f.${name}`]]) });
    expect(out[0].contentType).toBe((await import("../src/sniff.ts")).KNOWN_TYPES[name]);
  });

  test("a multipart file over maxSize is 413 and nothing is stored", async () => {
    const { inCtx, store } = makeApp();
    const big = new Uint8Array(2 * KB);
    big.set(png);
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] }), { body: form([["file", big, "big.png"]]) }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_TOO_LARGE", status: 413 });
    expect((await store.list()).files).toEqual([]);
  });

  test("an oversized multipart body is refused while streaming, before parsing", async () => {
    const { inCtx } = makeApp();
    let pulled = 0;
    const boundary = "----miu";
    const head = text(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled === 1) c.enqueue(head);
        else if (pulled > 10_000) c.close();
        else c.enqueue(new Uint8Array(KB));
      },
    });
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: 4 * KB, allowedTypes: ["png"] }), {
        body,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        duplex: "half",
      } as RequestInit),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_TOO_LARGE" });
    expect(pulled).toBeLessThan(200);
  });

  test("raw body upload", async () => {
    const { inCtx, store } = makeApp();
    const out = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["glb"] }), {
      body: samples.glb,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(out[0].key).toMatch(/^uploads\/[0-9a-f]{32}\.glb$/);
    expect(out[0].contentType).toBe("model/gltf-binary");
    expect((await store.head(out[0].key))!.size).toBe(samples.glb.length);
  });

  test("a raw body over maxSize is aborted while streaming", async () => {
    const { inCtx, store } = makeApp();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled === 1) c.enqueue(png);
        else if (pulled > 10_000) c.close();
        else c.enqueue(new Uint8Array(KB));
      },
    });
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: 4 * KB, allowedTypes: ["png"] }), { body, duplex: "half" } as RequestInit),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_TOO_LARGE" });
    expect(pulled).toBeLessThan(50);
    expect((await store.list()).files).toEqual([]);
  });

  test("a raw body with a declared Content-Length over maxSize is refused up front", async () => {
    const { inCtx } = makeApp();
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: 4, allowedTypes: ["png"] }), { body: png }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_TOO_LARGE" });
  });

  test("an empty raw body is NO_FILE", async () => {
    const { inCtx } = makeApp();
    await expect(inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] }))).rejects.toMatchObject({ code: "MIU_E_FILES_NO_FILE", status: 400 });
  });

  test("uses the `field` option; a missing field is NO_FILE", async () => {
    const { inCtx } = makeApp();
    const out = await inCtx((ctx) => ctx.files.handleUpload(ctx, { field: "avatar", maxSize: KB, allowedTypes: ["png"] }), { body: form([["avatar", png, "me.png"]]) });
    expect(out.length).toBe(1);
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] }), { body: form([["avatar", png, "me.png"]]) }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_NO_FILE" });
  });

  test("several files up to maxFiles (default 1)", async () => {
    const { inCtx } = makeApp();
    const two = () => form([["file", png, "a.png"], ["file", samples.jpeg, "b.jpg"]]);
    await expect(inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png", "jpeg"] }), { body: two() })).rejects.toMatchObject({
      code: "MIU_E_FILES_TOO_MANY_FILES",
    });
    const out = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png", "jpeg"], maxFiles: 2 }), { body: two() });
    expect(out.map((f) => f.contentType)).toEqual(["image/png", "image/jpeg"]);
  });

  test("if one of several files is rejected, none are kept", async () => {
    const { inCtx, store } = makeApp();
    const body = form([["file", png, "a.png"], ["file", text("nope nope nope nope"), "b.png"]]);
    await expect(inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"], maxFiles: 2 }), { body })).rejects.toMatchObject({
      code: "MIU_E_FILES_TYPE_NOT_ALLOWED",
    });
    expect((await store.list()).files).toEqual([]);
  });

  test("prefix and key options; keys are validated", async () => {
    const { inCtx } = makeApp();
    const a = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"], prefix: "avatars/u1/" }), { body: form([["file", png, "a.png"]]) });
    expect(a[0].key).toMatch(/^avatars\/u1\/[0-9a-f]{32}\.png$/);
    const b = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"], key: (f) => `fixed/me${f.ext}` }), { body: form([["file", png, "a.png"]]) });
    expect(b[0].key).toBe("fixed/me.png");
    await expect(
      inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"], key: (f) => `../${f.filename}` }), { body: form([["file", png, "a.png"]]) }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_KEY_INVALID" });
  });

  test("client file names are cleaned and never used as keys", async () => {
    const { inCtx } = makeApp();
    const out = await inCtx((ctx) => ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] }), { body: form([["file", png, '..\\..\\evil"\r\n.png']]) });
    // (FormData percent-encodes the quote and CRLF on the wire; cleanFilename is unit-tested in http.test.ts.)
    expect(out[0].filename).toMatch(/^evil[^"\r\n\\/]*\.png$/);
    expect(out[0].key).not.toContain("evil");
  });

  test("options are validated", async () => {
    const { inCtx } = makeApp();
    for (const o of [{ allowedTypes: ["png"] }, { maxSize: KB }, { maxSize: KB, allowedTypes: ["exe"] }, { maxSize: -1, allowedTypes: ["png"] }]) {
      await expect(inCtx((ctx) => ctx.files.handleUpload(ctx, o as any), { body: png })).rejects.toMatchObject({ code: "MIU_E_FILES_CONFIG" });
    }
  });

  test("a body that was already read is a clear error", async () => {
    const { inCtx } = makeApp();
    await expect(
      inCtx(async (ctx) => {
        await ctx.req.arrayBuffer();
        return ctx.files.handleUpload(ctx, { maxSize: KB, allowedTypes: ["png"] });
      }, { body: png }),
    ).rejects.toMatchObject({ code: "MIU_E_FILES_BODY_USED" });
  });
});
