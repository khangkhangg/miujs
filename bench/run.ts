// In-process framework overhead benchmark: each framework's fetch handler is called directly
// with the same Request objects, so the numbers measure routing, validation and response
// building, not the network or Bun's HTTP server (identical for all three on Bun).
//
// Run: bun bench/run.ts   (then a memory table and a cold-start row)
//      BENCH_HTTP=1 bun bench/run.ts   (adds GET / over real HTTP via Bun.serve)
//      bun bench/run.ts --json out.json   (also writes the results as JSON, for bench/compare.ts)
//      BENCH_ROUNDS=5 BENCH_MS=1000 bun bench/run.ts   (rounds per framework and scenario; ms per round)

import { Elysia, t as et } from "elysia";
import { Hono } from "hono";
import { miu, route, t } from "miujs";
import { heapStats } from "bun:jsc";
import { leakCheck } from "../scripts/lib/leak.ts";

type Fetch = (req: Request) => Response | Promise<Response>;

// ---- apps ----

const miuApp = miu({
  dev: false,
  logLevel: "silent",
  routes: [
    route.get("/", { handler: () => "Hi" }),
    route.get("/users/:id", { params: t.object({ id: t.string() }), handler: ({ params }) => ({ id: params.id, name: "Mia" }) }),
    route.post("/json", {
      body: t.object({ name: t.string(), qty: t.integer({ min: 1 }) }),
      handler: ({ body }) => ({ ok: true, name: body.name, qty: body.qty }),
    }),
  ],
});
await miuApp.ready();

const elysiaApp = new Elysia()
  .get("/", () => "Hi")
  .get("/users/:id", ({ params }) => ({ id: params.id, name: "Mia" }), { params: et.Object({ id: et.String() }) })
  .post("/json", ({ body }) => ({ ok: true, name: body.name, qty: body.qty }), {
    body: et.Object({ name: et.String(), qty: et.Integer({ minimum: 1 }) }),
  });

const honoApp = new Hono()
  .get("/", (c) => c.text("Hi"))
  .get("/users/:id", (c) => c.json({ id: c.req.param("id"), name: "Mia" }))
  .post("/json", async (c) => {
    const body = await c.req.json();
    // Hand-written check, equivalent to the schemas above (Hono has no built-in validator).
    if (typeof body?.name !== "string" || !Number.isInteger(body?.qty) || body.qty < 1) return c.json({ error: "invalid" }, 400);
    return c.json({ ok: true, name: body.name, qty: body.qty });
  });

const apps: Record<string, Fetch> = {
  miujs: (r) => miuApp.fetch(r),
  elysia: (r) => elysiaApp.handle(r),
  hono: (r) => honoApp.fetch(r),
};

// ---- scenarios ----

const scenarios: Record<string, () => Request> = {
  "GET / (text)": () => new Request("http://localhost/"),
  "GET /users/:id (params → JSON)": () => new Request("http://localhost/users/42"),
  "POST /json (body validation → JSON)": () =>
    new Request("http://localhost/json", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"tea","qty":2}' }),
};

// Sanity check: every app returns the same thing.
for (const [name, make] of Object.entries(scenarios)) {
  const bodies = await Promise.all(Object.values(apps).map(async (f) => (await f(make())).text()));
  if (new Set(bodies).size !== 1) throw new Error(`apps disagree on ${name}: ${bodies.join(" | ")}`);
}

async function measure(f: Fetch, make: () => Request, ms: number): Promise<number> {
  const BATCH = 1000;
  // Warm up the JIT.
  for (let i = 0; i < 20_000; i++) await (await f(make())).text();
  let n = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    for (let i = 0; i < BATCH; i++) await (await f(make())).text();
    n += BATCH;
  }
  return n / (ms / 1000);
}

