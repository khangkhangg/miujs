// Bundles worker.ts the way Wrangler does (esbuild, ESM, workerd/worker/browser conditions) from the
// installed tarballs, then checks the bundle and calls its fetch handler once.
// Run by scripts/release/verify.ts inside the temp Node project (esbuild is installed there).
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const staticBuiltins = [];
const dynamic = new Set();
const result = await esbuild.build({
  entryPoints: ["worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  outfile: "out/worker.js",
  metafile: true,
  logLevel: "silent",
  plugins: [
    {
      name: "builtins",
      setup(build) {
        build.onResolve({ filter: /^(node|bun|cloudflare):/ }, (args) => {
          if (args.kind === "dynamic-import") dynamic.add(`${args.path} <- ${args.importer.replaceAll("\\", "/").replace(/^.*node_modules\//, "")}`);
          else if (!args.path.startsWith("cloudflare:")) staticBuiltins.push(`${args.path} <- ${args.importer.replace(/^.*node_modules[\\/]/, "")}`);
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

const inputs = Object.keys(result.metafile.inputs);
// Our packages must come from dist JS, never src TypeScript (the "bun" condition is not Wrangler's).
const srcInputs = inputs.filter((p) => /node_modules\/(miujs|@miujs\/[^/]+)\/src\//.test(p));
const code = readFileSync("out/worker.js", "utf8");
const evals = [...code.matchAll(/\bnew Function\s*\(|[^.\w]eval\s*\(/g)].map((m) => m[0].trim());

// The bundle is plain ESM: load it and answer a request through the Workers-style fetch(req, env, ctx).
// MiuJS detects Workers by navigator.userAgent, so the app takes its workerd code paths (env = bindings).
Object.defineProperty(globalThis.navigator, "userAgent", { value: "Cloudflare-Workers", configurable: true });
const mod = await import(new URL("./out/worker.js", import.meta.url).href);
// A stand-in D1 binding: enough for db()/auth() to find one; /health never queries it.
const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [], success: true, meta: {} }), run: async () => ({ results: [], success: true, meta: {} }), raw: async () => [] };
const DB = { prepare: () => stmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) };
const env = { SESSION_SECRET: "release-verify-secret-0123456789abcdef", DB };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const res = await mod.default.fetch(new Request("http://worker.test/health"), env, ctx);
const body = await res.text();

const report = { runtime: res.status === 200 ? JSON.parse(body).runtime : null, bytes: code.length, inputs: inputs.length, dynamic: [...dynamic].sort(), staticBuiltins, srcInputs, evals, status: res.status, body };
console.log(JSON.stringify(report));
const runtime = res.status === 200 ? JSON.parse(body).runtime : null;
if (staticBuiltins.length || srcInputs.length || evals.length || res.status !== 200 || runtime !== "workerd") process.exit(1);
