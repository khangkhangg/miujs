// Game-stack load, memory and soak runner (Bun). Starts scripts/soak/games-server.ts in its own
// process and drives it from scripts/soak/games-client.ts child processes over real WebSockets.
//
//   bun scripts/soak/games.ts idle            bytes per idle joined socket (broadcast room, quiz with views)
//   bun scripts/soak/games.ts room            one room: closed-loop moves, msgs/s, p50/p99, CPU per message
//   bun scripts/soak/games.ts process         many rooms at 20 Hz: what one process sustains
//   bun scripts/soak/games.ts soak [minutes]  rooms created/played/finished, joins, leaves, resumes;
//                                             heap after GC sampled, then settle and check it returns
//   --json <file>  also write the results as JSON;  SOAK_PROFILE=1  run the server with --cpu-prof-md
//
// Results go to stdout (and scripts/soak/results/games-*.json with --json).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Histogram, fmtMB, sleep } from "./lib.ts";

const argv = process.argv.slice(2);
const phases = argv.filter((a, i) => !a.startsWith("--") && !/^\d+$/.test(a) && argv[i - 1] !== "--json");
const minutes = Number(argv.find((a) => /^\d+$/.test(a)) ?? 10);
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
const here = import.meta.dir;
const results: Record<string, unknown> = { date: new Date().toISOString(), bun: Bun.version, cores: navigator.hardwareConcurrency };

interface Mem {
  rss: number;
  heap: number;
  objects: number;
  cpuMs: number;
  rooms: number;
  players: number;
  connected: number;
  sockets: number;
  types?: Record<string, number>;
}

async function startServer(env: Record<string, string> = {}) {
  const prof = process.env.SOAK_PROFILE ? ["--cpu-prof-md", `--cpu-prof-dir=${join(here, "results", "prof")}`] : [];
  const proc = Bun.spawn([process.execPath, ...prof, join(here, "games-server.ts"), "0"], { stdout: "pipe", stderr: "inherit", env: { ...process.env, ...env } });
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("server exited before READY");
    buf += new TextDecoder().decode(value);
  }
  const port = Number(/READY (\d+)/.exec(buf)![1]);
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    mem: async (gc = false, types = false): Promise<Mem> => (await fetch(`${base}/__soak/mem?${gc ? "gc=1&" : ""}${types ? "types=1" : ""}`)).json() as Promise<Mem>,
    room: async (type: string): Promise<{ id: string; hostKey?: string }> => (await fetch(`${base}/__soak/room?type=${type}`, { method: "POST" })).json() as never,
    async stop() {
      await fetch(`${base}/__soak/stop`).catch(() => {});
      const t = performance.now();
      const code = await Promise.race([proc.exited, sleep(10_000).then(() => "timeout")]);
      if (code === "timeout") proc.kill();
      return { exitedMs: Math.round(performance.now() - t), clean: code !== "timeout" };
    },
  };
}

interface DriverOut {
  all: ReturnType<Histogram["toJSON"]>;
  ops: Record<string, ReturnType<Histogram["toJSON"]>>;
  errors: Record<string, number>;
  wsFramesIn: number;
  wsFramesOut: number;
  bytesIn: number;
}

/** Start a driver; resolves `joined` when it printed JOINED and `done` with its JSON. */
function driver(mode: string, port: number, cfg: unknown) {
  const proc = Bun.spawn([process.execPath, join(here, "games-client.ts"), mode, String(port), JSON.stringify(cfg)], { stdout: "pipe", stderr: "inherit" });
  let resolveJoined!: (n: number) => void;
  const joined = new Promise<number>((r) => (resolveJoined = r));
  const done = (async () => {
    const reader = proc.stdout.getReader();
    let out = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
      const m = /JOINED (\d+)/.exec(out);
      if (m) resolveJoined(Number(m[1]));
    }
    resolveJoined(0);
    const last = out.trim().split("\n").pop()!;
    return JSON.parse(last) as DriverOut;
  })();
  return { joined, done };
}

