// cloudflareImagesProcessor: uploads the panorama to Cloudflare Images and serves it at a few
// widths through flexible variants (`/w=4096`), so a Worker can "process" a panorama with a
// single fetch and no CPU. It does not cut tiles: Cloudflare Images limits uploads (size and
// megapixels; check Cloudflare's current limits), so very large panoramas need vipsProcessor()
// or externalProcessor(). Enable flexible variants on the account first.
import { tourErrors } from "../errors.ts";
import type { PanoramaResult, ProcessorContext, TourProcessor } from "../processor.ts";

export interface CloudflareImagesOptions {
  accountId: string;
  /** API token with the Cloudflare Images: Edit permission. */
  token: string;
  /** Widths to offer, smallest first. Default [2048, 4096, 8192]. */
  widths?: number[];
  /** @internal */
  fetch?: typeof fetch;
}

export function cloudflareImagesProcessor(opts: CloudflareImagesOptions): TourProcessor {
  const widths = opts.widths ?? [2048, 4096, 8192];
  const name = "cloudflare-images";
  return {
    name,
    inspect: () => ({ accountId: opts.accountId, widths, layout: "equirect" }),
    async tilePanorama(ctx: ProcessorContext): Promise<PanoramaResult> {
      const doFetch = opts.fetch ?? fetch;
      const bytes = await ctx.read(ctx.asset.sourceKey);
      const form = new FormData();
      form.set("file", new Blob([bytes as BlobPart], { type: ctx.asset.contentType }), "panorama");
      form.set("id", `tour-${ctx.asset.id}-r${ctx.asset.attempts}`);
      form.set("metadata", JSON.stringify({ tourId: ctx.tour.id, assetId: ctx.asset.id }));
      const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/images/v1`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}` },
        body: form,
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {}
      if (!res.ok || !body?.success) {
        const why = (body?.errors as { message?: string }[] | undefined)?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
        throw tourErrors.processorFailed(name, why);
      }
      const variant: unknown = body.result?.variants?.[0];
      if (typeof variant !== "string" || !variant.startsWith("https://")) throw tourErrors.processorFailed(name, "the upload response has no delivery URL");
      const base = variant.slice(0, variant.lastIndexOf("/"));
      await ctx.progress(1);
      return { layout: "equirect", sources: widths.map((w) => ({ width: w, url: `${base}/w=${w}` })) };
    },
  };
}
