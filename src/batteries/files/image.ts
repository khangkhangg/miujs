/**
 * Image format and dimensions from the file's own header bytes (never trust the client's content-type).
 * Supports PNG, JPEG, WebP and GIF; SVG is deliberately not an image here (it can carry script).
 */
export interface ImageInfo {
  type: "png" | "jpeg" | "webp" | "gif";
  mime: string;
  width: number;
  height: number;
}

export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  const b = bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (i: number, sig: number[]) => sig.every((v, k) => b[i + k] === v);

  // PNG: signature + IHDR (big-endian width/height at 16/20)
  if (b.length >= 24 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && at(12, [0x49, 0x48, 0x44, 0x52])) {
    return ok("png", "image/png", dv.getUint32(16), dv.getUint32(20));
  }
  // GIF: "GIF87a"/"GIF89a" + little-endian width/height
  if (b.length >= 10 && at(0, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return ok("gif", "image/gif", dv.getUint16(6, true), dv.getUint16(8, true));
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk
  if (b.length >= 30 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X") {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return ok("webp", "image/webp", w, h);
    }
    if (chunk === "VP8 " && at(23, [0x9d, 0x01, 0x2a])) {
      return ok("webp", "image/webp", dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = dv.getUint32(21, true);
      return ok("webp", "image/webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return undefined;
  }
  // JPEG: walk markers until a SOFn (C0..CF except C4 DHT, C8 JPG, CC DAC)
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return undefined; // EOI / start of scan before SOF
      const len = dv.getUint16(i + 2);
      if (len < 2) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok("jpeg", "image/jpeg", dv.getUint16(i + 7), dv.getUint16(i + 5));
      }
      i += 2 + len;
    }
  }
  return undefined;
}

function ok(type: ImageInfo["type"], mime: string, width: number, height: number): ImageInfo | undefined {
  return width > 0 && height > 0 ? { type, mime, width, height } : undefined;
}

/** True for a plausible equirectangular panorama: ~2:1 aspect and at least 1024 px wide. */
export function isEquirectangular(dim: { width: number; height: number }, tolerance = 0.02): boolean {
  if (dim.width < 1024) return false;
  return Math.abs(dim.width / dim.height - 2) <= 2 * tolerance;
}