function merge(outs: DriverOut[]) {
  const all = new Histogram();
  const ops = new Map<string, Histogram>();
  const errors: Record<string, number> = {};
  let framesIn = 0;
  let framesOut = 0;
  let bytesIn = 0;
  for (const o of outs) {
    all.merge(o.all);
    for (const [k, h] of Object.entries(o.ops)) {
      if (!ops.has(k)) ops.set(k, new Histogram());
      ops.get(k)!.merge(h);
    }
    for (const [k, v] of Object.entries(o.errors)) errors[k] = (errors[k] ?? 0) + v;
    framesIn += o.wsFramesIn;
    framesOut += o.wsFramesOut;
    bytesIn += o.bytesIn;
  }
  const lat = (h: Histogram) => ({ n: h.n, p50: +h.pct(50).toFixed(2), p95: +h.pct(95).toFixed(2), p99: +h.pct(99).toFixed(2), max: +h.max.toFixed(1) });
  return { framesIn, framesOut, bytesIn, errors, ops: Object.fromEntries([...ops].map(([k, h]) => [k, lat(h)])) };
}

const kb = (b: number) => `${(b / 1024).toFixed(2)} KB`;

// ---- idle ---------------------------------------------------------------------------------------------

async function idle() {
  const out: Record<string, unknown> = {};
  for (const [type, rooms, perRoom] of [
    ["action", 500, 8],
    ["quiz", 250, 16],
  ] as const) {
    const srv = await startServer();
    const before = await srv.mem(true);
    const made = await Promise.all(Array.from({ length: rooms }, () => srv.room(type)));
    const emptyRooms = await srv.mem(true, true);
    const K = 4;
    const ds = Array.from({ length: K }, (_, k) => driver("idle", srv.port, { rooms: made.filter((_, i) => i % K === k).map((r) => ({ type, id: r.id })), perRoom, holdMs: 6_000, vu: k }));
    const joined = (await Promise.all(ds.map((d) => d.joined))).reduce((a, b) => a + b, 0);
    await sleep(1_500);
    const full = await srv.mem(true, true);
    await Promise.all(ds.map((d) => d.done));
    await sleep(1_000);
    const afterClose = await srv.mem(true);
    const stop = await srv.stop();
    const n = joined;
    const r = {
      rooms,
      sockets: n,
      heapPerEmptyRoom: (emptyRooms.heap - before.heap) / rooms,
      heapPerSocket: (full.heap - emptyRooms.heap) / n,
      rssPerSocket: (full.rss - emptyRooms.rss) / n,
      objectsPerSocket: (full.objects - emptyRooms.objects) / n,
      heapAfterClose: afterClose.heap,
      seatsInGraceAfterClose: afterClose.players,
      rss: { before: before.rss, full: full.rss, afterClose: afterClose.rss },
      stop,
      typesPerSocket: Object.fromEntries(
        Object.entries(full.types ?? {})
          .map(([k, v]) => [k, +((v - (emptyRooms.types?.[k] ?? 0)) / n).toFixed(2)] as const)
          .filter(([, d]) => d >= 0.5)
          .sort((a, b) => b[1] - a[1]),
      ),
    };
    out[type] = r;
    console.log("  object types per socket:", JSON.stringify(r.typesPerSocket));
    console.log(
      `idle ${type}: ${n} joined sockets in ${rooms} rooms — heap ${kb(r.heapPerSocket)}/socket (${r.objectsPerSocket.toFixed(0)} objects), RSS ${kb(r.rssPerSocket)}/socket, empty room ${kb(r.heapPerEmptyRoom)}; RSS ${fmtMB(before.rss)} → ${fmtMB(full.rss)} MB`,
    );
  }
  results.idle = out;
}

// ---- one room ------------------------------------------------------------------------------------------

