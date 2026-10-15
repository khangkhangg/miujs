// The pluggable asset-processing interface. A processor turns an uploaded source (an
// equirectangular panorama, a glTF binary) into what the viewer streams (multires tiles,
// a compressed model). Processors run inside queue jobs, never in a request.
//
// Cloudflare Workers have tight CPU limits (tens of ms to a few minutes of CPU per invocation,
// 128 MB of memory): tiling a 100-megapixel panorama or Draco-compressing a model does not fit.
// On Workers, use a processor that does the work elsewhere: externalProcessor() (your own
// container or server running vips / gltf-transform) or cloudflareImagesProcessor(). The
// CLI-based processors (vipsProcessor, gltfTransformProcessor) only run on Bun/Node/Deno hosts.
import type { Env, Logger } from "miujs";
import type { FileStore } from "@miujs/files";
import { tourErrors } from "./errors.ts";
import type { Asset } from "./store.ts";

/** Cube faces in Marzipano order: front, back, left, right, up, down. */
export const CUBE_FACES = ["f", "b", "l", "r", "u", "d"] as const;

/**
 * What a panorama processor produced. Tile keys follow fixed patterns under `prefix`:
 * - `cube`: `${prefix}/${level}/${face}/${row}_${col}.${ext}` (level 0 = smallest; faces f b l r u d).
 * - `equirect-tiles`: `${prefix}/${level}/${row}_${col}.${ext}`.
 * - `equirect`: whole images at several widths (by key in the store, or by URL on a CDN).
 */
export type PanoramaResult =
  | {
      layout: "cube";
      prefix: string;
      ext: "jpg" | "webp" | "png";
      tileSize: number;
      /** Edge of one face at the largest level, in pixels. */
      faceSize: number;
      /** Smallest first. `size` = face edge in pixels at that level. */
      levels: { size: number }[];
      /** A small equirectangular or cube-strip preview shown while tiles load. */
      preview?: string;
    }
  | {
      layout: "equirect-tiles";
      prefix: string;
      ext: "jpg" | "webp" | "png";
      tileSize: number;
      /** Smallest first. */
      levels: { width: number; cols: number; rows: number }[];
      preview?: string;
    }
  | {
      layout: "equirect";
      /** Smallest first. Each has a store `key` or an absolute https `url`. */
      sources: { width: number; key?: string; url?: string }[];
      preview?: string;
    };

export interface ModelResult {
  layout: "glb";
  /** The optimized model in the store, or `url` when it lives on a CDN. */
  key?: string;
  url?: string;
  bytes?: number;
  originalBytes?: number;
  /** Decoders the viewer needs: "draco", "meshopt", "ktx2". */
  requires?: ("draco" | "meshopt" | "ktx2")[];
}

/** The work finishes elsewhere; the result arrives later at POST /tours/_processor/callback. */
export interface DeferredResult {
  deferred: true;
}

export interface ProcessorContext {
  asset: Asset;
  tour: { id: string; slug: string };
  /** Write outputs under this prefix only. Unique per run, so cached tiles never go stale. */
  outputPrefix: string;
  /** The tour's file store (already resolved for this env). */
  store: FileStore;
  read(key: string): Promise<Uint8Array>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  write(key: string, body: Uint8Array | ReadableStream<Uint8Array> | string, contentType?: string): Promise<void>;
  /** 0..1, shown in the manifest and GET /tours/:tour/assets. */
  progress(fraction: number): Promise<void>;
  /** Where externalProcessor tells the remote worker to report back (null without a known origin). */
  callbackUrl: string | null;
  attempt: number;
  env: Env;
  log: Logger;
}

export interface TourProcessor {
  readonly name: string;
  /** equirectangular panorama → tiles (or variants). */
  tilePanorama?(ctx: ProcessorContext): Promise<PanoramaResult | DeferredResult>;
  /** glTF binary → compressed glb (Draco/meshopt geometry, KTX2 textures). */
  optimizeModel?(ctx: ProcessorContext): Promise<ModelResult | DeferredResult>;
  /** Spawns programs (vips, npx): cannot run on Cloudflare Workers. */
  readonly needsProcess?: boolean;
  /** Secrets the callback route accepts for this processor's deferred results. */
  readonly callbackSecrets?: readonly string[];
  /** Shown in `miu inspect`. Never secrets. */
  inspect?(): Record<string, unknown>;
}

export type ProcessingStep = "tilePanorama" | "optimizeModel";

export function pickProcessor(processors: readonly TourProcessor[], step: ProcessingStep): TourProcessor | undefined {
  return processors.find((p) => typeof p[step] === "function");
}

export function isDeferred(v: unknown): v is DeferredResult {
  return typeof v === "object" && v !== null && (v as DeferredResult).deferred === true;
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const EXTS = ["jpg", "webp", "png"];

function under(prefix: string, key: unknown): key is string {
  return typeof key === "string" && key.startsWith(prefix + "/") && !key.split("/").includes("..");
}

function httpsUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Checks a processor's result before it is stored and served. Throws MIU_E_TOUR_PROCESSOR_RESULT_INVALID. */
export function checkResult(step: ProcessingStep, name: string, outputPrefix: string, r: unknown): PanoramaResult | ModelResult {
  const bad = (why: string) => tourErrors.resultInvalid(name, why);
  if (typeof r !== "object" || r === null) throw bad("not an object");
  const o = r as Record<string, any>;
  if (o.preview !== undefined && !under(outputPrefix, o.preview)) throw bad("preview must be a key under outputPrefix");
  if (step === "optimizeModel") {
    if (o.layout !== "glb") throw bad('layout must be "glb"');
    if (!(under(outputPrefix, o.key) || (o.key === undefined && httpsUrl(o.url)))) throw bad("key must be under outputPrefix (or give an https url)");
    return o as ModelResult;
  }
  if (o.layout === "cube" || o.layout === "equirect-tiles") {
    if (o.prefix !== outputPrefix && !under(outputPrefix, o.prefix)) throw bad("prefix must be outputPrefix or under it");
    if (!EXTS.includes(o.ext)) throw bad(`ext must be one of ${EXTS.join(", ")}`);
    if (!posInt(o.tileSize)) throw bad("tileSize must be a positive integer");
    if (!Array.isArray(o.levels) || o.levels.length === 0 || o.levels.length > 12) throw bad("levels must list 1-12 levels");
    if (o.layout === "cube") {
      if (!posInt(o.faceSize)) throw bad("faceSize must be a positive integer");
      if (!o.levels.every((l: any) => posInt(l?.size))) throw bad("each cube level needs a positive integer size");
    } else if (!o.levels.every((l: any) => posInt(l?.width) && posInt(l?.cols) && posInt(l?.rows))) {
      throw bad("each equirect level needs positive integer width, cols and rows");
    }
    return o as PanoramaResult;
  }
  if (o.layout === "equirect") {
    if (!Array.isArray(o.sources) || o.sources.length === 0) throw bad("sources must not be empty");
    for (const s of o.sources) {
      if (!posInt(s?.width)) throw bad("each source needs a positive integer width");
      if (!(under(outputPrefix, s.key) || (s.key === undefined && httpsUrl(s.url)))) throw bad("each source needs a key under outputPrefix or an https url");
    }
    return o as PanoramaResult;
  }
  throw bad('layout must be "cube", "equirect-tiles" or "equirect"');
}
