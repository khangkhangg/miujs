import { expect, test } from "bun:test";
import { join } from "node:path";

// Wrangler bundles Workers with esbuild for a browser-like target. The core must bundle without
// pulling in Node built-ins (the Node adapter is loaded only on Node, at runtime).
test("core bundles for Workers without node: built-ins", async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/index.ts")], target: "browser", format: "esm" });
  expect(result.success).toBe(true);
  const code = await result.outputs[0].text();
  expect(code).not.toContain("node:http");
  expect(code).not.toContain("node:stream");
});
