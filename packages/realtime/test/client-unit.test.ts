import { expect, test } from "bun:test";
import { connect } from "../src/client.ts";
import { FakeWS } from "./fakews.ts";

for (const [code, why] of [
  [4008, "kicked for flooding"],
  [1009, "message too big"],
  [1003, "unsupported encoding"],
] as const) {
  test(`close code ${code} (${why}) does not auto-reconnect`, () => {
    const c = connect("ws://x/rooms/x/1", { name: "Ann", WebSocket: FakeWS as any });
    const closes: any[] = [];
    c.on("close", (e) => closes.push(e));
    FakeWS.last().joined({});
    FakeWS.last().drop(code);
    expect(closes).toEqual([{ code, reason: "", willReconnect: false }]);
  });
}

test("params are sent as join query parameters (for onJoinRequest); built-in names cannot be overridden", () => {
  connect("ws://x/rooms/x/1", { name: "Ann", WebSocket: FakeWS as any, params: { guide: "tok en", name: "Mallory", ticket: "7" } });
  const u = new URL(FakeWS.last().url);
  expect(u.searchParams.get("guide")).toBe("tok en");
  expect(u.searchParams.get("ticket")).toBe("7");
  expect(u.searchParams.get("name")).toBe("Ann");
});
