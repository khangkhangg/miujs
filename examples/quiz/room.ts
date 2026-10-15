// The quiz room: lobby → question → reveal → … → done. The host drives it; players answer.
// Correct answers live in the room's `secret` state and only enter shared state at reveal.

import { errors, type Infer } from "miujs";
import { defineRoom, t, type Room } from "@miujs/realtime";

export interface Question {
  text: string;
  choices: string[];
  /** Index of the correct choice. Never sent to clients before the reveal. */
  answer: number;
}

export const QUESTIONS: Question[] = [
  { text: "Which runtime does MiuJS target first?", choices: ["Bun", "Rhino", "Nashorn", "JScript"], answer: 0 },
  { text: "What does HTTP status 404 mean?", choices: ["Teapot", "Not found", "Forbidden", "Moved"], answer: 1 },
  { text: "Which planet is closest to the Sun?", choices: ["Venus", "Earth", "Mercury", "Mars"], answer: 2 },
  { text: "How many bits are in a byte?", choices: ["4", "16", "10", "8"], answer: 3 },
  { text: "Which protocol keeps a two-way connection open?", choices: ["WebSocket", "FTP", "SMTP", "DNS"], answer: 0 },
];

const phase = t.enum(["lobby", "question", "reveal", "done"] as const);
const scoreRow = t.object({ id: t.string(), name: t.string(), score: t.number() });

export const quizState = t.object({
  phase,
  /** 0-based question index; -1 in the lobby. */
  round: t.integer(),
  total: t.integer(),
  question: t.nullable(t.object({ text: t.string(), choices: t.array(t.string()) })),
  /** When the current question closes (ms since epoch, server clock). */
  deadline: t.nullable(t.number()),
  /** Players who answered the current question (a record, so each answer is a one-key patch). */
  answered: t.record(t.boolean()),
  /** Filled at reveal: the correct choice and how many picked each choice. */
  reveal: t.nullable(t.object({ correct: t.integer(), counts: t.array(t.integer()) })),
  players: t.record(t.object({ name: t.string(), score: t.number(), gained: t.number() })),
  /** Built at each reveal and at the end (empty in the lobby, where every score is 0). */
  leaderboard: t.array(scoreRow),
});

/** How many leaderboard rows a player's phone gets (the host screen gets them all). */
export const TOP = 10;

interface Secret {
  questions: Question[];
  questionMs: number;
  answers: Record<string, { choice: number; at: number }>;
  /** Id of the pending `reveal` timer (secret state is persisted, so this survives hibernation). */
  deadlineTimer: string | null;
}

type QuizState = Infer<typeof quizState>;
type QuizRoom = Room<QuizState, Secret>;

/** Leaderboard position by player id, computed once per leaderboard (it is replaced, never mutated). */
const ranks = new WeakMap<object, Map<string, number>>();
function rankOf(board: QuizState["leaderboard"], id: string): number | null {
  let m = ranks.get(board);
  if (!m) ranks.set(board, (m = new Map(board.map((r, i) => [r.id, i + 1]))));
  return m.get(id) ?? null;
}

/** The top rows, one array per leaderboard (shared by every player's view). */
const tops = new WeakMap<object, QuizState["leaderboard"]>();
function topOf(board: QuizState["leaderboard"]): QuizState["leaderboard"] {
  if (board.length <= TOP) return board;
  let top = tops.get(board);
  if (!top) tops.set(board, (top = board.slice(0, TOP)));
  return top;
}

type PlayerView = ReturnType<typeof playerView>;
function playerView(s: QuizState, id: string) {
  const p = s.players[id];
  return {
    phase: s.phase,
    round: s.round,
    total: s.total,
    question: s.question,
    deadline: s.deadline,
    reveal: s.reveal,
    leaderboard: topOf(s.leaderboard),
    me: p ? { name: p.name, score: p.score, gained: p.gained, answered: s.answered[id] === true, rank: rankOf(s.leaderboard, id) } : null,
  };
}

/** Last view per player, per roster object (the engine keeps unchanged parts of the state identical). */
const seen = new WeakMap<object, Map<string, { inputs: unknown[]; view: PlayerView }>>();

/**
 * What one client sees. The host (and spectators: a big screen) get the whole state. A player's
 * phone gets the question and only their own row, so a join or an answer changes the host's view
 * and the answering player's, not everyone's: seating N players costs O(N) frames, not O(N²).
 * A player whose inputs did not change gets the very same object back, which the engine skips
 * without diffing (an answer then costs O(1) per other player).
 */
export function quizView(s: QuizState, player: { id: string; role: string }): QuizState | PlayerView {
  if (player.role !== "player") return s;
  const inputs = [s.phase, s.round, s.total, s.question, s.deadline, s.reveal, s.leaderboard, s.players[player.id], s.answered[player.id]];
  let byId = seen.get(s.players);
  if (!byId) seen.set(s.players, (byId = new Map()));
  const last = byId.get(player.id);
  if (last && last.inputs.every((x, i) => x === inputs[i])) return last.view;
  const view = playerView(s, player.id);
  byId.set(player.id, { inputs, view });
  return view;
}

