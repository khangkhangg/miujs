// vipsProcessor: equirectangular panorama → multires equirectangular tile pyramid, using the
// libvips CLI (`vipsheader`, `vips thumbnail`, `vips dzsave --layout google`). The viewer
// shows it with Photo Sphere Viewer's EquirectangularTilesAdapter. Runs on a server or
// container with libvips installed (apt install libvips-tools / brew install vips); never on
// Cloudflare Workers (no processes, tight CPU limits): use externalProcessor() there.
import { tourErrors } from "../errors.ts";
import type { PanoramaResult, ProcessorContext, TourProcessor } from "../processor.ts";
import { defaultExec, isNotFound, tempWorkspace, type Exec, type Workspace } from "./cli.ts";

export interface VipsProcessorOptions {
  /** Tile edge in pixels. Default 512. */
  tileSize?: number;
  /** JPEG quality. Default 85. */
  quality?: number;
  /** Largest level width cap (memory/bandwidth). Default 16384. */
  maxWidth?: number;
  /** Program names. Default "vips" and "vipsheader". */
  vips?: string;
  vipsheader?: string;
  /** @internal Process runner (tests, sandboxes). */
  exec?: Exec;
  /** @internal Temp folder factory. */
  workspace?: () => Promise<Workspace>;
}

const HINT = "Install libvips (apt install libvips-tools, brew install vips) on the machine that runs the queue worker, or use externalProcessor() to tile in a container you run. Cloudflare Workers cannot run vips.";

export function vipsProcessor(opts: VipsProcessorOptions = {}): TourProcessor {
  const tile = opts.tileSize ?? 512;
  const quality = opts.quality ?? 85;
  const maxWidth = opts.maxWidth ?? 16384;
  const vips = opts.vips ?? "vips";
  const header = opts.vipsheader ?? "vipsheader";
  const exec = opts.exec ?? defaultExec;
  const workspace = opts.workspace ?? (() => tempWorkspace());
  const name = "vips";

  const run = async (cmd: string[]): Promise<string> => {
    let r;
    try {
      r = await exec(cmd);
    } catch (err) {
      if (isNotFound(err)) throw tourErrors.processorUnavailable(name, cmd[0], HINT);
      throw err;
    }
    if (r.code !== 0) throw tourErrors.processorFailed(name, `${cmd[0]} ${cmd[1] ?? ""} exited with ${r.code}: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  };

  return {
    name,
    needsProcess: true,
    inspect: () => ({ tileSize: tile, quality, maxWidth, layout: "equirect-tiles" }),
    async tilePanorama(ctx: ProcessorContext): Promise<PanoramaResult> {
      const ws = await workspace();
      try {
        const src = await ws.write(`source${ctx.asset.contentType === "image/png" ? ".png" : ctx.asset.contentType === "image/webp" ? ".webp" : ".jpg"}`, await ctx.read(ctx.asset.sourceKey));
        const width = Number((await run([header, "-f", "width", src])).trim());
        if (!Number.isFinite(width) || width < tile * 2) throw tourErrors.processorFailed(name, `panorama is ${width}px wide; at least ${tile * 2}px is needed`);
        // Widths are tile * 2^n so columns and rows are powers of two (what PSV expects); 2:1 aspect.
        let top = tile * 2;
        while (top * 2 <= Math.min(width, maxWidth)) top *= 2;
        const widths: number[] = [];
        for (let w = tile * 2; w <= top; w *= 2) widths.push(w);
        const suffix = `.jpg[Q=${quality},strip]`;
        const steps = widths.length + 1;
        let done = 0;
        const levels: { width: number; cols: number; rows: number }[] = [];
        for (const [level, w] of widths.entries()) {
          const h = w / 2;
          const scaled = ws.path(`level-${w}.jpg`);
          await run([vips, "thumbnail", src, scaled, String(w), "--height", String(h), "--size", "force"]);
          const out = ws.path("tiles", String(level));
          await ws.mkdir(out);
          await run([vips, "dzsave", scaled, out, "--layout", "google", "--tile-size", String(tile), "--overlap", "0", "--depth", "one", "--suffix", suffix]);
          // Google layout: <zoom>/<row>/<col>.jpg; with --depth one there is a single zoom folder.
          const files = (await ws.list(out)).map((f) => /^(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(f)).filter((m): m is RegExpExecArray => !!m);
          const zoom = Math.max(...files.map((m) => Number(m[1])));
          for (const m of files) {
            if (Number(m[1]) !== zoom) continue;
            await ctx.write(`${ctx.outputPrefix}/${level}/${m[2]}_${m[3]}.jpg`, await ws.read(ws.path("tiles", String(level), m[1], m[2], `${m[3]}.jpg`)), "image/jpeg");
          }
          levels.push({ width: w, cols: w / tile, rows: h / tile });
          await ctx.progress(++done / steps);
        }
        const preview = ws.path("preview.jpg");
        await run([vips, "thumbnail", src, preview, String(Math.min(2048, top)), "--height", String(Math.min(1024, top / 2)), "--size", "force"]);
        await ctx.write(`${ctx.outputPrefix}/preview.jpg`, await ws.read(preview), "image/jpeg");
        await ctx.progress(1);
        return { layout: "equirect-tiles", prefix: ctx.outputPrefix, ext: "jpg", tileSize: tile, levels, preview: `${ctx.outputPrefix}/preview.jpg` };
      } finally {
        await ws.remove().catch(() => {});
      }
    },
  };
}
