const UTF8 = "; charset=utf-8";

const TYPES: Record<string, string> = {
  // Web
  html: "text/html" + UTF8,
  htm: "text/html" + UTF8,
  js: "text/javascript" + UTF8,
  mjs: "text/javascript" + UTF8,
  cjs: "text/javascript" + UTF8,
  css: "text/css" + UTF8,
  json: "application/json" + UTF8,
  map: "application/json" + UTF8,
  webmanifest: "application/manifest+json",
  txt: "text/plain" + UTF8,
  md: "text/markdown" + UTF8,
  csv: "text/csv" + UTF8,
  xml: "application/xml" + UTF8,
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
  // Images
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  // 3D
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  bin: "application/octet-stream",
  ktx2: "image/ktx2",
  basis: "application/octet-stream",
  drc: "application/octet-stream",
  hdr: "image/vnd.radiance",
  exr: "image/x-exr",
  usdz: "model/vnd.usdz+zip",
  obj: "model/obj",
  stl: "model/stl",
  // Media
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  ts: "video/mp2t",
  m3u8: "application/vnd.apple.mpegurl",
  mpd: "application/dash+xml",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  vtt: "text/vtt" + UTF8,
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

/** MIME type for a file name, `application/octet-stream` when unknown. Text types include charset. */
export function mimeType(name: string): string {
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  if (dot <= slash) return "application/octet-stream";
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
