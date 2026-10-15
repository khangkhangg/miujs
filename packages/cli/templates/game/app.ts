// __APP_NAME__: a realtime multiplayer game (tic-tac-toe) on MiuJS rooms.
// A minimal starter: the full game kit (@miujs/game) is in progress.
//
//   bun app.ts   → open http://localhost:3000/?room=table1 in two browsers
//   miu loadtest ws://localhost:3000/rooms/tictactoe/load --players 2 --duration 5s --action '{"type":"move","data":{"cell":4}}'

import { miu, route, type CallFn } from "miujs";
import { createRoomDurableObject, rooms } from "@miujs/realtime";
import { tictactoe, winnerOf } from "./rooms/tictactoe.ts";

declare const Bun: { file(path: URL): { text(): Promise<string> } } | undefined;

async function readText(url: URL): Promise<string> {
  if (typeof Bun !== "undefined") return Bun.file(url).text();
  return (await fetch(url)).text();
}

const html = await readText(new URL("./public/index.html", import.meta.url));

const realtime = rooms({ rooms: [tictactoe] });

export const home = route.get("/", {
  summary: "The game page",
  mcp: false,
  handler: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
});

export const createTable = route.post("/api/tables", {
  summary: "Open a new game table and return its URL",
  auth: "optional", // anyone may open a table
  handler: async () => {
    const { id } = await realtime.createRoom("tictactoe");
    return { id, join: `/rooms/tictactoe/${id}`, page: `/?room=${id}` };
  },
});

export const tests = {
  "serves the game page": async (call: CallFn) => {
    const res = (await call(home)).expectStatus(200);
    if (!res.text.includes("/rooms/tictactoe/")) throw new Error("expected the game client");
  },
  "opens a table": async (call: CallFn) => {
    const res = (await call(createTable)).expectStatus(200);
    if (res.body.join !== `/rooms/tictactoe/${res.body.id}`) throw new Error("expected the room URL");
  },
  "knows who won": async () => {
    if (winnerOf(["X", "X", "X", "O", "O", "", "", "", ""]) !== "X") throw new Error("X should win the top row");
    if (winnerOf(["X", "O", "X", "X", "O", "O", "O", "X", "X"]) !== "draw") throw new Error("full board is a draw");
    if (winnerOf(["", "", "", "", "", "", "", "", ""]) !== null) throw new Error("empty board has no winner");
  },
};

const app = miu({ name: "__APP_NAME__", routes: [{ home, createTable, tests }], plugins: [realtime], mcp: true });

/** Cloudflare: rooms run in this Durable Object (bound as MIU_ROOMS by `miu deploy cloudflare`). */
export const MiuRooms = createRoomDurableObject([tictactoe]);

export default app;
