// Worker process for runScenario: runs `concurrency` loops of weighted steps and prints per-step histograms.
import { Histogram, pickWeighted } from "./stats.ts";
import type { RunOptions, Scenario } from "./scenario.ts";

const o = JSON.parse(process.argv[2]!) as RunOptions & { ctx: unknown };
const scenario = ((await import(o.scenario)) as { default: Scenario }).default;
const stats = new Map(scenario.steps.map((s) => [s.name, { hist: new Histogram(), errors: 0 }]));

async function loop(until: number, record: boolean) {
  while (performance.now() < until) {
    const step = pickWeighted(scenario.steps, (s) => s.weight);
    const start = performance.now();
    let ok = false;
    try {
      const res = await step.run(o.url, o.ctx);
      await res.arrayBuffer(); // include body transfer in latency
      ok = step.ok ? step.ok(res) : res.status < 400;
    } catch {
      ok = false;
    }
    if (!record) continue;
    const s = stats.get(step.name)!;
    s.hist.record(performance.now() - start);
    if (!ok) s.errors++;
  }
}

const n = Math.max(1, o.concurrency);
if (o.warmup) await Promise.all(Array.from({ length: n }, () => loop(performance.now() + o.warmup! * 1000, false)));
const until = performance.now() + o.duration * 1000;
await Promise.all(Array.from({ length: n }, () => loop(until, true)));
console.log(JSON.stringify(Object.fromEntries([...stats].map(([k, v]) => [k, { hist: v.hist.toJSON(), errors: v.errors }]))));