const DURATION = Number(process.env.BENCH_MS ?? 2000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const jsonFlag = process.argv.indexOf("--json");
const JSON_OUT = jsonFlag === -1 ? undefined : process.argv[jsonFlag + 1];
if (jsonFlag !== -1 && !JSON_OUT) throw new Error("--json needs a file path");
console.log(`Bun ${Bun.version} · in-process fetch() · ${ROUNDS} rounds × ${DURATION} ms, best round kept\n`);

// Frameworks are interleaved within each round (and the order rotates), so CPU frequency
// drift or thermal throttling during the run hits every framework equally.
const results: Record<string, Record<string, number>> = {};
const names = Object.keys(apps);
for (const [sname, make] of Object.entries(scenarios)) {
  results[sname] = Object.fromEntries(names.map((n) => [n, 0]));
  for (let r = 0; r < ROUNDS; r++) {
    const order = names.map((_, i) => names[(i + r) % names.length]);
    for (const aname of order) results[sname][aname] = Math.max(results[sname][aname], await measure(apps[aname], make, DURATION));
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US").padStart(11);
console.log(`${"scenario".padEnd(38)}${Object.keys(apps).map((a) => a.padStart(11)).join("")}   miujs vs best other`);
for (const [sname, row] of Object.entries(results)) {
  const others = Object.entries(row).filter(([a]) => a !== "miujs").map(([, v]) => v);
  const ratio = row.miujs / Math.max(...others);
  console.log(`${sname.padEnd(38)}${Object.values(row).map(fmt).join("")}   ${(ratio * 100).toFixed(0)}%`);
}
console.log("\nreq/s, higher is better.");

// ---- GET / with Bun's server as the 2nd argument (in-process) ----
// Bun.serve calls `fetch(req, server)`. MiuJS only skips `content-type` on string responses when
// that argument is Bun's real server (Bun then adds `text/plain;charset=utf-8` on the wire), so
// the table above, which calls `fetch(req)` like a test does, still pays for the header. This row
// passes a real server object, the way `export default app` / `app.listen()` run on Bun.
const argServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const serverArgApps: Record<string, Fetch> = {
  miujs: (r) => miuApp.fetch(r, argServer),
  elysia: (r) => elysiaApp.handle(r),
  hono: (r) => honoApp.fetch(r, argServer),
};
const argRow: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
for (let r = 0; r < ROUNDS; r++) {
  for (const aname of names.map((_, i) => names[(i + r) % names.length])) {
    argRow[aname] = Math.max(argRow[aname], await measure(serverArgApps[aname], scenarios["GET / (text)"], DURATION));
  }
}
argServer.stop(true);
const ratioOf = (row: Record<string, number>) => row.miujs / Math.max(...Object.entries(row).filter(([a]) => a !== "miujs").map(([, v]) => v));
console.log(`\nIn-process, fetch(req, bunServer) as Bun.serve calls it (best of ${ROUNDS})`);
console.log(`${"GET / (text), server arg".padEnd(38)}${names.map((a) => fmt(argRow[a])).join("")}   ${(ratioOf(argRow) * 100).toFixed(0)}%`);

// ---- optional: over real HTTP (BENCH_HTTP=1) ----
// Each framework behind its own Bun.serve on 127.0.0.1; the load comes from Worker threads (keep-alive
// fetch loops), so the server's event loop does only server work. Includes Bun's HTTP stack and the
// client, so framework differences shrink; treat small gaps as noise.
if (process.env.BENCH_HTTP === "1") {
  const CLIENTS = Number(process.env.BENCH_HTTP_CLIENTS ?? 2);
  const CONC = Number(process.env.BENCH_HTTP_CONC ?? 32);
  const servers = {
    miujs: Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: miuApp.fetch }),
    elysia: Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => elysiaApp.handle(r) }),
    hono: Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: honoApp.fetch }),
    // Ceiling: Bun.serve with no framework, the most any of the three can reach on this machine.
    bare: Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("Hi") }),
  } as Record<string, ReturnType<typeof Bun.serve>>;
  for (const [aname, s] of Object.entries(servers)) {
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    if ((await res.text()) !== "Hi" || !/^text\/plain/i.test(res.headers.get("content-type") ?? "")) {
      throw new Error(`${aname}: GET / over HTTP returned ${res.headers.get("content-type")}`);
    }
  }
  const workerSrc = `
    self.onmessage = async (e) => {
      const { url, conc, ms } = e.data;
      let n = 0;
      const end = performance.now() + ms;
      // A stuck connection fails after 5 s instead of hanging the run (seen on Windows above ~64 connections).
      const loop = async () => {
        while (performance.now() < end) {
          try { await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text(); n++; } catch {}
        }
      };
      await Promise.all(Array.from({ length: conc }, loop));
      postMessage(n);
    };`;
  const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));
  const workers = Array.from({ length: CLIENTS }, () => new Worker(workerUrl));
  const runLoad = (url: string, ms: number) =>
    Promise.all(
      workers.map(
        (w) =>
          new Promise<number>((resolve) => {
            w.onmessage = (e) => resolve(e.data as number);
            w.postMessage({ url, conc: CONC, ms });
          }),
      ),
    ).then((ns) => ns.reduce((a, b) => a + b, 0) / (ms / 1000));
  const httpRow: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  let bare = 0;
  for (let r = 0; r < ROUNDS; r++) {
    for (const aname of [...names.map((_, i) => names[(i + r) % names.length]), "bare"]) {
      const url = `http://127.0.0.1:${servers[aname].port}/`;
      await runLoad(url, 300); // warm-up
      const rps = await runLoad(url, DURATION);
      if (aname === "bare") bare = Math.max(bare, rps);
      else httpRow[aname] = Math.max(httpRow[aname], rps);
    }
  }
  for (const w of workers) w.terminate();
  for (const s of Object.values(servers)) s.stop(true);
  console.log(`\nOver HTTP, Bun.serve on 127.0.0.1, ${CLIENTS} client workers × ${CONC} keep-alive connections (best of ${ROUNDS})`);
  console.log(`${"GET / (text), HTTP".padEnd(38)}${names.map((a) => fmt(httpRow[a])).join("")}   ${(ratioOf(httpRow) * 100).toFixed(0)}%`);
  console.log(`${"  (bare Bun.serve, no framework)".padEnd(38)}${fmt(bare)}`);
}

