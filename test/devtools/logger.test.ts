import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { devErrors, devLogger, getTiming, timing } from "../../src/devtools/index.ts";

function make(opts: Parameters<typeof devLogger>[0] = {}) {
  const lines: string[] = [];
  const app = new Miu({ logger: false });
  app.use(devLogger({ write: (s) => lines.push(s), ...opts }));
  app.use(timing());
  app.onError(devErrors({ log: () => {} }));
  app.get("/ok", (c) => {
    getTiming(c).add("db", 2.5, "query");
    return "ok";
  });
  app.get("/fail", () => {
    throw new Error("nope");
  });
  return { app, lines };
}

const ANSI = /\x1b\[[0-9;]*m/;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("devLogger()", () => {
  test("prints a colored request line with timing marks in development", async () => {
    const { app, lines } = make({ colors: true });
    await app.request("/ok");
    expect(lines[0]).toMatch(ANSI);
    expect(strip(lines[0]!)).toMatch(/^GET \/ok 200 \d+(\.\d+)?ms/);
    expect(strip(lines.join("\n"))).toContain("db 2.5ms query");
  });

  test("colors: false prints plain text", async () => {
    const { app, lines } = make({ colors: false });
    await app.request("/ok");
    expect(lines.join("")).not.toMatch(ANSI);
  });

  test("prints the error and a clickable file:line for failures", async () => {
    const { app, lines } = make({ colors: false });
    await app.request("/fail");
    const out = lines.join("\n");
    expect(out).toMatch(/^GET \/fail 500/);
    expect(out).toContain("Error: nope");
    expect(out).toMatch(/\/test\/devtools\/logger\.test\.ts:\d+:\d+/);
  });

  test("falls back to one JSON line per request in production", async () => {
    const { app, lines } = make();
    await app.request("/ok", undefined, { NODE_ENV: "production" });
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ method: "GET", path: "/ok", status: 200 });
  });
});
