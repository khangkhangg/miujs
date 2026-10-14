// In-process overhead benchmark: calls each framework's fetch handler directly (no network).
// bun micro.ts [--iterations 100000] [--rounds 5]   (frameworks interleaved per round; median reported)
import { Hono } from "hono";
import { Elysia, t as et } from "elysia";
import { Miu, t } from "../src/index.ts";

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const iterations = arg("iterations", 100_000);
const rounds = arg("rounds", 5);
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const miu = new Miu({ logger: false })
  .get("/", () => "Hi")
  .get("/user/:id", (c) => ({ id: c.params.id }))
  .post("/json", { body: t.object({ name: t.string(), age: t.integer() }) }, (c) => c.body);

const hono = new Hono()
  .get("/", (c) => c.text("Hi"))
  .get("/user/:id", (c) => c.json({ id: c.req.param("id") }))
  .post("/json", async (c) => c.json(await c.req.json()));

const elysia = new Elysia()
  .get("/", () => "Hi")
  .get("/user/:id", ({ params }) => ({ id: params.id }))
  .post("/json", ({ body }) => body, { body: et.Object({ name: et.String(), age: et.Integer() }) });

const handlers: Record<string, (r: Request) => Response | Promise<Response>> = {
  miu: (r) => miu.fetch(r),
  hono: (r) => hono.fetch(r),
  elysia: (r) => elysia.handle(r),
};

const cases: [string, () => Request][] = [
  ["GET / (text)", () => new Request("http://localhost/")],
  ["GET /user/:id (JSON)", () => new Request("http://localhost/user/42")],
  [
    "POST /json (validated)",
    () =>
      new Request("http://localhost/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"miu","age":3}',
      }),
  ],
];

async function measure(h: (r: Request) => Response | Promise<Response>, make: () => Request) {
  for (let i = 0; i < 20_000; i++) await (await h(make())).text(); // warm up JIT
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await (await h(make())).text();
  return iterations / ((performance.now() - start) / 1000);
}

const rows: string[] = ["| Case | " + Object.keys(handlers).join(" | ") + " |", "| --- |" + " ---: |".repeat(3)];
for (const [name, make] of cases) {
  const samples = Object.keys(handlers).map(() => [] as number[]);
  for (let r = 0; r < rounds; r++) {
    const hs = Object.values(handlers);
    for (let i = 0; i < hs.length; i++) samples[i]!.push(await measure(hs[i]!, make));
  }
  rows.push(`| ${name} | ${samples.map((x) => Math.round(median(x)).toLocaleString("en-US")).join(" | ")} |`);
}
console.log(rows.join("\n"));
