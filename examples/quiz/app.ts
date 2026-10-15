// Kahoot-style quiz on MiuJS realtime rooms.
//
//   bun examples/quiz/app.ts         → http://localhost:3000
//
// Host: open the page, "Create game", share the 6-digit code. Players: open the page on their
// phones, enter the code and a name. Agents: POST /mcp → tools rooms_list / room_state.

import { errors, miu, route } from "miujs";
import { KeyedLimiter, createRoomDurableObject, rooms } from "@miujs/realtime";
import { quiz } from "./room.ts";
// A text import, not a file read at startup: Workers have no filesystem and forbid fetch() in
// global scope. Bun inlines it; wrangler bundles it as a Text module.
import html from "./public/index.html" with { type: "text" };

export interface QuizAppOptions {
  /** Games one IP may create per minute (against flooding rooms and join codes). Default 20, burst 10. */
  gamesPerMinute?: number;
  gamesBurst?: number;
}

export function createApp(opts: QuizAppOptions = {}) {
  // `codes`: on Cloudflare, join codes live in this KV namespace (declared for `miu deploy cloudflare`).
  const realtime = rooms({ rooms: [quiz], codes: "ROOM_CODES" });
  const perMinute = opts.gamesPerMinute ?? 20;
  // Per process (per isolate on Workers): slows a flood down; a CDN rule can do the rest.
  const creates = new KeyedLimiter({ perSecond: perMinute / 60, burst: opts.gamesBurst ?? 10 });

  const home = route.get("/", {
    summary: "The quiz web client (host and players)",
    mcp: false,
    // bun-types types every *.html import as an HTMLBundle; with { type: "text" } it is a string.
    handler: () => new Response(html as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });

  const createGame = route.post("/api/games", {
    summary: "Create a quiz game and its 6-digit join code",
    handler: async ({ ip }) => {
      if (!creates.take(ip ?? "unknown", Date.now())) {
        throw errors.custom({ code: "MIU_E_QUIZ_RATE_LIMITED", status: 429, message: "Too many new games from this address", fix: `Wait a minute: at most ${perMinute} games per minute per IP.` });
      }
      // Players type the code; GET /rooms/code/:code turns it into the room id to connect to.
      // The hostKey goes to the creator only: it is what makes them host (?role=host&hostKey=).
      const { id, code, hostKey } = await realtime.createRoom("quiz");
      return { id, code, hostKey, join: `/rooms/quiz/${id}` };
    },
  });

  return miu({ name: "quiz", routes: [{ home, createGame }], plugins: [realtime], mcp: true });
}

const app = createApp();

/** Cloudflare: export the Durable Object class and bind it as MIU_ROOMS. */
export const MiuRooms = createRoomDurableObject([quiz]);

export default app;

if (import.meta.main) console.log(`Quiz running on http://localhost:${app.port} — open it in two browsers.`);
