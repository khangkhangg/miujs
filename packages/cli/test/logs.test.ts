import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeRunner, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

const LINES = [
  { level: "info", time: "2026-10-15T10:00:00.000Z", msg: "server started", app: "demo" },
  { level: "info", time: "2026-10-15T10:00:01.250Z", msg: "request", app: "demo", requestId: "r-1", method: "GET", path: "/users/7", route: "getUser", status: 200, ms: 3.25 },
  "plain text from a library",
  { level: "error", time: "2026-10-15T10:00:02.000Z", msg: "boom", app: "demo", requestId: "r-2", code: "MIU_E_INTERNAL" },
  { level: "warn", time: "2026-10-15T10:00:03.000Z", msg: "slow", app: "demo", requestId: "r-3", route: "listNotes", status: 200, ms: 812 },
];

function logFile(dir: string) {
  const file = join(dir, "app.log");
  writeFileSync(file, LINES.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

describe("miu logs --file", () => {
  test("pretty-prints level, msg, route, status, ms and requestId", async () => {
    const dir = tempDir();
    logFile(dir);
    const r = await run(["logs", "--file", "app.log"], dir);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("10:00:01.250");
    expect(lines[1]).toMatch(/INFO\s+request getUser 200 3\.25ms \[r-1\]/);
    expect(lines[1]).toContain("GET /users/7");
    expect(lines[2]).toBe("plain text from a library");
    expect(lines[3]).toMatch(/ERROR\s+boom \[r-2\] code=MIU_E_INTERNAL/);
  });

  test("--last N keeps the last N lines", async () => {
    const dir = tempDir();
    logFile(dir);
    const r = await run(["logs", "--file", "app.log", "--last", "2"], dir);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("boom");
    expect(lines[1]).toContain("slow");
  });

  test("--json prints one normalized object per line", async () => {
    const dir = tempDir();
    logFile(dir);
    const r = await run(["logs", "--file", "app.log", "--json", "--last", "4"], dir);
    const objs = r.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(objs[0]).toMatchObject({ level: "info", msg: "request", requestId: "r-1", route: "getUser", status: 200, ms: 3.25 });
    expect(objs[1]).toMatchObject({ level: "info", msg: "plain text from a library" });
  });

  test("a missing file is MIU_E_CLI_LOGS_FILE", async () => {
    const r = await run(["logs", "--file", "nope.log"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_LOGS_FILE");
  });

  test("no log source is MIU_E_CLI_LOGS_SOURCE with a fix", async () => {
    const r = await run(["logs"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_LOGS_SOURCE");
    expect(r.err).toContain("--file");
  });
});

// `wrangler tail --format json` prints one pretty-printed JSON object per event.
const tailEvent = (logs: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      outcome: "ok",
      scriptName: "demo",
      exceptions: [],
      logs,
      eventTimestamp: 1760522400000,
      event: { request: { url: "https://demo.workers.dev/users/7", method: "GET" }, response: { status: 200 } },
      ...extra,
    },
    null,
    2,
  );

describe("miu logs on Cloudflare", () => {
  const appLine = JSON.stringify({ level: "info", time: "2026-10-15T10:00:00.000Z", msg: "request", requestId: "cf-1", route: "getUser", status: 200, ms: 4 });

  test("wraps wrangler tail --format json and pretty-prints the app's JSON log lines", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "wrangler.toml"), 'name = "demo"\n');
    const stream = tailEvent([{ message: [appLine], level: "log", timestamp: 1760522400000 }]) + "\n" + tailEvent([{ message: ["plain", 42], level: "warn", timestamp: 1760522401000 }]);
    // Deliver the stream in awkward chunks, as a pipe would.
    const { runner, calls } = fakeRunner((_cmd, opts) => {
      for (let i = 0; i < stream.length; i += 37) opts.onStdout!(stream.slice(i, i + 37));
      return {};
    });
    const r = await run(["logs"], dir, runner);
    expect(r.code).toBe(0);
    expect(calls[0].cmd.slice(calls[0].cmd.indexOf("wrangler"))).toEqual(["wrangler", "tail", "--format", "json"]);
    expect(r.out).toMatch(/INFO\s+request getUser 200 4ms \[cf-1\]/);
    expect(r.out).toMatch(/WARN\s+plain 42/);
  });

  test("quotes and braces inside log messages do not confuse the stream splitter", async () => {
    const tricky = JSON.stringify({ level: "info", msg: 'quote " then brace } then {', requestId: "q-1" });
    const stream = tailEvent([{ message: [tricky], level: "log", timestamp: 0 }]) + tailEvent([{ message: ["after"], level: "log", timestamp: 0 }]);
    const { runner } = fakeRunner((_c, opts) => {
      opts.onStdout!(stream);
      return {};
    });
    const r = await run(["logs", "--worker", "demo", "--json"], tempDir(), runner);
    const objs = r.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(objs.map((o) => o.msg)).toEqual(['quote " then brace } then {', "after"]);
  });

  test("--worker names the script; exceptions print as errors; --json works", async () => {
    const { runner, calls } = fakeRunner((_c, opts) => {
      opts.onStdout!(tailEvent([], { outcome: "exception", exceptions: [{ name: "TypeError", message: "x is undefined", timestamp: 1760522400000 }] }));
      return {};
    });
    const r = await run(["logs", "--worker", "demo-prod", "--json"], tempDir(), runner);
    expect(calls[0].cmd).toContain("demo-prod");
    const obj = JSON.parse(r.out.trim().split("\n")[0]);
    expect(obj).toMatchObject({ level: "error", msg: "TypeError: x is undefined" });
  });

  test("--last N stops the tail after N entries", async () => {
    let aborted = false;
    const { runner } = fakeRunner(async (_c, opts) => {
      opts.signal!.addEventListener("abort", () => (aborted = true));
      for (let i = 0; i < 5; i++) {
        if (opts.signal!.aborted) break;
        opts.onStdout!(tailEvent([{ message: [JSON.stringify({ level: "info", msg: `n${i}` })], level: "log", timestamp: 0 }]));
      }
      return {};
    });
    const r = await run(["logs", "--worker", "demo", "--last", "2"], tempDir(), runner);
    expect(aborted).toBe(true);
    expect(r.out.trim().split("\n")).toHaveLength(2);
  });

  test("wrangler failing is MIU_E_CLI_WRANGLER", async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stderr: "You are not logged in" }));
    const r = await run(["logs", "--worker", "demo"], tempDir(), runner);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_WRANGLER");
  });
});
