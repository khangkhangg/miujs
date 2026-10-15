// Tic-tac-toe as a realtime room: the server owns the board and the rules, clients only send
// `move` and `reset`. The first two players take X and O; everyone else watches.

import { errors } from "miujs";
import { defineRoom, t, type Room } from "@miujs/realtime";

const mark = t.enum(["", "X", "O"] as const);
type Mark = "" | "X" | "O";

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function winnerOf(board: Mark[]): "X" | "O" | "draw" | null {
  for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a] as "X" | "O";
  return board.every(Boolean) ? "draw" : null;
}

function seatOf(room: Room<any>, playerId: string): "X" | "O" | null {
  return room.state.seats.X === playerId ? "X" : room.state.seats.O === playerId ? "O" : null;
}

export const tictactoe = defineRoom("tictactoe", {
  state: t.object({
    board: t.array(mark),
    seats: t.object({ X: t.nullable(t.string()), O: t.nullable(t.string()) }),
    names: t.record(t.string()),
    turn: t.enum(["X", "O"] as const),
    winner: t.nullable(t.enum(["X", "O", "draw"] as const)),
  }),
  client: {
    move: t.object({ cell: t.integer({ min: 0, max: 8 }) }),
    reset: t.object({}),
  },
  init: () => ({ board: Array<Mark>(9).fill(""), seats: { X: null, O: null }, names: {}, turn: "X" as const, winner: null }),
  onJoin: ({ room, player }) => {
    room.state.names[player.id] = player.name;
    if (!room.state.seats.X) room.state.seats.X = player.id;
    else if (!room.state.seats.O && room.state.seats.X !== player.id) room.state.seats.O = player.id;
  },
  onLeave: ({ room, player }) => {
    delete room.state.names[player.id];
    if (room.state.seats.X === player.id) room.state.seats.X = null;
    if (room.state.seats.O === player.id) room.state.seats.O = null;
  },
  on: {
    move: ({ room, sender, msg }) => {
      const s = room.state;
      const seat = seatOf(room, sender.id);
      if (!seat) throw errors.forbidden("Only the two seated players can move", "Wait for a free seat; you are watching.");
      if (s.winner) throw errors.custom({ code: "MIU_E_GAME_OVER", status: 409, message: "The game is over", fix: "Send `reset` to play again." });
      if (s.turn !== seat) throw errors.custom({ code: "MIU_E_GAME_NOT_YOUR_TURN", status: 409, message: `It is ${s.turn}'s turn`, fix: "Wait for the other player." });
      if (s.board[msg.cell]) throw errors.custom({ code: "MIU_E_GAME_CELL_TAKEN", status: 409, message: `Cell ${msg.cell} is taken`, fix: "Pick an empty cell." });
      s.board[msg.cell] = seat;
      s.winner = winnerOf(s.board);
      s.turn = seat === "X" ? "O" : "X";
    },
    reset: ({ room, sender }) => {
      if (!seatOf(room, sender.id)) throw errors.forbidden("Only the players can reset", "Wait for a free seat.");
      room.state.board = Array<Mark>(9).fill("");
      room.state.turn = "X";
      room.state.winner = null;
    },
  },
});
