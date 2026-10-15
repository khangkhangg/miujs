// __APP_NAME__: a realtime chat on MiuJS rooms.
//
//   bun app.ts   → open http://localhost:3000 in two browsers (?room=name picks a room)
//
// The room lives in rooms/chat.ts. Clients connect to ws://host/rooms/chat/<room>?name=<name>.

import { miu, route, type CallFn } from "miujs";
import { createRoomDurableObject, rooms } from "@miujs/realtime";
import { chat } from "./rooms/chat.ts";

declare const Bun: { file(path: URL): { text(): Promise<string> } } | undefined;

async function readText(url: URL): Promise<string> {
  if (typeof Bun !== "undefined") return Bun.file(url).text();
  return (await fetch(url)).text();
}

const html = await readText(new URL("./public/index.html", import.meta.url));

const realtime = rooms({ rooms: [chat] });

export const home = route.get("/", {
  summary: "The chat page",
  mcp: false,
  handler: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
});

export const createChat = route.post("/api/rooms", {
  summary: "Create a new chat room and return its URL",
  auth: "optional", // anyone may open a room
  handler: async () => {
    const { id } = await realtime.createRoom("chat");
    return { id, join: `/rooms/chat/${id}`, page: `/?room=${id}` };
  },
});

export const tests = {
  "serves the chat page": async (call: CallFn) => {
    const res = (await call(home)).expectStatus(200);
    if (!res.text.includes("/rooms/chat/")) throw new Error("expected the chat client");
  },
  "creates a room": async (call: CallFn) => {
    const res = (await call(createChat)).expectStatus(200);
    if (res.body.join !== `/rooms/chat/${res.body.id}`) throw new Error("expected the room URL");
  },
};

const app = miu({ name: "__APP_NAME__", routes: [{ home, createChat, tests }], plugins: [realtime], mcp: true });

/** Cloudflare: rooms run in this Durable Object (bound as MIU_ROOMS by `miu deploy cloudflare`). */
export const MiuRooms = createRoomDurableObject([chat]);

export default app;