async function room() {
  const out: Record<string, unknown> = {};
  for (const [type, players] of [
    ["action", 10],
    ["action", 50],
    ["action", 200],
    ["actionview", 50],
  ] as const) {
    // SOAK_ROOM=action:50 runs one configuration (e.g. for a CPU profile).
    if (process.env.SOAK_ROOM && process.env.SOAK_ROOM !== `${type}:${players}`) continue;
    const srv = await startServer({ SOAK_RATE: "100000" });
    const r = await srv.room(type);
    const K = Math.min(4, Math.ceil(players / 10));
    const durationMs = 10_000;
    const ds = Array.from({ length: K }, (_, k) => driver("flood", srv.port, { rooms: [{ type, id: r.id }], perRoom: Math.ceil(players / K), intervalMs: 0, durationMs, view: type === "actionview", vu: k }));
    await Promise.all(ds.map((d) => d.joined));
    const m0 = await srv.mem();
    const t0 = performance.now();
    const outs = await Promise.all(ds.map((d) => d.done));
    const secs = (performance.now() - t0) / 1000;
    const m1 = await srv.mem();
    await srv.stop();
    const g = merge(outs);
    const lat = g.ops["move → own update"];
    const res = {
      players: K * Math.ceil(players / K),
      msgsInPerSec: Math.round(g.framesOut / secs),
      framesOutPerSec: Math.round(g.framesIn / secs),
      mbOutPerSec: +(g.bytesIn / secs / 1048576).toFixed(1),
      latencyMs: lat,
      serverCpuPct: Math.round(((m1.cpuMs - m0.cpuMs) / (secs * 1000)) * 100),
      cpuUsPerMsgIn: +(((m1.cpuMs - m0.cpuMs) * 1000) / g.framesOut).toFixed(1),
      cpuUsPerFrameOut: +(((m1.cpuMs - m0.cpuMs) * 1000) / g.framesIn).toFixed(2),
      errors: g.errors,
    };
    out[`${type}x${players}`] = res;
    console.log(
      `room ${type} × ${res.players}: ${res.msgsInPerSec.toLocaleString()} msgs/s in, ${res.framesOutPerSec.toLocaleString()} frames/s out (${res.mbOutPerSec} MB/s); move→update p50 ${lat?.p50} / p99 ${lat?.p99} ms; server CPU ${res.serverCpuPct}% = ${res.cpuUsPerMsgIn} µs/msg in, ${res.cpuUsPerFrameOut} µs/frame out; errors ${JSON.stringify(g.errors)}`,
    );
  }
  results.room = out;
}

// ---- one process -----------------------------------------------------------------------------------------

async function processLoad() {
  const out: Record<string, unknown> = {};
  for (const rooms of [100, 250, 500]) {
    if (process.env.SOAK_ROOMS && Number(process.env.SOAK_ROOMS) !== rooms) continue;
    const srv = await startServer();
    const made = await Promise.all(Array.from({ length: rooms }, () => srv.room("action")));
    const K = 6;
    const durationMs = 15_000;
    const ds = Array.from({ length: K }, (_, k) => driver("flood", srv.port, { rooms: made.filter((_, i) => i % K === k).map((r) => ({ type: "action", id: r.id })), perRoom: 8, intervalMs: 50, durationMs, vu: k }));
    await Promise.all(ds.map((d) => d.joined));
    const m0 = await srv.mem();
    const t0 = performance.now();
    const outs = await Promise.all(ds.map((d) => d.done));
    const secs = (performance.now() - t0) / 1000;
    const m1 = await srv.mem();
    await srv.stop();
    const g = merge(outs);
    const lat = g.ops["move → own update"];
    const res = {
      rooms,
      players: rooms * 8,
      msgsInPerSec: Math.round(g.framesOut / secs),
      framesOutPerSec: Math.round(g.framesIn / secs),
      latencyMs: lat,
      serverCpuPct: Math.round(((m1.cpuMs - m0.cpuMs) / (secs * 1000)) * 100),
      cpuUsPerMsgIn: +(((m1.cpuMs - m0.cpuMs) * 1000) / g.framesOut).toFixed(1),
      rssMb: +fmtMB(m1.rss),
      errors: g.errors,
    };
    out[`rooms${rooms}`] = res;
    console.log(
      `process ${rooms} rooms × 8 players at 20 Hz: ${res.msgsInPerSec.toLocaleString()} msgs/s in, ${res.framesOutPerSec.toLocaleString()} frames/s out; p50 ${lat?.p50} / p99 ${lat?.p99} ms; server CPU ${res.serverCpuPct}% (${res.cpuUsPerMsgIn} µs/msg); RSS ${res.rssMb} MB; errors ${JSON.stringify(g.errors)}`,
    );
  }
  results.process = out;
}

// ---- soak ------------------------------------------------------------------------------------------------