// ---- memory: heap per 10k requests (in-process) ----
// retained: live-heap growth per 10k requests after a full GC (leakCheck from scripts/lib/leak.ts);
//   a healthy framework is ~0.
// peak: highest heap size above the post-GC baseline while serving 10k requests, sampled every
//   500 requests. JSC collects eden garbage on its own schedule, so this is an approximate
//   garbage-pressure figure, not an exact allocation count.

async function peakHeap(f: Fetch, make: () => Request): Promise<number> {
  Bun.gc(true);
  Bun.gc(true);
  const base = heapStats().heapSize;
  let peak = base;
  for (let i = 0; i < 10_000; i++) {
    await (await f(make())).text();
    if (i % 500 === 499) peak = Math.max(peak, heapStats().heapSize);
  }
  return peak - base;
}

const MEM_ROUNDS = 2;
const mem: Record<string, Record<string, { retained: number; peak: number }>> = {};
for (const [sname, make] of Object.entries(scenarios)) {
  mem[sname] = Object.fromEntries(names.map((n) => [n, { retained: Infinity, peak: Infinity }]));
  for (let r = 0; r < MEM_ROUNDS; r++) {
    const order = names.map((_, i) => names[(i + r) % names.length]);
    for (const aname of order) {
      const f = apps[aname];
      const lr = await leakCheck(`${aname} ${sname}`, async () => void (await (await f(make())).text()), { warmup: 2000, rounds: 4, perRound: 10_000 });
      const m = mem[sname][aname];
      m.retained = Math.min(m.retained, lr.bytesPerIteration * 10_000);
      m.peak = Math.min(m.peak, await peakHeap(f, make));
    }
  }
}
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
console.log(`\nHeap per 10k requests, in-process (best of ${MEM_ROUNDS}): retained after GC / peak above baseline`);
console.log(`${"scenario".padEnd(38)}${names.map((a) => a.padStart(24)).join("")}`);
for (const [sname, row] of Object.entries(mem)) {
  console.log(`${sname.padEnd(38)}${names.map((a) => `${kb(row[a].retained)} / ${kb(row[a].peak)}`.padStart(24)).join("")}`);
}

// ---- cold start: fresh process → first response (bench/cold.ts) ----
const COLD_RUNS = Number(process.env.BENCH_COLD_RUNS ?? 7);
const cold: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
for (let r = 0; r < COLD_RUNS; r++) {
  for (const aname of names.map((_, i) => names[(i + r) % names.length])) {
    const p = Bun.spawnSync([process.execPath, `${import.meta.dir}/cold.ts`, aname], { cwd: import.meta.dir });
    const ms = Number(p.stdout.toString().trim());
    if (!Number.isFinite(ms)) throw new Error(`cold start ${aname} failed: ${p.stderr.toString()}`);
    cold[aname].push(ms);
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\nCold start (process start → first response, median of ${COLD_RUNS}, ms)`);
console.log(`${"".padEnd(38)}${names.map((a) => a.padStart(11)).join("")}`);
console.log(`${"cold start".padEnd(38)}${names.map((a) => median(cold[a]).toFixed(1).padStart(11)).join("")}`);

// ---- JSON output for bench/compare.ts (the CI regression gate) ----
if (JSON_OUT) {
  const out = {
    version: 1,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
    rounds: ROUNDS,
    durationMs: DURATION,
    /** req/s per framework, best round (higher is better). */
    throughput: { ...results, "GET / (text), server arg": argRow },
    /** Bytes per 10k requests, best of the memory rounds (retained after GC / peak above baseline). */
    memory: mem,
    /** Median ms, process start → first response (lower is better). */
    coldStartMs: Object.fromEntries(names.map((a) => [a, median(cold[a])])),
  };
  await Bun.write(JSON_OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${JSON_OUT}`);
}
