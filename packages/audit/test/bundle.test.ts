import { expect, test } from "bun:test";
import { join } from "node:path";

// Wrangler resolves every literal import specifier at build time, dynamic ones included, and fails
// on node:* unless the Worker enables nodejs_compat. fileSink() only loads node:fs on Bun/Node, so
// the specifier must not be visible to bundlers.
test("@miujs/audit bundles for Workers without any node: specifier, static or dynamic", async () => {
  const seen: string[] = [];
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    target: "browser",
    format: "esm",
    external: ["miujs", "@miujs/db"],
    plugins: [
      {
        name: "node-builtins",
        setup(build) {
          build.onResolve({ filter: /^node:/ }, (args) => {
            seen.push(`${args.kind} ${args.path}`);
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  expect(seen).toEqual([]);
});
