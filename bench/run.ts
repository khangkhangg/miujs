// In-process framework overhead benchmark: each framework's fetch handler is called directly
// with the same Request objects, so the numbers measure routing, validation and response
// building, not the network or Bun's HTTP server (identical for all three on Bun).
//
// Run: bun bench/run.ts

import { Elysia, t as et } from "elysia";
import { Hono } from "hono";
import { miu, route, t } from "miujs";

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
