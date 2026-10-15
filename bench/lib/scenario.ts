// Scenario load testing: weighted, realistic request mixes with per-endpoint latency percentiles.
// A scenario module default-exports a Scenario; workers run it in parallel and report histograms.
import { Histogram } from "./stats.ts";

export interface Step {
  name: string;
  weight: number;
  run: (baseUrl: string, ctx: unknown) => Promise<Response>;
  /** Success check; default: status < 400. */
  ok?: (res: Response) => boolean;
}

export interface Scenario {
  name: string;
  /** Runs once in the parent before load (e.g. log in, seed data); its result is passed to every step. */
  setup?: (baseUrl: string) => Promise<unknown>;
  steps: Step[];
}

export interface RunOptions {
  scenario: string; // path to the scenario module
  url: string;
  duration: number; // seconds
  concurrency: number; // total in-flight loops across workers
  workers: number;
  warmup?: number; // seconds
}

export interface StepReport {
  name: string;
  requests: number;
  errors: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Report {
  scenario: string;
  steps: StepReport[];
  total: { requests: number; errors: number; rps: number; p50: number; p99: number };
  markdown: string;
}

const WORKER = new URL("./scenario-worker.ts", import.meta.url).pathname;

export async function runScenario(o: RunOptions): Promise<Report> {
  const mod = (await import(o.scenario)) as { default: Scenario };
  const scenario = mod.default;
  const ctx = scenario.setup ? await scenario.setup(o.url) : undefined;
  const per = Math.max(1, Math.round(o.concurrency / o.workers));
  const runs = Array.from({ length: o.workers }, async () => {
    const proc = Bun.spawn(["bun", WORKER, JSON.stringify({ ...o, concurrency: per, ctx })], { stdout: "pipe", stderr: "inherit" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const line = out.trim().split("\n").pop()!;
    return JSON.parse(line) as Record<string, { hist: ReturnType<Histogram["toJSON"]>; errors: number }>;
  });
  const results = await Promise.all(runs);

  const merged = new Map<string, { hist: Histogram; errors: number }>();
  for (const r of results) {
    for (const [name, v] of Object.entries(r)) {
      const m = merged.get(name) ?? { hist: new Histogram(), errors: 0 };
      m.hist.merge(Histogram.fromJSON(v.hist));
      m.errors += v.errors;
      merged.set(name, m);
    }
  }
  const total = new Histogram();
  let totalErrors = 0;
  const steps: StepReport[] = scenario.steps.map((s) => {
    const m = merged.get(s.name) ?? { hist: new Histogram(), errors: 0 };
    total.merge(m.hist);
    totalErrors += m.errors;
    return {
      name: s.name,
      requests: m.hist.count,
      errors: m.errors,
      rps: m.hist.count / o.duration,
      p50: m.hist.percentile(50),
      p95: m.hist.percentile(95),
      p99: m.hist.percentile(99),
      max: m.hist.max,
    };
  });
  const totals = {
    requests: total.count,
    errors: totalErrors,
    rps: total.count / o.duration,
    p50: total.percentile(50),
    p99: total.percentile(99),
  };
  return { scenario: scenario.name, steps, total: totals, markdown: toMarkdown(scenario.name, steps, totals, o) };
}

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const int = (v: number) => Math.round(v).toLocaleString("en-US");

function toMarkdown(name: string, steps: StepReport[], t: Report["total"], o: RunOptions): string {
  const rows = [
    `**${name}** — ${o.duration}s, concurrency ${o.concurrency}, ${o.workers} workers`,
    "",
    "| Step | Requests | Req/s | Errors | p50 ms | p95 ms | p99 ms | max ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...steps.map((s) => `| ${s.name} | ${int(s.requests)} | ${int(s.rps)} | ${s.errors} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} |`),
    `| **total** | ${int(t.requests)} | ${int(t.rps)} | ${t.errors} | ${ms(t.p50)} | | ${ms(t.p99)} | |`,
  ];
  return rows.join("\n");
}
