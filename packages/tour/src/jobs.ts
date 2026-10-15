// Asset processing on @miujs/queue. One job per step; each run picks a processor, records
// state (queued → processing → ready | failed) and progress on the asset row, and validates the
// processor's result before the manifest serves it.
import { isMiuError, t, type Env, type Logger } from "miujs";
import { checkKey, type FileStore } from "@miujs/files";
import { defineJob, type JobDef } from "@miujs/queue";
import { aggregateAll } from "./analytics.ts";
import { tourErrors } from "./errors.ts";
import { checkResult, isDeferred, pickProcessor, type ProcessingStep, type ProcessorContext } from "./processor.ts";
import type { TourRuntime } from "./runtime.ts";
import type { Asset, AssetKind, TourStore } from "./store.ts";

export interface AssetJobInput {
  assetId: string;
  /** Public origin of the app, for processor callbacks. */
  origin?: string;
}

export interface TourJobs {
  /** equirectangular panorama → multires tiles (or variants). */
  tilePanorama: JobDef<AssetJobInput>;
  /** glTF binary → Draco/meshopt geometry + KTX2 textures. */
  optimizeModel: JobDef<AssetJobInput>;
  /** Daily analytics rollup and raw-event pruning: `schedule("15 0 * * *", tours.jobs.aggregateStats)`. */
  aggregateStats: JobDef<{ tourId?: string }>;
  /** Every tour job, for `queue({ jobs: [...tours.jobs.all] })`. */
  all: JobDef<any>[];
}

export const STEP_FOR: Record<AssetKind, ProcessingStep | null> = { pano: "tilePanorama", model: "optimizeModel", image: null };
export const JOB_NAMES: Record<ProcessingStep, string> = { tilePanorama: "tour-tile-panorama", optimizeModel: "tour-optimize-model" };

/** Errors that another attempt cannot fix: fail the asset at once instead of retrying. */
const PERMANENT = new Set([
  "MIU_E_TOUR_PROCESSOR_MISSING",
  "MIU_E_TOUR_PROCESSOR_UNAVAILABLE",
  "MIU_E_TOUR_PROCESSOR_RESULT_INVALID",
  "MIU_E_TOUR_SOURCE_MISSING",
  "MIU_E_FILES_KEY_INVALID",
]);

/** Where a run writes its output. Unique per run, so cached tiles of an older run never go stale. */
export function outputPrefix(asset: Pick<Asset, "tourId" | "id">, run: number): string {
  return `tours/${asset.tourId}/out/${asset.id}/r${run}`;
}

function describeError(err: unknown): string {
  if (isMiuError(err)) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function toStream(body: Uint8Array | ReadableStream<Uint8Array> | string): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  return new Blob([body as BlobPart]).stream();
}

export function processorContext(opts: { s: TourStore; store: FileStore; asset: Asset; tour: { id: string; slug: string }; prefix: string; callbackUrl: string | null; attempt: number; env: Env; log: Logger }): ProcessorContext {
  const { s, store, asset, prefix } = opts;
  const open = async (key: string) => {
    const obj = await store.get(checkKey(key));
    if (!obj) throw tourErrors.sourceMissing(key);
    return obj.body;
  };
  return {
    asset,
    tour: opts.tour,
    outputPrefix: prefix,
    store,
    stream: open,
    read: async (key) => new Uint8Array(await new Response(await open(key)).arrayBuffer()),
    async write(key, body, contentType) {
      if (!key.startsWith(prefix + "/")) throw tourErrors.resultInvalid("(write)", `${JSON.stringify(key)} is outside outputPrefix ${prefix}`);
      await store.put(checkKey(key), toStream(body), { contentType });
    },
    progress: (fraction) => s.updateAsset(asset.id, { progress: Number.isFinite(fraction) ? fraction : 0 }),
    callbackUrl: opts.callbackUrl,
    attempt: opts.attempt,
    env: opts.env,
    log: opts.log,
  };
}

async function runStep(rt: TourRuntime, step: ProcessingStep, input: AssetJobInput, job: { attempt: number; maxAttempts: number; env: Env; log: Logger }): Promise<void> {
  const s = await rt.data(job.env);
  const asset = await s.getAsset(input.assetId);
  if (!asset) {
    job.log.warn("tour asset no longer exists; skipping", { assetId: input.assetId });
    return;
  }
  const tour = await s.findTour(asset.tourId);
  if (!tour) return;
  const proc = pickProcessor(rt.processors, step);
  if (!proc) {
    await s.updateAsset(asset.id, { status: "failed", error: describeError(tourErrors.processorMissing(step)) });
    return;
  }
  const run = asset.attempts + 1;
  await s.updateAsset(asset.id, { status: "processing", progress: 0, error: null, processor: proc.name, attempts: run });
  const prefix = outputPrefix(asset, run);
  const ctx = processorContext({
    s,
    store: rt.files(job.env),
    asset: { ...asset, status: "processing", attempts: run },
    tour: { id: tour.id, slug: tour.slug },
    prefix,
    callbackUrl: input.origin ? `${input.origin}${rt.basePath}/_processor/callback` : null,
    attempt: job.attempt,
    env: job.env,
    log: job.log,
  });
  try {
    const result = await proc[step]!(ctx);
    if (isDeferred(result)) {
      job.log.info("tour asset handed to an external processor", { assetId: asset.id, processor: proc.name });
      return;
    }
    const output = checkResult(step, proc.name, prefix, result);
    await s.updateAsset(asset.id, { status: "ready", progress: 1, output, error: null });
  } catch (err) {
    const permanent = isMiuError(err) && PERMANENT.has(err.code);
    const last = permanent || job.attempt >= job.maxAttempts;
    await s.updateAsset(asset.id, { status: last ? "failed" : "queued", error: describeError(err) });
    if (!permanent) throw err;
    job.log.error("tour asset failed; not retrying", { assetId: asset.id, code: (err as { code?: string }).code });
  }
}

export function createJobs(rt: TourRuntime): TourJobs {
  const input = t.object({ assetId: t.string({ maxLength: 100 }), origin: t.optional(t.string({ maxLength: 300 })) });
  const tilePanorama = defineJob(JOB_NAMES.tilePanorama, { input, run: (c) => runStep(rt, "tilePanorama", c.input, c) });
  const optimizeModel = defineJob(JOB_NAMES.optimizeModel, { input, run: (c) => runStep(rt, "optimizeModel", c.input, c) });
  const aggregateStats = defineJob("tour-aggregate-stats", {
    input: t.object({ tourId: t.optional(t.string({ maxLength: 100 })) }),
    run: async (c) => {
      const r = await aggregateAll(rt, c.env, c.input);
      c.log.info("tour analytics aggregated", { ...r });
    },
  });
  return { tilePanorama, optimizeModel, aggregateStats, all: [tilePanorama, optimizeModel, aggregateStats] };
}
