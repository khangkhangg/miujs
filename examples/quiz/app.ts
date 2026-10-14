// The quiz app, shared by server.ts (Bun) and node.ts (Node). Same handlers on both runtimes.
import { Miu, t } from "../../src/index.ts";
import { createGame, createRoomHub, type Game, type GameEvent, type MiuSocket } from "../../src/realtime/index.ts";
import { page } from "./client.ts";

const ROOM = "quiz";
const rounds = [
  { prompt: "Which runtime ships a built-in test runner called bun:test?", choices: ["Node", "Deno", "Bun", "Workers"], answer: 2 },
  { prompt: "What HTTP status means Upgrade Required?", choices: ["101", "426", "418", "505"], answer: 1 },
  { prompt: "Cloudflare's stateful primitive for rooms is called…", choices: ["KV", "R2", "Queues", "Durable Objects"], answer: 3 },
];

type Member = { name: string; host: boolean };
const hub = createRoomHub<Member>();
let game: Game = newGame();

function newGame(): Game {
  return createGame({
    rounds,
    roundMs: 15_000,
    revealMs: 4_000,
    leaderboardMs: 4_000,
    onEvent: (e: GameEvent) => hub.broadcast(ROOM, e),
  });
}

const sendLobby = () => hub.broadcast(ROOM, { type: "lobby", players: game.players(), state: game.state() });

export const app = new Miu({ name: "quiz" })
  .get("/", { tool: false, hidden: true }, (c) => c.html(page))
  .ws(
    "/play",
    {
      query: t.object({ name: t.string({ min: 1, max: 24 }), host: t.optional(t.boolean()) }),
      upgrade: (c) => ({ name: c.query.name, host: c.query.host ?? false }),
    },
    {
      open(ws) {
        ws.json({ type: "welcome", id: ws.id, host: ws.data.host, state: game.state() });
        hub.join(ROOM, ws, ws.data);
        if (!ws.data.host) game.join({ id: ws.id, name: ws.data.name });
        sendLobby();
      },
      message(ws, raw) {
        const msg = parse(raw);
        if (!msg) return ws.json({ type: "error", message: "Expected JSON" });
        if (msg.type === "answer") return ws.json({ type: "answered", ...game.answer(ws.id, Number(msg.choice)) });
        if (!ws.data.host) return ws.json({ type: "error", message: "Only the host can do that" });
        hostCommand(ws, msg.type);
      },
      close(ws) {
        game.leave(ws.id);
        sendLobby();
      },
    },
  );

function hostCommand(ws: MiuSocket<Member>, type: unknown) {
  try {
    if (type === "start") game.start();
    else if (type === "next") game.next();
    else if (type === "reset") {
      game.dispose();
      game = newGame();
      for (const m of hub.members(ROOM)) if (!m.meta.host) game.join({ id: m.id, name: m.meta.name });
      sendLobby();
    }
  } catch (err) {
    ws.json({ type: "error", message: (err as Error).message });
  }
}

function parse(raw: string | ArrayBuffer): Record<string, unknown> | null {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
