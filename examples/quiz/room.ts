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
  /** Ids of players who answered the current question. */
  answered: t.array(t.string()),
  /** Filled at reveal: the correct choice and how many picked each choice. */
  reveal: t.nullable(t.object({ correct: t.integer(), counts: t.array(t.integer()) })),
  players: t.record(t.object({ name: t.string(), score: t.number(), gained: t.number() })),
  leaderboard: t.array(scoreRow),
});

interface Secret {
  questions: Question[];
  questionMs: number;
  answers: Record<string, { choice: number; at: number }>;
}

type QuizState = Infer<typeof quizState>;
type QuizRoom = Room<QuizState, Secret>;

// Pending deadline timers, per room (functions are not part of persisted state).
const deadlines = new WeakMap<object, () => void>();

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
  s.answered = [];
  s.reveal = null;
  room.secret.answers = {};
  for (const p of Object.values(s.players)) p.gained = 0;
  deadlines.get(room)?.();
  deadlines.set(room, room.after(questionMs, () => reveal(room)));
}

function reveal(room: QuizRoom) {
  const s = room.state;
  if (s.phase !== "question") return;
  deadlines.get(room)?.();
  deadlines.delete(room);
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
    init: () => ({ phase: "lobby" as const, round: -1, total: questions.length, question: null, deadline: null, answered: [], reveal: null, players: {}, leaderboard: [] }),
    secret: (): Secret => ({ questions, questionMs, answers: {} }),
    onJoin: ({ room, player }) => {
      if (player.role !== "player") return;
      room.state.players[player.id] = { name: player.name, score: 0, gained: 0 };
      room.state.leaderboard = leaderboard(room.state);
    },
    onLeave: ({ room, player }) => {
      delete room.state.players[player.id];
      room.state.answered = room.state.answered.filter((id) => id !== player.id);
      room.state.leaderboard = leaderboard(room.state);
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
        s.answered = [...s.answered, sender.id];
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
