import { filesErrors } from "./errors.ts";

/** Types `handleUpload` can recognize from their bytes, by short name. */
export const KNOWN_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  glb: "model/gltf-binary",
  mp4: "video/mp4",
  zip: "application/zip",
};

export const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "model/gltf-binary": ".glb",
  "video/mp4": ".mp4",
  "application/zip": ".zip",
};

/** Bytes `sniff` needs to see. */
export const SNIFF_BYTES = 16;

const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "mmp4", "MSNV"]);

function ascii(b: Uint8Array, at: number, s: string): boolean {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

/**
 * The real type of a file from its first bytes, or `null` when it is not one of the known
 * types. Never trusts names or client-sent content types.
 */
export function sniff(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, "PNG") && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  if (ascii(b, 0, "%PDF-")) return "application/pdf";
  if (ascii(b, 0, "glTF")) return "model/gltf-binary";
  if (ascii(b, 4, "ftyp") && b.length >= 12 && MP4_BRANDS.has(String.fromCharCode(b[8], b[9], b[10], b[11]))) return "video/mp4";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))) return "application/zip";
  return null;
}

/** Turn `["png", "image/jpeg"]` into mime types, rejecting anything `sniff` cannot detect. */
export function normalizeAllowed(list: readonly string[]): string[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw filesErrors.config("CONFIG", "allowedTypes must list at least one type", `Pass allowedTypes such as ["png", "jpeg", "webp"]. Known: ${Object.keys(KNOWN_TYPES).join(", ")}.`);
  }
  const known = new Set(Object.values(KNOWN_TYPES));
  const out: string[] = [];
  for (const raw of list) {
    const t = String(raw).toLowerCase();
    const mime = KNOWN_TYPES[t] ?? (known.has(t) ? t : undefined);
    if (!mime) {
      throw filesErrors.config("CONFIG", `allowedTypes contains ${JSON.stringify(raw)}, which cannot be detected from file contents`, `Use only: ${Object.keys(KNOWN_TYPES).join(", ")} (or their mime types).`);
    }
    if (!out.includes(mime)) out.push(mime);
  }
  return out;
}
