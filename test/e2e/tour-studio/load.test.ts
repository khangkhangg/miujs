/**
 * Smoke load: 3 s of the realistic Tour Studio mix (bench/scenarios/tour-studio.ts) at concurrency 16 against
 * the real Bun server in production mode. Asserts zero errors only — never latency — so CI catches functional
 * regressions under concurrency (SQLite busy errors, races, leaked handles) without flakiness.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { runScenario } from "../../../bench/lib/scenario.ts";
import { startServer, type Server } from "./helpers.ts";

let server: Server;
beforeAll(async () => {
  server = await startServer({ env: { LOG_REQUESTS: "0" } });
}, 60_000);
afterAll(() => server?.stop());

test("3 s of the mixed scenario at concurrency 16: zero errors on every step", async () => {
  const report = await runScenario({
    scenario: new URL("../../../bench/scenarios/tour-studio.ts", import.meta.url).pathname,
    url: server.url,
    duration: 3,
    concurrency: 16,
    workers: 2,
    warmup: 0,
  });
  if (report.total.errors) console.log(report.markdown);
  for (const s of report.steps) {
    expect({ step: s.name, errors: s.errors }).toEqual({ step: s.name, errors: 0 });
    expect(s.requests).toBeGreaterThan(0);
  }
  expect(report.total.requests).toBeGreaterThan(500);
  expect(server.output()).not.toMatch(/Unhandled error|SQLITE_BUSY|database is locked|ERR_INVALID_STATE/);
}, 60_000);
