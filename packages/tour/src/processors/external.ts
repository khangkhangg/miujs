// externalProcessor: hand the work to a container or server you run (vips, gltf-transform,
// krpano, anything), which is how processing works from Cloudflare Workers.
//
// Protocol. The job is POSTed as JSON to `url` with `x-miu-tour-signature: t=<unix seconds>,
// v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`:
//
//   { step: "tilePanorama" | "optimizeModel", assetId, run, tourId, tourSlug, sourceKey,
//     contentType, size, outputPrefix, callbackUrl }
//
// Answer 2xx quickly, then read `sourceKey` from the same bucket (R2/S3) the app uses, write
// outputs under `outputPrefix/`, and POST progress and the result to `callbackUrl`, signed the
// same way:
//
//   { assetId, run, status: "processing", progress: 0.4 }
//   { assetId, run, status: "ready", result: <PanoramaResult | ModelResult> }
//   { assetId, run, status: "failed", error: "why" }
//
// Signatures older than 5 minutes are refused (replays), as are callbacks for an older run.
import { route, t, validate, MiuError, type Context, type RouteDef } from "miujs";
import { signProcessorBody, verifyProcessorSignature } from "../crypto.ts";
import { tourErrors } from "../errors.ts";
import { outputPrefix, STEP_FOR } from "../jobs.ts";
import { checkResult, type DeferredResult, type ProcessingStep, type ProcessorContext, type TourProcessor } from "../processor.ts";
import type { TourRuntime } from "../runtime.ts";

export interface ExternalProcessorOptions {
  /** Where jobs are POSTed. https (http only for localhost). */
  url: string;
  /** Shared HMAC secret, 32+ characters. An array rotates: the first signs, all verify callbacks. */
  secret: string | string[];
  /** Which steps the remote handles. Default both. */
  steps?: ProcessingStep[];
  /** Name shown on assets and in inspect. Default "external". */
  name?: string;
  /** @internal */
  fetch?: typeof fetch;
}

export function externalProcessor(opts: ExternalProcessorOptions): TourProcessor {
  const secrets = Array.isArray(opts.secret) ? opts.secret : [opts.secret];
  if (!secrets.length || secrets.some((s) => typeof s !== "string" || s.length < 32)) {
    throw tourErrors.config("CONFIG", "externalProcessor needs a secret of 32+ characters", "Generate one with `openssl rand -base64 32` and give the same value to your processing service.");
  }
  let u: URL;
  try {
    u = new URL(opts.url);
  } catch {
    throw tourErrors.config("CONFIG", `externalProcessor url ${JSON.stringify(opts.url)} is not a URL`, "Pass the full https URL of your processing service, e.g. https://tiler.example.com/jobs.");
  }
  if (!(u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)))) {
    throw tourErrors.config("CONFIG", "externalProcessor url must use https", "Jobs carry signed instructions; send them over https (http is allowed for localhost only).");
  }
  const steps = opts.steps ?? ["tilePanorama", "optimizeModel"];
  const name = opts.name ?? "external";

  const submit = async (step: ProcessingStep, ctx: ProcessorContext): Promise<DeferredResult> => {
    const body = JSON.stringify({
      step,
      assetId: ctx.asset.id,
      run: ctx.asset.attempts,
      tourId: ctx.tour.id,
      tourSlug: ctx.tour.slug,
      sourceKey: ctx.asset.sourceKey,
      contentType: ctx.asset.contentType,
      size: ctx.asset.size,
      outputPrefix: ctx.outputPrefix,
      callbackUrl: ctx.callbackUrl,
    });
    const res = await (opts.fetch ?? fetch)(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-miu-tour-signature": await signProcessorBody(secrets[0], body) },
      body,
    });
    if (!res.ok) throw tourErrors.processorFailed(name, `the service answered HTTP ${res.status}`);
    await res.body?.cancel();
    return { deferred: true };
  };

  const p: TourProcessor = { name, callbackSecrets: secrets, inspect: () => ({ url: `${u.origin}${u.pathname}`, steps }) };
  const out = p as { -readonly [K in keyof TourProcessor]: TourProcessor[K] };
  if (steps.includes("tilePanorama")) out.tilePanorama = (ctx) => submit("tilePanorama", ctx);
  if (steps.includes("optimizeModel")) out.optimizeModel = (ctx) => submit("optimizeModel", ctx);
  return p;
}

const callbackBody = t.object({
  assetId: t.string({ maxLength: 100 }),
  run: t.integer({ min: 1 }),
  status: t.enum(["processing", "ready", "failed"]),
  progress: t.optional(t.number({ min: 0, max: 1 })),
  result: t.optional(t.unknown()),
  error: t.optional(t.string({ maxLength: 2000 })),
});

/** POST /tours/_processor/callback: signed progress and results from external processors. */
export function processorRoutes(rt: TourRuntime): RouteDef[] {
  const callback = route.post(`${rt.basePath}/_processor/callback`, {
    name: "tours_processor_callback",
    summary: "Progress and results from an external processor (HMAC-signed)",
    tags: ["tours", "csrf-exempt"],
    mcp: false,
    internal: true,
    maxBodySize: 256 * 1024,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const secrets = rt.processors.flatMap((p) => [...(p.callbackSecrets ?? [])]);
      const text = await ctx.req.text();
      if (!secrets.length || !(await verifyProcessorSignature(secrets, ctx.headers.get("x-miu-tour-signature"), text, Math.floor(rt.now() / 1000)))) {
        throw tourErrors.callbackInvalid();
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw tourErrors.invalid("Callback body is not JSON", "Send the JSON documented on externalProcessor().");
      }
      const checked = validate(callbackBody, raw);
      if (!checked.ok) throw tourErrors.invalid(`Invalid callback: ${checked.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`, "Send the JSON documented on externalProcessor().", { issues: checked.issues });
      const body = checked.value;
      const s = await rt.data(ctx.env);
      const asset = await s.getAsset(body.assetId);
      if (!asset) throw tourErrors.assetNotFound(body.assetId);
      const step = STEP_FOR[asset.kind];
      if (!step || asset.attempts !== body.run || asset.status !== "processing") {
        throw new MiuError({
          code: "MIU_E_TOUR_CALLBACK_STALE",
          status: 409,
          message: `Asset ${asset.id} is not waiting for run ${body.run} (it is ${asset.status}, run ${asset.attempts})`,
          fix: "Drop this job: a newer run replaced it, or it already finished.",
        });
      }
      if (body.status === "processing") {
        await s.updateAsset(asset.id, { progress: body.progress ?? asset.progress });
      } else if (body.status === "failed") {
        await s.updateAsset(asset.id, { status: "failed", error: body.error ?? "The external processor reported a failure" });
      } else {
        try {
          const output = checkResult(step, asset.processor ?? "external", outputPrefix(asset, body.run), body.result);
          await s.updateAsset(asset.id, { status: "ready", progress: 1, output, error: null });
        } catch (err) {
          const e = err as MiuError;
          await s.updateAsset(asset.id, { status: "failed", error: `${e.code}: ${e.message}` });
          throw new MiuError({ code: e.code, status: 400, message: e.message, fix: e.fix });
        }
      }
      return new Response(null, { status: 204 });
    },
  });
  return [callback];
}
