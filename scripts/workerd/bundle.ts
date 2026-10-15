// Bundle sizes as Workers would ship them: esbuild (wrangler's own copy) with the workerd export
// conditions, ESM, minified, then gzip. No wrangler deploy involved.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HARNESS, linkWorkspacePackages, OUT, ROOT } from "./lib.ts";

const esbuildPath = join(HARNESS, "node_modules/esbuild/lib/main.js");

/** Entry files, relative to the repo root. `core` is miujs alone with a few routes. */
export const BUNDLES: Record<string, string> = {
  "core (miujs only)": "scripts/workerd/apps/core/app.ts",
  "core + session + auth + cache": "scripts/workerd/apps/cold/app.ts",
  "examples/api": "examples/api/app.ts",
  "examples/quiz": "examples/quiz/app.ts",
  "examples/crm": "examples/crm/app.ts",
  "game/examples/arena": "packages/game/examples/arena/app.ts",
  "kitchen (harness fixture)": "scripts/workerd/apps/kitchen/app.ts",
};

export async function bundleSizes(): Promise<Record<string, { raw: number; gzip: number; error?: string }>> {
  const esbuild = (await import(esbuildPath)) as typeof import("esbuild");
  const out: Record<string, { raw: number; gzip: number; error?: string }> = {};
  const dir = join(OUT, "bundles");
  mkdirSync(dir, { recursive: true });
  for (const [name, entry] of Object.entries(BUNDLES)) {
    try {
      const r = await esbuild.build({
        entryPoints: [join(ROOT, entry)],
        bundle: true,
        write: false,
        minify: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        conditions: ["workerd", "worker", "browser"],
        mainFields: ["module", "main"],
        external: ["cloudflare:*", "node:*"],
        loader: { ".html": "text" },
        define: { "import.meta.main": "false" },
        logLevel: "silent",
      });
      const code = r.outputFiles[0].contents;
      writeFileSync(join(dir, `${name.replace(/[^a-z0-9]+/gi, "-")}.js`), code);
      out[name] = { raw: code.byteLength, gzip: gzipSync(code, { level: 9 }).byteLength };
    } catch (e) {
      out[name] = { raw: 0, gzip: 0, error: String(e).slice(0, 500) };
    }
  }
  return out;
}

if (import.meta.main) {
  linkWorkspacePackages();
  const sizes = await bundleSizes();
  for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(32)} ${(v.gzip / 1024).toFixed(1).padStart(7)} KB gzip  ${(v.raw / 1024).toFixed(1).padStart(8)} KB raw${v.error ? `  ERROR ${v.error}` : ""}`);
}
