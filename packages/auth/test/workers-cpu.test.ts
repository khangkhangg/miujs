// PBKDF2 on Cloudflare Workers: ~250 ms CPU per hash at 600k iterations (scripts/workerd/REPORT.md),
// while the Free plan allows 10 ms per request. auth() warns once instead of weakening the hash,
// and asks `miu deploy cloudflare` for a CPU limit that fits.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { miu } from "miujs";
import { session } from "@miujs/session";
import { auth } from "../src/index.ts";
import { pbkdf2WorkersCpuMs, workersCpuWarning, WORKERS_FREE_CPU_MS } from "../src/password.ts";

const SECRET = "workers-cpu-test-secret-0123456789abcdef";
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  delete process.env.MIU_TARGET;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.MIU_TARGET;
  warn.mockRestore();
});

const warnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("PBKDF2"));

test("the estimate scales with iterations: 600k is about 250 ms on workerd", () => {
  expect(pbkdf2WorkersCpuMs(600_000)).toBeGreaterThanOrEqual(240);
  expect(pbkdf2WorkersCpuMs(600_000)).toBeLessThanOrEqual(260);
  expect(pbkdf2WorkersCpuMs(300_000)).toBeCloseTo(pbkdf2WorkersCpuMs(600_000) / 2, -1);
  expect(WORKERS_FREE_CPU_MS).toBe(10);
});

test("workersCpuWarning: over the budget explains the options; within it, or argon2id, or false: nothing", () => {
  const msg = workersCpuWarning({})!;
  expect(msg).toContain("600000 iterations");
  expect(msg).toContain("10 ms");
  expect(msg).toContain("cpu_ms");
  expect(msg).toContain("iterations");
  expect(msg).toMatch(/passkeys|OAuth/);
  expect(workersCpuWarning({ iterations: 20_000 })).toBeNull();
  expect(workersCpuWarning({ workersCpuMs: 1000 })).toBeNull();
  expect(workersCpuWarning({ workersCpuMs: 100 })).toContain("100 ms");
  expect(workersCpuWarning({ workersCpuMs: false })).toBeNull();
  expect(workersCpuWarning({ algorithm: "argon2id" })).toBeNull();
});

test("on Workers, auth() warns once at startup when PBKDF2 exceeds the CPU budget", async () => {
  process.env.MIU_TARGET = "cloudflare";
  const app = miu({ logLevel: "warn", plugins: [session({ secret: SECRET }), auth()] });
  await app.ready();
  await app.request("/auth/me");
  await app.request("/auth/me");
  expect(warnings().length).toBe(1);
  expect(warnings()[0]).toContain("cpu_ms");
});

test("no warning off Workers, or when the budget fits", async () => {
  const bun = miu({ logLevel: "warn", plugins: [session({ secret: SECRET }), auth()] });
  await bun.ready();
  process.env.MIU_TARGET = "cloudflare";
  const fits = miu({ logLevel: "warn", plugins: [session({ secret: SECRET }), auth({ password: { workersCpuMs: 2000 } })] });
  await fits.ready();
  expect(warnings()).toEqual([]);
});

test("cloudflare() asks for a CPU limit when PBKDF2 needs more than the Free plan's 10 ms", () => {
  const needs = auth().cloudflare();
  expect(needs.limits?.cpuMs).toBeGreaterThanOrEqual(2 * pbkdf2WorkersCpuMs(600_000));
  expect(auth({ password: { workersCpuMs: 5000 } }).cloudflare().limits?.cpuMs).toBe(5000);
  expect(auth({ password: { iterations: 20_000 } }).cloudflare().limits).toBeUndefined();
  expect(auth({ password: { algorithm: "argon2id" } }).cloudflare().limits).toBeUndefined();
});
