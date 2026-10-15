// Shared leak and exit-cleanliness checks for MiuJS packages.
//
// leakCheck: runs `fn` many times in rounds, forcing a full GC after each round, and reports how
// much the live heap (and object count) grows per iteration once warmed up. A healthy subsystem
// plateaus; a leak grows linearly. Thresholds are per iteration, so they scale with `perRound`.
//
// exitCheck: runs a script in a fresh Bun process and reports whether it exits by itself, which
// catches timers, sockets or loops that keep a process alive after the work is done.

import { heapStats } from "bun:jsc";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LeakOptions {
  warmup?: number;
  rounds?: number;
  perRound?: number;
  /** Allowed live-heap growth per iteration after warm-up. Default 64 bytes. */
  maxBytesPerIteration?: number;
  /** Allowed growth in live object count per iteration. Default 0.05. */
  maxObjectsPerIteration?: number;
}

export interface LeakReport {
  name: string;
  leaking: boolean;
  bytesPerIteration: number;
  objectsPerIteration: number;
  heapStart: number;
  heapEnd: number;
  /** Object types whose live count grew the most between the first and last round. */
  growth: { type: string; delta: number }[];
}

function sample() {
  Bun.gc(true);
  Bun.gc(true);
  const h = heapStats();
  return { heap: h.heapSize, objects: h.objectCount, types: h.objectTypeCounts as Record<string, number> };
}

export async function leakCheck(name: string, fn: (i: number) => unknown, opts: LeakOptions = {}): Promise<LeakReport> {
  const warmup = opts.warmup ?? 500;
  const rounds = Math.max(3, opts.rounds ?? 5);
  const perRound = opts.perRound ?? 2000;
  let i = 0;
  const runMany = async (n: number) => {
    for (let k = 0; k < n; k++) {
      const r = fn(i++) as { then?: unknown } | undefined;
      if (r && typeof r.then === "function") await r;
    }
  };
  await runMany(warmup);
  const samples: ReturnType<typeof sample>[] = [];
  for (let r = 0; r < rounds; r++) {
    await runMany(perRound);
    samples.push(sample());
  }
  // Compare the second round to the last: the first can still include lazy one-time caches.
  const first = samples[1];
  const last = samples[samples.length - 1];
  const iterations = perRound * (samples.length - 2);
  const bytesPerIteration = (last.heap - first.heap) / iterations;
  const objectsPerIteration = (last.objects - first.objects) / iterations;
  const growth = Object.entries(last.types)
    .map(([type, n]) => ({ type, delta: n - (first.types[type] ?? 0) }))
    .filter((g) => g.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 8);
  const leaking = bytesPerIteration > (opts.maxBytesPerIteration ?? 64) || objectsPerIteration > (opts.maxObjectsPerIteration ?? 0.05);
  return { name, leaking, bytesPerIteration, objectsPerIteration, heapStart: first.heap, heapEnd: last.heap, growth };
}

/** Formats a report for test failure messages. */
export function describeLeak(r: LeakReport): string {
  return `${r.name}: ${r.bytesPerIteration.toFixed(1)} B/iter, ${r.objectsPerIteration.toFixed(3)} objects/iter; growing: ${r.growth.map((g) => `${g.type} +${g.delta}`).join(", ")}`;
}

export interface ExitReport {
  exited: boolean;
  code: number | null;
  ms: number;
  stderr: string;
}

/**
 * Runs `source` in a fresh Bun process (cwd = the repo, so workspace packages resolve) and waits up
 * to `timeoutMs` for it to exit on its own.
 */
export async function exitCheck(source: string, timeoutMs = 3000, cwd = join(import.meta.dir, "..", "..")): Promise<ExitReport> {
  const dir = mkdtempSync(join(cwd, ".tmp-exit-"));
  const file = join(dir, "main.ts");
  writeFileSync(file, source);
  const start = performance.now();
  const proc = Bun.spawn([process.execPath, file], { cwd, stdout: "ignore", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
  const outcome = await Promise.race([proc.exited, timedOut]);
  clearTimeout(timer);
  const ms = performance.now() - start;
  if (outcome === "timeout") proc.kill();
  const stderr = await new Response(proc.stderr).text().catch(() => "");
  rmSync(dir, { recursive: true, force: true });
  return { exited: outcome !== "timeout", code: outcome === "timeout" ? null : (outcome as number), ms, stderr };
}
