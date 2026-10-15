/** Minimal file headers (magic bytes) padded with zeros. */
export const b = (...xs: (number | string)[]) => {
  const out: number[] = [];
  for (const x of xs) {
    if (typeof x === "number") out.push(x);
    else for (const c of x) out.push(c.charCodeAt(0));
  }
  return new Uint8Array([...out, ...new Array(16).fill(0)]);
};

export const samples = {
  png: b(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a),
  jpeg: b(0xff, 0xd8, 0xff, 0xe0),
  webp: b("RIFF", 0, 0, 0, 0, "WEBP"),
  gif: b("GIF89a"),
  pdf: b("%PDF-1.7"),
  glb: b("glTF", 2, 0, 0, 0),
  mp4: b(0, 0, 0, 0x20, "ftypisom"),
  zip: b("PK", 3, 4),
};

export const text = (s: string) => new TextEncoder().encode(s);
export const str = (u: Uint8Array) => new TextDecoder().decode(u);
