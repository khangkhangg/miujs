import { afterAll, expect, test } from "bun:test";
import { Miu } from "../../src/index.ts";
import { runScenario } from "../../bench/lib/scenario.ts";

const app = new Miu({ logger: false })
  .get("/", () => "ok")
  .post("/seed", () => ({ id: "abc" }))
  .get("/items/:id", (c) => ({ id: c.params.id }))
  .get("/boom", () => {
    throw new Error("x");
  });
const server = Bun.serve(app.serveOptions({ port: 0 }));
afterAll(() => server.stop(true));

test("runScenario drives weighted steps across workers and merges per-step stats", async () => {
  const report = await runScenario({
    scenario: new URL("./fixtures/scenario.ts", import.meta.url).pathname,
    url: `http://127.0.0.1:${server.port}`,
    duration: 1,
    concurrency: 8,
    workers: 2,
    warmup: 0,
  });
  const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
  expect(Object.keys(byName).sort()).toEqual(["broken", "home", "item"]);
  expect(byName.home!.requests).toBeGreaterThan(byName.item!.requests * 2);
  expect(byName.home!.errors).toBe(0);
  expect(byName.broken!.errors).toBe(byName.broken!.requests); // 500s count as errors
  expect(byName.item!.p50).toBeGreaterThan(0);
  expect(report.total.rps).toBeGreaterThan(100);
  expect(report.markdown).toContain("| home |");
}, 30_000);
