import { expect, test } from "bun:test";
import { findMatch } from "../src/client.ts";

/** A server that queues the player and never matches them, recording every request. */
function neverMatches() {
  const calls: { method: string; path: string }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method ?? "GET", path });
    if (path.endsWith("/leave")) return Response.json({ queue: "duel", left: true });
    return Response.json({ status: { state: "queued" } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test("findMatch leaves the queue when it gives up, so the server never matches a player who is gone", async () => {
  const server = neverMatches();
  const err = await findMatch("http://game.test", "duel", { fetch: server.fetch, timeoutMs: 0, waitMs: 1 }).catch((e) => e);
  expect(err.code).toBe("MIU_E_GAME_MATCH_TIMEOUT");
  expect(server.calls.at(-1)).toEqual({ method: "DELETE", path: "/match/duel/leave" });
});

test("a failing leave call does not hide the timeout", async () => {
  const fetch = (async (url: string, init: RequestInit = {}) => {
    if (new URL(url).pathname.endsWith("/leave") || init.method === "DELETE") throw new Error("network down");
    return Response.json({ status: { state: "queued" } });
  }) as unknown as typeof globalThis.fetch;
  const err = await findMatch("http://game.test", "duel", { fetch, timeoutMs: 0, waitMs: 1 }).catch((e) => e);
  expect(err.code).toBe("MIU_E_GAME_MATCH_TIMEOUT");
});
