// Browser/Bun client helpers for matches (no server imports).
//
//   const m = await findMatch("https://game.example", "ranked", { headers: { authorization } });
//   const { room, seated } = connectMatch("wss://game.example" + m.room.url, m.ticket, { name: "Ann" });
//   await seated;               // the room accepted the ticket
//   room.send("move", { cell: 4 });

import { connect, type ConnectOptions, type RoomClient } from "@miujs/realtime/client";

export interface SeatInfo {
  userId: string;
  name: string;
  team: number;
  matchId: string;
}

export interface MatchedStatus {
  state: "matched";
  matchId: string;
  room: { type: string; id: string; url: string };
  ticket: string;
  team: number;
  at: number;
}

export interface FindMatchOptions {
  /** Auth headers for the matchmaker routes (e.g. `authorization`). Cookies work too in browsers. */
  headers?: Record<string, string>;
  region?: string;
  /** Long-poll wait per status request. Default 20 000 ms. */
  waitMs?: number;
  /** Give up after this long. Default 120 000 ms. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function fail(body: any, fallback: string): Error {
  const e = body?.error;
  return Object.assign(new Error(e?.message ?? fallback), { code: e?.code ?? "MIU_E_GAME_MATCH_FAILED", fix: e?.fix });
}

/** Join a queue and wait (long-polling) until matched. Resolves with the room and a fresh ticket. */
export async function findMatch(baseUrl: string, queue: string, o: FindMatchOptions = {}): Promise<MatchedStatus> {
  const f = o.fetch ?? fetch;
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(o.headers ?? {}) };
  const res = await f(`${base}/match/${encodeURIComponent(queue)}/join`, { method: "POST", headers, body: JSON.stringify(o.region ? { region: o.region } : {}), credentials: "include" });
  let body: any = await res.json();
  if (!res.ok) throw fail(body, `join failed (${res.status})`);
  let status = body.status;
  const deadline = Date.now() + (o.timeoutMs ?? 120_000);
  while (status.state === "queued" || status.state === "matching") {
    if (Date.now() > deadline) throw Object.assign(new Error("No match found in time"), { code: "MIU_E_GAME_MATCH_TIMEOUT" });
    const started = Date.now();
    const r = await f(`${base}/match/${encodeURIComponent(queue)}/status?wait=${o.waitMs ?? 20_000}`, { headers, credentials: "include" });
    body = await r.json();
    if (!r.ok) throw fail(body, `status failed (${r.status})`);
    status = body.status;
    // Servers without long-poll (Cloudflare) answer at once: poll gently instead.
    if ((status.state === "queued" || status.state === "matching") && Date.now() - started < 250) await new Promise((x) => setTimeout(x, 1_000));
  }
  if (status.state !== "matched") throw Object.assign(new Error(`Matchmaking ended: ${status.state}`), { code: status.state === "timeout" ? "MIU_E_GAME_MATCH_TIMEOUT" : "MIU_E_GAME_MATCH_FAILED", status });
  return status as MatchedStatus;
}

/**
 * Connect to a match room with the ticket. `seated` resolves when the room seats you and rejects
 * if the ticket is refused. Reconnects resume the same seat.
 */
export function connectMatch<S = any>(url: string, ticket: string, opts: ConnectOptions = {}): { room: RoomClient<S>; seated: Promise<SeatInfo> } {
  // The ticket goes in the join params (?ticket=): the room admits and seats the player with it
  // in onJoinRequest; the plugins also check it before the WebSocket upgrade.
  const room = connect<S>(url, { ...opts, name: opts.name ?? "player", params: { ...(opts.params ?? {}), ticket } });
  const seated = new Promise<SeatInfo>((resolve, reject) => {
    room.on("seated", (s: SeatInfo) => resolve(s));
    room.on("error", (e: { code: string; message: string }) => {
      if (/^MIU_E_GAME_TICKET_(INVALID|EXPIRED|USED)$/.test(e.code)) reject(Object.assign(new Error(e.message), e));
    });
    room.ready.catch(reject);
  });
  seated.catch(() => {});
  return { room, seated };
}
