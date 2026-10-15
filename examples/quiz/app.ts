// Kahoot-style quiz on MiuJS realtime rooms.
//
//   bun examples/quiz/app.ts         → http://localhost:3000
//
// Host: open the page, "Create game", share the 6-digit code. Players: open the page on their
// phones, enter the code and a name. Agents: POST /mcp → tools rooms_list / room_state.

import { miu, route } from "miujs";
import { createRoomDurableObject, rooms } from "@miujs/realtime";
import { quiz } from "./room.ts";

declare const Bun: { file(path: URL): { text(): Promise<string> } } | undefined;

async function readText(url: URL): Promise<string> {
  if (typeof Bun !== "undefined") return Bun.file(url).text();
  return (await fetch(url)).text();
}

const html = await readText(new URL("./public/index.html", import.meta.url));

// `codes`: on Cloudflare, join codes live in this KV namespace (declared for `miu deploy cloudflare`).
const realtime = rooms({ rooms: [quiz], codes: "ROOM_CODES" });

export const home = route.get("/", {
  summary: "The quiz web client (host and players)",
  mcp: false,
  handler: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
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
