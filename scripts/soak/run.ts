// Soak runner: starts an example app in a child process, measures cold start and idle memory,
// drives real HTTP/WebSocket load for a fixed time while sampling the server's RSS and heap every
// second, then checks for leaks, hung handlers after abrupt disconnects, and graceful shutdown.
//
//   bun scripts/soak/run.ts                         # every app, 60 s each
//   bun scripts/soak/run.ts --quick                 # 15 s each
//   bun scripts/soak/run.ts --apps=quiz,arena --duration=120
//   bun scripts/soak/run.ts --apps=core --runtime=node      # bare core on Node (or deno)
//   bun scripts/soak/run.ts --settle=65             # wait 65 s after load before the settled sample
//
// Results: scripts/soak/results/<runtime>-<app>.json (+ a summary table on stdout).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Histogram, Recorder, abortMidBody, abortWebSocket, fmtMB, fmtNum, sleep } from "./lib.ts";
import { SCENARIOS } from "./scenarios.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BUN = process.execPath;
const NODE = process.env.NODE_BIN ?? "C:/Users/khang/AppData/Local/nodejs/node-v24.22.0-win-x64/node.exe";
const DENO = process.env.DENO_BIN ?? "C:/Users/khang/.deno/bin/deno.exe";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const quick = !!argv.quick;
const durationS = Number(argv.duration ?? (quick ? 15 : 60));
const runtime = (argv.runtime ?? "bun") as "bun" | "node" | "deno";
const apps = (argv.apps ?? (runtime === "bun" ? "core,api,quiz,crm,arena" : "core")).split(",");
// Realtime apps keep rooms for reconnect grace + emptyMs (30 s + 30 s), so they settle longer.
const settleFor = (realtime?: boolean) => Number(argv.settle ?? (realtime && !quick ? 65 : 5));
const codeState = () => {
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: ROOT }).stdout.toString().trim();
  return { head: git("rev-parse", "--short", "HEAD"), dirtyPackages: git("diff", "--stat", "HEAD", "--", "packages").split("\n").pop(), at: new Date().toISOString() };
};
const skipChecks = !!argv["skip-checks"];
const exitWaitS = Number(argv["exit-wait"] ?? 90);

type Mem = { rss: number; heap: number; objects?: number; inflight?: number; maxInflight?: number; served?: number; rooms?: { rooms: number; players: number; connected: number } | null; types?: Record<string, number>; [k: string]: unknown };

function serverCmd(app: string): string[] {
  if (runtime === "bun") return app === "core" && argv.listen ? [BUN, "scripts/soak/serve-core.ts", "0"] : [BUN, "scripts/soak/serve-bun.ts", app, "0"];
  if (app !== "core") throw new Error(`${runtime}: only the core app runs on ${runtime} in this soak`);
  if (runtime === "node") return [NODE, "--expose-gc", "scripts/soak/serve-core.ts", "0"];
  return [DENO, "run", "-A", "--v8-flags=--expose-gc", "scripts/soak/serve-core.ts", "0"];
}

interface Server {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  base: string;
  spawnedAt: number;
  readyMs: number;
  stderr: string[];
}

