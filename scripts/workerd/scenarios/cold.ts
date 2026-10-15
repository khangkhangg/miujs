// Cold start for core + session + auth + cache (scripts/workerd/apps/cold): wrangler startup and
// the first request after each fresh start (module already evaluated by workerd at startup; the
// first request runs app.ready(): plugin setup), over 5 restarts.

import { Client, check, metrics, percentiles, scenario, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

export const app: AppSpec = { name: "cold", dir: "scripts/workerd/apps/cold", entry: "app.ts", vars: { SESSION_SECRET: "workerd-harness-session-secret-0123456789abcdef" } };

export async function run(dev: Dev, ctx: SuiteContext) {
  await scenario("cold", "cold start x5: wrangler ready, first request, warm p50 (core + session + auth + cache)", async () => {
    const startup: number[] = [];
    const first: number[] = [];
    const warm: number[] = [];
    let d = dev;
    for (let i = 0; i < 5; i++) {
      if (i > 0) d = await ctx.restart();
      startup.push(d.startupMs);
      const c = new Client(d.url);
      const r = await c.get("/whoami");
      check(r.status === 200 && r.json.user === null, `first request ${r.status}: ${r.text.slice(0, 200)}`);
      first.push(r.ms);
      for (let j = 0; j < 50; j++) warm.push((await c.get("/whoami")).ms);
    }
    const s = percentiles(startup);
    const f = percentiles(first);
    const w = percentiles(warm);
    metrics.coldStart = { app: "core + session + auth + cache", wranglerReadyMs: s, firstRequestMs: f, warmMs: w };
    return `wrangler ready p50 ${Math.round(s.p50)} ms; first request p50 ${f.p50} ms (max ${f.max}); warm p50 ${w.p50} ms`;
  });
}
