// Runs the MiuJS example apps on Cloudflare's runtime locally: for each app, generate wrangler.toml
// with `miu deploy cloudflare --dry-run`, start `wrangler dev --local` (workerd + Miniflare's D1,
// KV, R2, Queues, Durable Objects, Workflows, rate limits and Cache API) on a free port, and drive
// real HTTP and WebSocket scenarios against it. Nothing touches a Cloudflare account.
//
//   bun run workerd                      # every app
//   bun run workerd quiz api             # some apps
//   bun run workerd --players 1000       # quiz broadcast size (default 1000)
//   bun run workerd --json               # also print results as JSON
//
// Results: scripts/workerd/.out/results.json (and the per-app wrangler.toml and logs next to it).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleSizes } from "./bundle.ts";
import { ensureWorkerdRuns, ensureWrangler, generateConfig, linkWorkspacePackages, metrics, OUT, results, startDev, workerdCompatDate, wranglerVersion, type AppSpec, type Dev, type Generated } from "./lib.ts";
import * as api from "./scenarios/api.ts";
import * as cold from "./scenarios/cold.ts";
import * as arena from "./scenarios/arena.ts";
import * as core from "./scenarios/core.ts";
import * as crm from "./scenarios/crm.ts";
import * as kitchen from "./scenarios/kitchen.ts";
import * as quiz from "./scenarios/quiz.ts";

export interface Suite {
  app: AppSpec;
  run(dev: Dev, ctx: SuiteContext): Promise<void>;
}

export interface SuiteContext {
  generated: Generated;
  compatDate: string;
  players: number;
  /** Stop this wrangler and start a new one on the same local state (restart scenarios). */
  restart(): Promise<Dev>;
}

const SUITES: Record<string, Suite> = { core, cold, api, quiz, kitchen, arena, crm };

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const picked = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--players"));
const players = Number(flag("players") ?? 1000);

mkdirSync(OUT, { recursive: true });
ensureWrangler();
linkWorkspacePackages();
const workerd = ensureWorkerdRuns();
const compatDate = workerdCompatDate();
console.log(`wrangler ${wranglerVersion()}, ${workerd}, compatibility_date ${compatDate}, local mode only\n`);
metrics.environment = { wrangler: wranglerVersion(), workerd, compatDate, platform: `${process.platform}-${process.arch}`, bun: Bun.version };

for (const name of picked.length ? picked : Object.keys(SUITES)) {
  const suite = SUITES[name];
  if (!suite) throw new Error(`Unknown app "${name}". Use: ${Object.keys(SUITES).join(", ")}`);
  console.log(`== ${name} (${suite.app.dir})`);
  let generated: Generated;
  try {
    generated = generateConfig(suite.app, compatDate);
    results.push({ app: name, name: "miu deploy cloudflare --dry-run generates wrangler.toml", status: "pass", ms: 0 });
    console.log(`  pass  config: ${generated.config}`);
  } catch (e) {
    results.push({ app: name, name: "miu deploy cloudflare --dry-run generates wrangler.toml", status: "fail", ms: 0, note: String(e).slice(0, 2000) });
    console.log(`  FAIL  config: ${e}`);
    continue;
  }
  let dev: Dev;
  try {
    dev = await startDev({ app: suite.app, config: generated.config, compatDate });
    results.push({ app: name, name: "wrangler dev --local starts the Worker", status: "pass", ms: dev.startupMs });
    console.log(`  pass  wrangler dev --local ready in ${Math.round(dev.startupMs)} ms on ${dev.url}`);
  } catch (e) {
    results.push({ app: name, name: "wrangler dev --local starts the Worker", status: "fail", ms: 0, note: String(e).slice(0, 3000) });
    console.log(`  FAIL  wrangler dev: ${String(e).slice(0, 3000)}`);
    continue;
  }
  const ctx: SuiteContext = {
    generated,
    compatDate,
    players,
    async restart() {
      await dev.stop();
      dev = await startDev({ app: suite.app, config: generated.config, compatDate, keepState: true });
      return dev;
    },
  };
  try {
    await suite.run(dev, ctx);
  } catch (e) {
    results.push({ app: name, name: "suite crashed", status: "fail", ms: 0, note: String(e).slice(0, 2000) });
    console.log(`  FAIL  suite crashed: ${e}`);
  } finally {
    await dev.stop();
  }
  console.log();
}

if (!picked.length || picked.includes("bundle")) {
  console.log("== bundle sizes (esbuild, workerd conditions, minified + gzip)");
  metrics.bundles = await bundleSizes();
  for (const [k, v] of Object.entries(metrics.bundles as Record<string, { raw: number; gzip: number }>)) console.log(`  ${k.padEnd(32)} ${(v.gzip / 1024).toFixed(1).padStart(7)} KB gzip  ${(v.raw / 1024).toFixed(1).padStart(8)} KB raw`);
  console.log();
}

const counts = { pass: 0, fail: 0, skip: 0 };
for (const r of results) counts[r.status]++;
writeFileSync(join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), counts, results, metrics }, null, 2));
console.log(`${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped. Details: ${join(OUT, "results.json")}`);
if (argv.includes("--json")) console.log(JSON.stringify({ counts, results, metrics }, null, 2));
process.exit(counts.fail ? 1 : 0);