async function start(app: string, env: Record<string, string> = {}): Promise<Server> {
  const spawnedAt = performance.now();
  const proc = Bun.spawn(serverCmd(app), { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const stderr: string[] = [];
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr.push(dec.decode(chunk));
  })();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  const dec = new TextDecoder();
  const deadline = Date.now() + 30_000;
  while (!/READY \d+/.test(buf)) {
    if (Date.now() > deadline) throw new Error(`${app} did not start: ${buf} ${stderr.join("")}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`${app} exited before READY: ${buf} ${stderr.join("")}`);
    buf += dec.decode(value);
  }
  const readyMs = performance.now() - spawnedAt;
  // Keep draining stdout so the child never blocks on a full pipe.
  (async () => {
    while (!(await reader.read()).done);
  })();
  const port = Number(/READY (\d+)/.exec(buf)![1]);
  return { proc, port, base: `http://127.0.0.1:${port}`, spawnedAt, readyMs, stderr };
}

async function mem(s: Server, q = ""): Promise<Mem> {
  return (await fetch(`${s.base}/__soak/mem${q}`)).json() as Promise<Mem>;
}

/** Stops through the debug route and times how long the process takes to exit on its own. */
async function stopAndTime(s: Server, limitMs = 3000): Promise<{ exited: boolean; ms: number; code: number | null; eventualExitMs: number | null }> {
  const t = performance.now();
  try {
    await fetch(`${s.base}/__soak/stop`);
  } catch {}
  const r = await Promise.race([s.proc.exited, sleep(limitMs).then(() => "timeout" as const)]);
  const ms = performance.now() - t;
  if (r !== "timeout") return { exited: true, ms, code: r as number, eventualExitMs: ms };
  // Not out within the limit: keep waiting (up to --exit-wait s) to see whether it ever exits.
  const r2 = await Promise.race([s.proc.exited, sleep(exitWaitS * 1000).then(() => "timeout" as const)]);
  const eventual = r2 === "timeout" ? null : performance.now() - t;
  if (r2 === "timeout") {
    s.proc.kill();
    await s.proc.exited;
  }
  return { exited: false, ms, code: null, eventualExitMs: eventual };
}

function typeDiff(a?: Record<string, number>, b?: Record<string, number>, n = 12) {
  if (!a || !b) return [];
  return Object.keys({ ...a, ...b })
    .map((k) => ({ type: k, before: a[k] ?? 0, after: b[k] ?? 0, delta: (b[k] ?? 0) - (a[k] ?? 0) }))
    .filter((d) => d.delta !== 0)
    .sort((x, y) => y.delta - x.delta)
    .slice(0, n);
}

async function coldStart(app: string) {
  const env = app === "crm" ? { SOAK_NO_SEED: "1" } : {};
  const sc = SCENARIOS[app];
  const s = await start(app, env);
  // Time to the first response from a real app route (any status).
  let firstMs = 0;
  for (;;) {
    try {
      await (await fetch(s.base + sc.firstRoute, { headers: { origin: s.base } })).arrayBuffer();
      firstMs = performance.now() - s.spawnedAt;
      break;
    } catch {
      await sleep(2);
    }
  }
  await sleep(2000);
  const idle = await mem(s, "?gc=1");
  const shutdown = await stopAndTime(s);
  return { readyMs: s.readyMs, firstResponseMs: firstMs, idleRss: idle.rss, idleHeap: idle.heap, shutdownIdle: shutdown };
}

async function soak(app: string) {
  const sc = SCENARIOS[app];
  const s = await start(app);
  const info = await mem(s);
  await sleep(1000);
  const start0 = await mem(s, "?gc=1");
  const conc = sc.concurrency[quick ? 1 : 0];
  const drivers = Number(argv.drivers ?? (app === "core" ? 3 : 0));
  const durationMs = durationS * 1000;
  const warmMs = Math.max(5000, durationMs * 0.2);

  const samples: { t: number; rss: number; heap: number; inflight?: number; rooms?: number; connected?: number }[] = [];
  let sampling = true;
  const t0 = performance.now();
  const sampler = (async () => {
    while (sampling) {
      try {
        const m = await mem(s);
        samples.push({ t: Math.round(performance.now() - t0), rss: m.rss, heap: m.heap, inflight: m.inflight, rooms: m.rooms?.rooms, connected: m.rooms?.connected });
      } catch {}
      await sleep(1000);
    }
  })();

  const rec = new Recorder();
  const ctx = { base: s.base, wsBase: s.base.replace("http", "ws"), port: s.port, rec, info };
  let load: Promise<unknown>;
  const childResults: any[] = [];
  if (drivers > 0) {
    const per = Math.ceil(conc / drivers);
    load = Promise.all(
      Array.from({ length: drivers }, async (_, d) => {
        const p = Bun.spawn([BUN, "scripts/soak/driver.ts", app, String(s.port), String(durationMs), String(per), JSON.stringify(info)], {
          cwd: ROOT,
          stdout: "pipe",
          stderr: "inherit",
          env: { ...process.env, SOAK_VU_OFFSET: String(d * per) },
        });
        const out = await new Response(p.stdout as ReadableStream).text();
        await p.exited;
        childResults.push(JSON.parse(out.trim().split("\n").pop()!));
      }),
    );
  } else {
    const vus = Array.from({ length: conc }, (_, i) => sc.vu(ctx, i).catch((e) => rec.err("vu crashed", String(e))));
    setTimeout(() => (rec.stopped = true), durationMs);
    load = Promise.race([Promise.all(vus), sleep(durationMs + 30_000)]);
  }

  await sleep(warmMs);
  const warm = await mem(s, "?gc=1&types=1");
  const warmAt = performance.now() - t0;
  await load;
  const loadMs = durationMs;
  const end = await mem(s, "?gc=1&types=1");

  // Merge child-driver results.
  for (const r of childResults) {
    rec.all.merge(r.all);
    for (const [k, h] of Object.entries(r.ops)) {
      if (!rec.ops.has(k)) rec.ops.set(k, new Histogram());
      rec.ops.get(k)!.merge(h as any);
    }
    for (const [k, v] of Object.entries(r.errors)) rec.errors.set(k, (rec.errors.get(k) ?? 0) + (v as number));
    for (const [k, v] of Object.entries(r.expected)) rec.expected.set(k, (rec.expected.get(k) ?? 0) + (v as number));
    rec.wsFramesIn += r.wsFramesIn;
    rec.wsFramesOut += r.wsFramesOut;
  }

  // Idle after load: let timers and GC settle.
  const settleS = settleFor(sc.realtime);
  await sleep(settleS * 1000);
  const settled = await mem(s, "?gc=1&types=1");
  sampling = false;
  await sampler;

  // ---- stuck-handler checks on the loaded server ----
  let stuck: Record<string, unknown> = {};
  if (!skipChecks) {
    const before = await mem(s);
    const N = 200;
    for (let i = 0; i < N; i++) await abortMidBody(s.port, sc.abortTarget.method, sc.abortTarget.path).catch(() => {});
    // Client-side aborts: fetch() cancelled a few ms in.
    await Promise.all(
      Array.from({ length: N }, async () => {
        const ac = new AbortController();
        const p = fetch(s.base + sc.firstRoute, { signal: ac.signal, headers: { origin: s.base } }).catch(() => null);
        setTimeout(() => ac.abort(), Math.random() * 3);
        await p;
      }),
    );
    await sleep(2000);
    const afterHttp = await mem(s);
    const alive = (await fetch(s.base + sc.firstRoute, { headers: { origin: s.base } })).status;
    stuck = { midBodyAborts: N, fetchAborts: N, inflightAfter: afterHttp.inflight ?? null, serverAnswersAfter: alive, servedDelta: (afterHttp.served ?? 0) - (before.served ?? 0) };
    if (sc.wsAbortPath) {
      const W = 50;
      let welcomed = 0;
      for (let i = 0; i < W; i++) if (await abortWebSocket(s.port, await sc.wsAbortPath(ctx, i)).catch(() => false)) welcomed++;
      await sleep(2000);
      const afterWs = await mem(s, "?gc=1");
      stuck = { ...stuck, wsAborts: W, wsWelcomed: welcomed, roomsAfterWsAbort: afterWs.rooms };
    }
    if (sc.extraStuck) stuck = { ...stuck, ...(await sc.extraStuck(ctx, () => mem(s))) };
  }

  const shutdown = await stopAndTime(s);
  const stderrTail = s.stderr.join("").split("\n").filter(Boolean).slice(-5);

  const seconds = loadMs / 1000;
  const peakRss = Math.max(...samples.map((x) => x.rss), end.rss);
  const growth = (end.heap - warm.heap) / warm.heap;
  const settledGrowth = (settled.heap - warm.heap) / warm.heap;
  const result = {
    app,
    runtime,
    durationS,
    concurrency: conc,
    drivers,
    requests: rec.all.n,
    rps: rec.all.n / seconds,
    p50: rec.all.pct(50),
    p95: rec.all.pct(95),
    p99: rec.all.pct(99),
    max: rec.all.max,
    errors: rec.errorCount(),
    errorKinds: Object.fromEntries([...rec.errors].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    expected: Object.fromEntries(rec.expected),
    wsFramesInPerS: rec.wsFramesIn / seconds,
    ops: Object.fromEntries([...rec.ops].map(([k, h]) => [k, { n: h.n, perS: h.n / seconds, p50: h.pct(50), p95: h.pct(95), p99: h.pct(99), max: h.max }])),
    rss: { idleBeforeLoad: start0.rss, start: samples[0]?.rss ?? start0.rss, peak: peakRss, end: end.rss, settled: settled.rss },
    heap: { idleBeforeLoad: start0.heap, afterWarmup: warm.heap, warmupAtMs: Math.round(warmAt), end: end.heap, settled: settled.heap, growth, settledGrowth },
    objects: { afterWarmup: warm.objects, end: end.objects, settled: settled.objects },
    suspectedLeak: growth > 0.1 || settledGrowth > 0.1,
    typeGrowthEnd: typeDiff(warm.types, end.types),
    typeGrowthSettled: typeDiff(warm.types, settled.types),
    extras: Object.fromEntries(Object.entries(end).filter(([k]) => !["rss", "heap", "types", "heapCapacity", "extraMemory", "objects"].includes(k))),
    settledExtras: { rooms: settled.rooms, settleS },
    codeState: codeState(),
    stuck,
    shutdownAfterLoad: shutdown,
    stderrTail,
    samples,
  };
  return result;
}

mkdirSync(join(import.meta.dir, "results"), { recursive: true });
const all: any[] = [];
for (const app of apps) {
  console.error(`\n== ${runtime} ${app}: cold start`);
  const cold = argv["skip-cold"] ? null : await coldStart(app);
  if (cold) console.error(`   first response ${cold.firstResponseMs.toFixed(0)} ms, idle RSS ${fmtMB(cold.idleRss)} MB, idle stop → exit ${cold.shutdownIdle.exited ? cold.shutdownIdle.ms.toFixed(0) + " ms" : "STUCK"}`);
  console.error(`== ${runtime} ${app}: soak ${durationS} s`);
  const r = { ...(await soak(app)), cold };
  all.push(r);
  writeFileSync(join(import.meta.dir, "results", `${runtime}${argv.listen ? "-listen" : ""}-${app}${quick ? "-quick" : ""}.json`), JSON.stringify(r, null, 2));
  console.error(
    `   ${fmtNum(r.rps)} ops/s, p50 ${r.p50.toFixed(2)} / p95 ${r.p95.toFixed(2)} / p99 ${r.p99.toFixed(2)} ms, errors ${r.errors}, heap warm ${fmtMB(r.heap.afterWarmup)} → end ${fmtMB(r.heap.end)} → settled ${fmtMB(r.heap.settled)} MB (${(r.heap.growth * 100).toFixed(1)}% / ${(r.heap.settledGrowth * 100).toFixed(1)}%)${r.suspectedLeak ? "  SUSPECTED LEAK" : ""}`,
  );
  if (r.errors) console.error("   errors:", r.errorKinds);
  if (r.suspectedLeak) console.error("   growing types:", r.typeGrowthSettled.slice(0, 8).map((d) => `${d.type} +${d.delta}`).join(", "));
  console.error(`   stuck checks: ${JSON.stringify(r.stuck)}; stop after load → ${r.shutdownAfterLoad.exited ? `exit in ${r.shutdownAfterLoad.ms.toFixed(0)} ms` : `STUCK > 3 s (eventual exit: ${r.shutdownAfterLoad.eventualExitMs === null ? "never, killed" : (r.shutdownAfterLoad.eventualExitMs / 1000).toFixed(1) + " s"})`}`);
}

console.log(`\n| App (${runtime}) | Conc | ops/s | p50 ms | p95 ms | p99 ms | Errors | RSS start / peak / end MB | Heap warm → end → settled MB | Growth end / settled | Leak? |`);
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |");
for (const r of all) {
  console.log(
    `| ${r.app} | ${r.concurrency} | ${fmtNum(r.rps)} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} | ${r.errors} | ${fmtMB(r.rss.start)} / ${fmtMB(r.rss.peak)} / ${fmtMB(r.rss.end)} | ${fmtMB(r.heap.afterWarmup)} → ${fmtMB(r.heap.end)} → ${fmtMB(r.heap.settled)} | ${(r.heap.growth * 100).toFixed(1)}% / ${(r.heap.settledGrowth * 100).toFixed(1)}% | ${r.suspectedLeak ? "suspected" : "no"} |`,
  );
}
process.exit(0);
