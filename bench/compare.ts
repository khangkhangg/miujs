// CI benchmark regression gate: compares `bun bench/run.ts --json` results against the committed
// bench/baseline.json and fails when MiuJS regresses any benchmark by more than 5%.
//
// Absolute req/s depend on the machine, so every metric is a ratio against Elysia and Hono
// measured in the same run (same machine, same moment, interleaved rounds):
//   - throughput rows: MiuJS req/s ÷ the best other framework's req/s (higher is better);
//   - cold start: the best other framework's ms ÷ MiuJS ms (higher is better).
// Noise: run.ts already keeps the best of N interleaved rounds per framework. compare.ts also
// takes several result files and keeps each metric's best ratio, so CI can rerun once before
// failing. Retained heap per 10k requests is ~0 for every framework (a ratio of noise), so it
// is checked against an absolute bound instead: a leak shows up as steady growth.
//
// Usage:
//   bun bench/compare.ts current.json [more.json ...]            # exit 1 on a regression
//   bun bench/compare.ts --update current.json [more.json ...]   # write bench/baseline.json
//   options: --baseline <file> (default bench/baseline.json), --tolerance 0.05

export interface BenchResult {
  version: number;
  throughput: Record<string, Record<string, number>>;
  memory?: Record<string, Record<string, { retained: number; peak: number }>>;
  coldStartMs?: Record<string, number>;
  [key: string]: unknown;
}

export interface CompareRow {
  metric: string;
  baseline: number | undefined;
  current: number | undefined;
  /** current ÷ baseline − 1 (negative is a regression). */
  change: number | undefined;
  ok: boolean;
  note?: string;
}

/** Above this, live heap grows with requests: a leak (bytes per 10k requests). */
export const MAX_RETAINED_PER_10K = 64 * 1024;

const SELF = "miujs";

/** The gated ratios of one run (higher is better for all). */
export function metrics(r: BenchResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, row] of Object.entries(r.throughput ?? {})) {
    const others = Object.entries(row).filter(([k]) => k !== SELF).map(([, v]) => v);
    if (row[SELF] > 0 && others.length) out[name] = row[SELF] / Math.max(...others);
  }
  const cold = r.coldStartMs;
  if (cold && cold[SELF] > 0) {
    const others = Object.entries(cold).filter(([k]) => k !== SELF).map(([, v]) => v);
    if (others.length) out["cold start"] = Math.min(...others) / cold[SELF];
  }
  return out;
}

export function compare(baseline: BenchResult, runs: BenchResult[], opts: { tolerance?: number } = {}): { ok: boolean; rows: CompareRow[] } {
  const tolerance = opts.tolerance ?? 0.05;
  const base = metrics(baseline);
  // Best ratio per metric across the runs.
  const cur: Record<string, number> = {};
  for (const run of runs) for (const [k, v] of Object.entries(metrics(run))) cur[k] = Math.max(cur[k] ?? -Infinity, v);
  const rows: CompareRow[] = [];
  for (const metric of new Set([...Object.keys(base), ...Object.keys(cur)])) {
    const b = base[metric];
    const c = cur[metric];
    if (c === undefined) rows.push({ metric, baseline: b, current: undefined, change: undefined, ok: false, note: "missing from the current run" });
    else if (b === undefined) rows.push({ metric, baseline: undefined, current: c, change: undefined, ok: true, note: "new (not in the baseline)" });
    else rows.push({ metric, baseline: b, current: c, change: c / b - 1, ok: c >= b * (1 - tolerance) });
  }
  // Leak guard: the smallest retained figure across runs, per scenario.
  const retained: Record<string, number> = {};
  for (const run of runs) {
    for (const [scenario, row] of Object.entries(run.memory ?? {})) {
      const v = row[SELF]?.retained;
      if (typeof v === "number") retained[scenario] = Math.min(retained[scenario] ?? Infinity, v);
    }
  }
  for (const [scenario, v] of Object.entries(retained)) {
    const metric = `${scenario} retained heap per 10k`;
    rows.push({ metric, baseline: undefined, current: v, change: undefined, ok: v <= MAX_RETAINED_PER_10K, note: `limit ${MAX_RETAINED_PER_10K / 1024} KB` });
  }
  return { ok: rows.every((r) => r.ok), rows };
}

/**
 * A typical result, not the luckiest: each throughput row and the cold-start row come from the
 * run whose ratio for that row is the median (lower median for an even count). A lucky baseline
 * would make ordinary noise fail the gate.
 */
export function medianResult(runs: BenchResult[]): BenchResult {
  const pick = (metric: string) => {
    const ranked = runs.filter((r) => metrics(r)[metric] !== undefined).sort((a, b) => metrics(a)[metric] - metrics(b)[metric]);
    return ranked[Math.floor((ranked.length - 1) / 2)];
  };
  const out: BenchResult = { ...runs[0], throughput: {} };
  for (const row of Object.keys(runs[0].throughput)) {
    const r = pick(row);
    if (r) out.throughput[row] = r.throughput[row];
  }
  const cold = pick("cold start");
  if (cold) out.coldStartMs = cold.coldStartMs;
  return out;
}

function format(rows: CompareRow[]): string {
  const pct = (n: number | undefined) => (n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
  const lines = [`${"metric".padEnd(44)}${"baseline".padStart(10)}${"current".padStart(10)}${"change".padStart(9)}  result`];
  for (const r of rows) {
    const isHeap = r.metric.endsWith("per 10k");
    const cur = isHeap ? `${((r.current ?? 0) / 1024).toFixed(1)} KB` : pct(r.current);
    lines.push(`${r.metric.padEnd(44)}${pct(r.baseline).padStart(10)}${cur.padStart(10)}${(r.change === undefined ? "" : `${r.change >= 0 ? "+" : ""}${(r.change * 100).toFixed(1)}%`).padStart(9)}  ${r.ok ? "ok" : "REGRESSION"}${r.note ? ` (${r.note})` : ""}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const update = args.includes("--update");
  if (update) args.splice(args.indexOf("--update"), 1);
  const baselinePath = take("--baseline") ?? `${import.meta.dir}/baseline.json`;
  const tolerance = Number(take("--tolerance") ?? 0.05);
  if (!args.length) {
    console.error("usage: bun bench/compare.ts [--update] [--baseline file] [--tolerance 0.05] result.json [more.json ...]");
    process.exit(2);
  }
  const runs = (await Promise.all(args.map((f) => Bun.file(f).json()))) as BenchResult[];
  if (update) {
    const best = medianResult(runs);
    await Bun.write(baselinePath, JSON.stringify(best, null, 2) + "\n");
    console.log(`Wrote ${baselinePath}:`);
    for (const [k, v] of Object.entries(metrics(best))) console.log(`  ${k.padEnd(42)}${(v * 100).toFixed(1)}%`);
    process.exit(0);
  }
  const baseline = (await Bun.file(baselinePath).json()) as BenchResult;
  const { ok, rows } = compare(baseline, runs, { tolerance });
  console.log(`MiuJS vs the best other framework, same run (best of ${runs.length} run${runs.length === 1 ? "" : "s"}); fails below ${(100 - tolerance * 100).toFixed(0)}% of the baseline ratio\n`);
  console.log(format(rows));
  if (!ok) {
    console.error("\nBenchmark regression. If it is expected (e.g. a deliberate trade-off), refresh the baseline with `bun bench/compare.ts --update <results.json>` and explain why in the PR.");
    process.exit(1);
  }
}
