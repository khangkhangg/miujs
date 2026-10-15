// gltfTransformProcessor: glTF binary → optimized glb (Draco or meshopt geometry, KTX2 or
// WebP textures) with the gltf-transform CLI. Runs `npx --yes @gltf-transform/cli@<pinned>`
// by default, so the worker machine needs Node/npm (KTX2 also needs KTX-Software's `toktx`).
// Not on Cloudflare Workers: use externalProcessor() there.
import { tourErrors } from "../errors.ts";
import type { ModelResult, ProcessorContext, TourProcessor } from "../processor.ts";
import { defaultExec, isNotFound, tempWorkspace, type Exec, type Workspace } from "./cli.ts";

export const GLTF_TRANSFORM_CLI = "@gltf-transform/cli@4.5.0";

export interface GltfTransformOptions {
  /** Geometry compression. Default "draco" (decoded by <model-viewer> out of the box). */
  compress?: "draco" | "meshopt" | false;
  /** Texture compression. Default "ktx2" (needs `toktx` on the worker). */
  textures?: "ktx2" | "webp" | false;
  /** The command that runs the CLI, before `optimize`. Default ["npx", "--yes", GLTF_TRANSFORM_CLI]. */
  command?: string[];
  /** @internal Process runner (tests, sandboxes). */
  exec?: Exec;
  /** @internal Temp folder factory. */
  workspace?: () => Promise<Workspace>;
}

const HINT = "Install Node.js (for npx) and KTX-Software (toktx, for KTX2) on the machine that runs the queue worker, pass gltfTransformProcessor({ command: [\"gltf-transform\"] }) for a global install, or use externalProcessor(). Cloudflare Workers cannot run it.";

export function gltfTransformProcessor(opts: GltfTransformOptions = {}): TourProcessor {
  const compress = opts.compress ?? "draco";
  const textures = opts.textures ?? "ktx2";
  const command = opts.command ?? ["npx", "--yes", GLTF_TRANSFORM_CLI];
  const exec = opts.exec ?? defaultExec;
  const workspace = opts.workspace ?? (() => tempWorkspace());
  const name = "gltf-transform";
  return {
    name,
    needsProcess: true,
    inspect: () => ({ command: command.join(" "), compress, textures }),
    async optimizeModel(ctx: ProcessorContext): Promise<ModelResult> {
      const ws = await workspace();
      try {
        const source = await ctx.read(ctx.asset.sourceKey);
        const input = await ws.write("input.glb", source);
        const output = ws.path("output.glb");
        const cmd = [...command, "optimize", input, output, "--compress", compress === false ? "false" : compress, "--texture-compress", textures === false ? "false" : textures];
        let r;
        try {
          r = await exec(cmd, { cwd: ws.dir });
        } catch (err) {
          if (isNotFound(err)) throw tourErrors.processorUnavailable(name, command[0], HINT);
          throw err;
        }
        if (r.code !== 0) throw tourErrors.processorFailed(name, `exited with ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
        await ctx.progress(0.9);
        const bytes = await ws.read(output);
        const key = `${ctx.outputPrefix}/model.glb`;
        await ctx.write(key, bytes, "model/gltf-binary");
        const requires: ("draco" | "meshopt" | "ktx2")[] = [];
        if (compress) requires.push(compress);
        if (textures === "ktx2") requires.push("ktx2");
        return { layout: "glb", key, bytes: bytes.byteLength, originalBytes: source.byteLength, requires };
      } finally {
        await ws.remove().catch(() => {});
      }
    },
  };
}
