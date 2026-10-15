// Tic-tac-toe as a ticket-gated game room. Team 0 plays X and moves first.
// The room is the authority: it checks turns and cells, decides the winner, and reports the
// result (ratings, stats, achievements) and the leaderboard score server-side.

import { errors, t } from "miujs";
import { gameRoom, reportResult, seatOf, type ResultSummary } from "../../src/index.ts";
import { wins } from "./boards.ts";

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const fail = (code: string, message: string, fix: string) => errors.custom({ code, status: 409, message, fix });

export const arena = gameRoom("arena", {
  state: t.object({
    board: t.array(t.enum(["", "X", "O"])),
    turn: t.enum(["X", "O"]),
    phase: t.enum(["waiting", "playing", "over"]),
    marks: t.record(t.enum(["X", "O"])),
    names: t.record(t.string()),
    winner: t.nullable(t.string()),
  }),
  client: { move: t.object({ cell: t.integer({ min: 0, max: 8 }) }) },
  maxPlayers: 2,
  init: ({ match }) => ({
    board: Array(9).fill("") as ("" | "X" | "O")[],
    turn: "X" as const,
    phase: "waiting" as const,
    marks: {},
    names: Object.fromEntries((match?.players ?? []).map((p) => [p.userId, p.name])),
    winner: null,
  }),
  onSeat: ({ room, seat }) => {
    room.state.marks[seat.userId] = seat.team === 0 ? "X" : "O";
    if (Object.keys(room.state.marks).length === 2 && room.state.phase === "waiting") room.state.phase = "playing";
  },
  on: {
    move: async ({ room, sender, msg }) => {
      const s = room.state;
      if (s.phase === "over") throw fail("MIU_E_ARENA_GAME_OVER", "The game is over", "Queue for a new match.");
      if (s.phase !== "playing") throw fail("MIU_E_ARENA_NOT_STARTED", "Waiting for your opponent", "Wait until state.phase is \"playing\".");
      const me = seatOf(room, sender.id)!.userId;
      if (s.marks[me] !== s.turn) throw fail("MIU_E_ARENA_NOT_YOUR_TURN", "It is not your turn", `Wait until state.turn is "${s.marks[me]}".`);
      if (s.board[msg.cell] !== "") throw fail("MIU_E_ARENA_CELL_TAKEN", `Cell ${msg.cell} is taken`, "Pick an empty cell (board[i] === \"\").");
      const board = [...s.board];
      board[msg.cell] = s.turn;
      s.board = board;
      const won = LINES.some((l) => l.every((i) => board[i] === s.turn));
      const full = board.every((c) => c !== "");
      if (!won && !full) {
        s.turn = s.turn === "X" ? "O" : "X";
        return;
      }
      s.phase = "over";
      s.winner = won ? me : null;
      // Authoritative result: server side only, once per match.
      const { summary } = await reportResult<ResultSummary>(room, { winners: won ? [me] : [] });
      if (won) await wins.submit(me, 1);
      room.broadcast("game.over", { winner: s.winner, ratings: summary?.ratings ?? {} });
      for (const u of summary?.unlocked ?? []) {
        const player = room.players.find((p) => seatOf(room, p.id)?.userId === u.playerId);
        if (player) room.send(player.id, "achievement.unlocked", u);
      }
    },
  },
});