function leaderboard(state: QuizState) {
  return Object.entries(state.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function requireHost(role: string) {
  if (role !== "host") throw errors.forbidden("Only the host can do that", "Ask the host to press the button.");
}

function wrongPhase(want: string, got: string) {
  return errors.custom({ code: "MIU_E_QUIZ_WRONG_PHASE", status: 409, message: `Expected phase "${want}", but the game is in "${got}"`, fix: "Wait for the game to reach that phase." });
}

function ask(room: QuizRoom, now: number) {
  const s = room.state;
  const { questions, questionMs } = room.secret;
  s.round += 1;
  const q = questions[s.round];
  s.phase = "question";
  s.question = { text: q.text, choices: [...q.choices] };
  s.deadline = now + questionMs;
  s.answered = {};
  s.reveal = null;
  room.secret.answers = {};
  for (const p of Object.values(s.players)) p.gained = 0;
  clearDeadline(room);
  // A named timer (not an after() closure): it is persisted and survives Durable Object hibernation.
  room.secret.deadlineTimer = room.schedule("reveal", questionMs, { round: s.round });
}

function clearDeadline(room: QuizRoom) {
  if (room.secret.deadlineTimer) room.cancel(room.secret.deadlineTimer);
  room.secret.deadlineTimer = null;
}

function reveal(room: QuizRoom) {
  const s = room.state;
  if (s.phase !== "question") return;
  clearDeadline(room);
  const q = room.secret.questions[s.round];
  const counts = q.choices.map(() => 0);
  const ms = room.secret.questionMs;
  for (const [id, a] of Object.entries(room.secret.answers)) {
    counts[a.choice]++;
    const p = s.players[id];
    if (!p || a.choice !== q.answer) continue;
    const speed = Math.max(0, Math.min(1, (s.deadline! - a.at) / ms));
    p.gained = Math.round(500 + 500 * speed);
    p.score += p.gained;
  }
  s.phase = "reveal";
  s.reveal = { correct: q.answer, counts };
  s.leaderboard = leaderboard(s);
}

/** Build a quiz room type with your own questions. */
export function createQuiz(questions: Question[], opts: { questionMs?: number } = {}) {
  const questionMs = opts.questionMs ?? 20_000;
  return defineRoom("quiz", {
    state: quizState,
    client: {
      start: t.object({}),
      answer: t.object({ choice: t.integer({ min: 0 }) }),
      next: t.object({}),
    },
    init: () => ({ phase: "lobby" as const, round: -1, total: questions.length, question: null, deadline: null, answered: {}, reveal: null, players: {}, leaderboard: [] }),
    view: quizView,
    // The host has the start/next buttons: only the creator's hostKey (from POST /api/games)
    // makes someone host, never joining first or outliving the host.
    requireHostKey: true,
    // Rooms come from POST /api/games only: a random /rooms/quiz/<id> URL is a 404.
    createOnJoin: false,
    maxPlayers: 500,
    secret: (): Secret => ({ questions, questionMs, answers: {}, deadlineTimer: null }),
    timers: {
      // The question deadline. `round` guards against a stale timer from an earlier question.
      reveal: ({ room, data }) => {
        if (room.state.round === data.round) reveal(room);
      },
    },
    onJoin: ({ room, player }) => {
      if (player.role !== "player") return;
      // Only the roster changes: no leaderboard rebuild (every score is 0 until the first reveal).
      room.state.players[player.id] = { name: player.name, score: 0, gained: 0 };
    },
    onLeave: ({ room, player }) => {
      const s = room.state;
      delete s.players[player.id];
      delete s.answered[player.id];
      if (s.leaderboard.some((r) => r.id === player.id)) s.leaderboard = s.leaderboard.filter((r) => r.id !== player.id);
    },
    on: {
      start: ({ room, sender, now }) => {
        requireHost(sender.role);
        if (room.state.phase !== "lobby") throw wrongPhase("lobby", room.state.phase);
        if (Object.keys(room.state.players).length === 0) {
          throw errors.custom({ code: "MIU_E_QUIZ_NO_PLAYERS", status: 409, message: "Nobody has joined yet", fix: "Share the room code and wait for players to join." });
        }
        ask(room, now);
      },
      answer: ({ room, sender, msg, now }) => {
        const s = room.state;
        if (s.phase !== "question") {
          throw errors.custom({ code: "MIU_E_QUIZ_NOT_ACCEPTING", status: 409, message: "No question is open right now", fix: "Wait for the next question." });
        }
        if (!s.players[sender.id]) throw errors.forbidden("Only players can answer", "Join as a player (not host or spectator).");
        if (room.secret.answers[sender.id]) {
          throw errors.custom({ code: "MIU_E_QUIZ_ALREADY_ANSWERED", status: 409, message: "You already answered this question", fix: "Wait for the reveal." });
        }
        if (msg.choice >= s.question!.choices.length) {
          throw errors.custom({ code: "MIU_E_QUIZ_BAD_CHOICE", status: 400, message: `Choice ${msg.choice} does not exist`, fix: `Pick 0-${s.question!.choices.length - 1}.` });
        }
        room.secret.answers[sender.id] = { choice: msg.choice, at: now };
        s.answered[sender.id] = true;
        if (Object.keys(s.players).every((id) => room.secret.answers[id])) reveal(room);
      },
      next: ({ room, sender, now }) => {
        requireHost(sender.role);
        if (room.state.phase !== "reveal") throw wrongPhase("reveal", room.state.phase);
        if (room.state.round + 1 < room.secret.questions.length) return ask(room, now);
        room.state.phase = "done";
        room.state.question = null;
        room.state.deadline = null;
        room.state.leaderboard = leaderboard(room.state);
      },
    },
  });
}

export const quiz = createQuiz(QUESTIONS);
