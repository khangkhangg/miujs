/**
 * Generate the sample panoramas used by the tour demo:  bun examples/tour/make-panoramas.ts [outDir] [width]
 * (also runs on Node 22: node --experimental-strip-types examples/tour/make-panoramas.ts)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePanorama, SAMPLE_ROOMS } from "./panorama.ts";

const out = process.argv[2] ?? join(import.meta.dirname ?? ".", "panoramas");
const width = Number(process.argv[3] ?? 2048);
await mkdir(out, { recursive: true });
for (const room of SAMPLE_ROOMS) {
  const png = await makePanorama({ ...room, width });
  await writeFile(join(out, room.file), png);
  console.log(`${join(out, room.file)}  ${width}x${width / 2}  ${(png.length / 1024).toFixed(0)} KiB`);
}
