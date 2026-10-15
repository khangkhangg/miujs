import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { defineRoom, rooms, t } from "@miujs/realtime";
import { cleanup, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

const counter = defineRoom("counter", {
  state: t.object({ n: t.number() }),
  client: { inc: t.object({ by: t.number() }) },
  init: () => ({ n: 0 }),
  on: {
    inc: ({ room, msg }) => {
      room.state.n += msg.by;
    },
  },
});

let server: { url: string; stop(): Promise<void> };
let base = "";
beforeAll(async () => {
  server = await miu({ plugins: [rooms({ rooms: [counter] })], logLevel: "silent" }).listen(0);
  base = server.url.replace("http", "ws") + "rooms/counter/";
});
afterAll(() => server.stop());

describe("miu loadtest", () => {
  test("--json reports joined players, sends and latency percentiles", async () => {
    const r = await run(["loadtest", base + "c1", "--players", "3", "--duration", "300ms", "--rate", "20", "--action", '{"type":"inc","data":{"by":1}}', "--json"], tempDir());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.players).toBe(3);
    expect(report.joined).toBe(3);
    expect(report.sent).toBeGreaterThan(3);
    expect(report.samples).toBeGreaterThan(0);
    expect(report.errors).toBe(0);
    expect(report.latency.p99).toBeGreaterThanOrEqual(report.latency.p50);
  });

  test("prints p50/p95/p99 and errors; accepts a protocol frame as the action", async () => {
    const r = await run(["loadtest", base + "c2", "--players", "2", "--duration", "200ms", "--rate", "20", "--action", '{"t":"msg","type":"inc","data":{"by":2}}'], tempDir());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/p50\s+\d+(\.\d+)? ms/);
    expect(r.out).toMatch(/p95\s+\d+(\.\d+)? ms/);
    expect(r.out).toMatch(/p99\s+\d+(\.\d+)? ms/);
    expect(r.out).toContain("errors 0");
    expect(r.out).toContain("2/2 players joined");
  });

  test("error frames are counted by code and make the run fail", async () => {
    const r = await run(["loadtest", base + "c3", "--players", "1", "--duration", "150ms", "--rate", "20", "--action", '{"type":"nope"}'], tempDir());
    expect(r.code).toBe(1);
    expect(r.out).toContain("MIU_E_ROOM_UNKNOWN_MESSAGE");
  });

  test("an action array is cycled", async () => {
    const r = await run(["loadtest", base + "c4", "--players", "1", "--duration", "200ms", "--rate", "20", "--action", '[{"type":"inc","data":{"by":1}},{"type":"inc","data":{"by":5}}]', "--json"], tempDir());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).errors).toBe(0);
  });

  test("bad input is a MIU_E_CLI_ error with a fix", async () => {
    const noUrl = await run(["loadtest", "--players", "2"], tempDir());
    expect(noUrl.code).toBe(1);
    expect(noUrl.err).toContain("MIU_E_CLI_LOADTEST_USAGE");
    const badJson = await run(["loadtest", base + "x", "--action", "{nope"], tempDir());
    expect(badJson.err).toContain("MIU_E_CLI_FLAG_VALUE");
    const badDuration = await run(["loadtest", base + "x", "--action", '{"type":"inc"}', "--duration", "soon"], tempDir());
    expect(badDuration.err).toContain("MIU_E_CLI_FLAG_VALUE");
    const http = await run(["loadtest", "http://localhost/x", "--action", '{"type":"inc"}'], tempDir());
    expect(http.err).toContain("MIU_E_CLI_LOADTEST_USAGE");
    expect(http.err).toContain("ws://");
  });
});
