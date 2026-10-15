// In-process framework overhead benchmark: each framework's fetch handler is called directly
// with the same Request objects, so the numbers measure routing, validation and response
// building, not the network or Bun's HTTP server (identical for all three on Bun).
//
// Run: bun bench/run.ts   (then a memory table and a cold-start row)

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
const ROUNDS = 3;
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
const COLD_RUNS = 7;
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
