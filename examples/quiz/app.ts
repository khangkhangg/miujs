// Kahoot-style quiz on MiuJS realtime rooms.
//
//   bun examples/quiz/app.ts         → http://localhost:3000
//
// Host: open the page, "Create game", share the 6-digit code. Players: open the page on their
// phones, enter the code and a name. Agents: POST /mcp → tools rooms_list / room_state.

import { miu, route } from "miujs";
import { createRoomDurableObject, rooms } from "@miujs/realtime";
import { quiz } from "./room.ts";
// A text import, not a file read at startup: Workers have no filesystem and forbid fetch() in
// global scope. Bun inlines it; wrangler bundles it as a Text module.
import html from "./public/index.html" with { type: "text" };

// `codes`: on Cloudflare, join codes live in this KV namespace (declared for `miu deploy cloudflare`).
const realtime = rooms({ rooms: [quiz], codes: "ROOM_CODES" });

export const home = route.get("/", {
  summary: "The quiz web client (host and players)",
  mcp: false,
  // bun-types types every *.html import as an HTMLBundle; with { type: "text" } it is a string.
  handler: () => new Response(html as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } }),
});

export const createGame = route.post("/api/games", {
  summary: "Create a quiz game and its 6-digit join code",
  handler: async () => {
    // Players type the code; GET /rooms/code/:code turns it into the room id to connect to.
    const { id, code } = await realtime.createRoom("quiz");
    return { id, code, join: `/rooms/quiz/${id}` };
  },
});

const app = miu({ name: "quiz", routes: [{ home, createGame }], plugins: [realtime], mcp: true });

/** Cloudflare: export the Durable Object class and bind it as MIU_ROOMS. */
export const MiuRooms = createRoomDurableObject([quiz]);

export default app;

if (import.meta.main) console.log(`Quiz running on http://localhost:${app.port} — open it in two browsers.`);