/** Least-squares slope of y over x. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

async function soak() {
  const srv = await startServer();
  const base = await srv.mem(true, true);
  const durationMs = minutes * 60_000;
  const K = 4;
  const ds = Array.from({ length: K }, (_, k) => driver("life", srv.port, { vus: 20, durationMs, vu: k }));
  const samples: { t: number; heap: number; rss: number; objects: number; rooms: number; sockets: number }[] = [];
  const t0 = performance.now();
  let peakRss = 0;
  let peakRooms = 0;
  const sampler = (async () => {
    while (performance.now() - t0 < durationMs) {
      await sleep(15_000);
      const m = await srv.mem(true);
      peakRss = Math.max(peakRss, m.rss);
      peakRooms = Math.max(peakRooms, m.rooms);
      samples.push({ t: (performance.now() - t0) / 1000, heap: m.heap, rss: m.rss, objects: m.objects, rooms: m.rooms, sockets: m.sockets });
      console.log(`  t=${Math.round((performance.now() - t0) / 1000)}s heap(after GC) ${fmtMB(m.heap)} MB, RSS ${fmtMB(m.rss)} MB, ${m.rooms} rooms, ${m.sockets} sockets, ${m.objects} objects`);
    }
  })();
  const outs = await Promise.all(ds.map((d) => d.done));
  await sampler;
  const end = await srv.mem(true);
  // Reconnect grace (30 s) + empty-room disposal (30 s), then everything should be gone.
  await sleep(65_000);
  const settled = await srv.mem(true, true);
  const stop = await srv.stop();
  const g = merge(outs);
  // Ignore the first 20% (JIT warm-up, caches), as leakCheck does.
  const steady = samples.filter((s) => s.t >= (durationMs / 1000) * 0.2);
  const heapSlope = slope(steady.map((s) => s.t), steady.map((s) => s.heap)) * 60; // bytes per minute
  const objSlope = slope(steady.map((s) => s.t), steady.map((s) => s.objects)) * 60;
  const growth = Object.entries(settled.types ?? {})
    .map(([k, v]) => [k, v - (base.types?.[k] ?? 0)] as const)
    .filter(([, d]) => d > 50)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const res = {
    minutes,
    vus: K * 20,
    ops: g.ops,
    errors: g.errors,
    framesIn: g.framesIn,
    framesOut: g.framesOut,
    peakRooms,
    heapMb: { base: +fmtMB(base.heap), end: +fmtMB(end.heap), settled: +fmtMB(settled.heap) },
    rssMb: { base: +fmtMB(base.rss), peak: +fmtMB(peakRss), end: +fmtMB(end.rss), settled: +fmtMB(settled.rss) },
    heapSlopeKbPerMin: +(heapSlope / 1024).toFixed(1),
    objectSlopePerMin: Math.round(objSlope),
    settled: { rooms: settled.rooms, players: settled.players, sockets: settled.sockets, objects: settled.objects, objectsBase: base.objects },
    typeGrowthSettledVsBase: Object.fromEntries(growth),
    samples,
    stop,
  };
  results.soak = res;
  console.log(`soak ${minutes} min, ${res.vus} VUs: frames in ${g.framesIn.toLocaleString()}, out ${g.framesOut.toLocaleString()}; peak rooms ${peakRooms}`);
  for (const [k, v] of Object.entries(g.ops)) console.log(`  ${k}: n=${v.n} p50 ${v.p50} p95 ${v.p95} p99 ${v.p99} max ${v.max} ms`);
  console.log(`  errors: ${JSON.stringify(g.errors)}`);
  console.log(`  heap after GC: base ${res.heapMb.base} → end ${res.heapMb.end} → settled ${res.heapMb.settled} MB; steady-state slope ${res.heapSlopeKbPerMin} KB/min, ${res.objectSlopePerMin} objects/min`);
  console.log(`  RSS: base ${res.rssMb.base}, peak ${res.rssMb.peak}, end ${res.rssMb.end}, settled ${res.rssMb.settled} MB; settled rooms ${settled.rooms}, sockets ${settled.sockets}; exit after stop ${stop.exitedMs} ms (${stop.clean ? "clean" : "KILLED"})`);
  console.log(`  object types grown settled vs base: ${JSON.stringify(res.typeGrowthSettledVsBase)}`);
}

for (const p of phases.length ? phases : ["idle", "room", "process"]) {
  if (p === "idle") await idle();
  else if (p === "room") await room();
  else if (p === "process") await processLoad();
  else if (p === "soak") await soak();
  else throw new Error(`unknown phase ${p}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
