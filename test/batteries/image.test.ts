import { describe, expect, test } from "bun:test";
import { imageInfo, isEquirectangular } from "../../src/batteries/files/index.ts";

// Minimal real headers: PNG IHDR, baseline JPEG SOF0, WebP VP8X/VP8/VP8L.
function png(w: number, h: number) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number) {
  // SOI, APP0 (len 16), SOF0 (len 17)
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}
function webpVp8x(w: number, h: number) {
  const b = new Uint8Array(30);
  b.set([...new TextEncoder().encode("RIFF"), 22, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0]);
  const W = w - 1, H = h - 1;
  b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24);
  return b;
}

describe("imageInfo", () => {
  test("PNG", () => expect(imageInfo(png(4096, 2048))).toEqual({ type: "png", mime: "image/png", width: 4096, height: 2048 }));
  test("JPEG with APP0 before SOF", () =>
    expect(imageInfo(jpeg(8000, 4000))).toEqual({ type: "jpeg", mime: "image/jpeg", width: 8000, height: 4000 }));
  test("WebP VP8X", () => expect(imageInfo(webpVp8x(6000, 3000))).toEqual({ type: "webp", mime: "image/webp", width: 6000, height: 3000 }));
  test("non-images and truncated data return undefined", () => {
    expect(imageInfo(new TextEncoder().encode("MZ\x90\x00 not an image"))).toBeUndefined();
    expect(imageInfo(png(10, 10).subarray(0, 20))).toBeUndefined();
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined();
    expect(imageInfo(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
  });
});

describe("isEquirectangular", () => {
  test("2:1 within tolerance", () => {
    expect(isEquirectangular({ width: 4096, height: 2048 })).toBe(true);
    expect(isEquirectangular({ width: 4000, height: 1999 })).toBe(true);
    expect(isEquirectangular({ width: 4000, height: 3000 })).toBe(false);
    expect(isEquirectangular({ width: 512, height: 256 })).toBe(false); // too small for a panorama
  });
});
