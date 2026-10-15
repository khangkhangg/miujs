// Arena: ranked tic-tac-toe duels with matchmaking, Elo, a weekly leaderboard and achievements.
//
//   bun packages/game/examples/arena/app.ts        → http://localhost:3000
//
//   curl -X POST localhost:3000/match/duel/join -H 'authorization: Bearer guest:ann'
//   curl 'localhost:3000/match/duel/status?wait=20000' -H 'authorization: Bearer guest:ann'
//   → { status: { state: "matched", room: { url: "/rooms/arena/r…" }, ticket } }
//   then connect a WebSocket to the room URL and send {"t":"msg","type":"ticket","data":{"ticket":"…"}}
//
// Agents: POST /mcp → leaderboard_arena-wins_top, player_profile, match_status, rooms_list, ...

import { definePlugin, miu } from "miujs";
import { createRoomDurableObject, rooms } from "@miujs/realtime";
import { createMatchmakerDurableObject, matchmaker, profiles } from "../../src/index.ts";
import { achievements, database, wins } from "./boards.ts";
import { arena } from "./room.ts";

/**
 * DEMO ONLY: `Authorization: Bearer guest:<name>` signs you in as `g_<name>`. Anyone can be
 * anyone. Use @miujs/auth in a real game; the matchmaker only needs `ctx.user`.
 */
function guestAuth() {
  return definePlugin({
    name: "guest-auth",
    onRequest(ctx) {
      const m = /^Bearer guest:([A-Za-z0-9_-]{1,24})$/.exec(ctx.headers.get("authorization") ?? "");
      if (m) ctx.user = { id: `g_${m[1]}`, name: m[1], roles: [] };
    },
  });
}

export const realtime = rooms({ rooms: [arena] });

export const mm = matchmaker({
  rooms: realtime,
  database,
  achievements,
  queues: {
    duel: { room: "arena", teamSize: 1, teams: 2, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 120_000 },
  },
});

const app = miu({
  name: "arena",
  plugins: [guestAuth(), realtime, mm, wins, profiles({ database, achievements })],
  mcp: true,
});

// Cloudflare: export the Durable Objects (bindings MIU_ROOMS, MIU_MATCH) and set MIU_GAME_SECRET.
export const MiuRooms = createRoomDurableObject([arena]);
export const MiuMatchmaker = createMatchmakerDurableObject(mm);

export default app;

if (import.meta.main) console.log(`Arena on http://localhost:${app.port}`);
