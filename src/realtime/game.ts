/**
 * Transport-agnostic quiz state machine (Kahoot-style):
 * lobby -> question (timed) -> reveal -> leaderboard -> ... -> finished.
 * Feed it player actions, broadcast its events however you like.
 */

export type GamePhase = "lobby" | "question" | "reveal" | "leaderboard" | "finished";

export interface Round {
  prompt: string;
  choices: string[];
  /** Index of the correct choice. */
  answer: number;
  /** Overrides `roundMs` for this question. */
  ms?: number;
}

export interface Player {
  id: string;
  name: string;
}

export interface ScoreEntry extends Player {
  score: number;
  rank: number;
  streak: number;
  /** Points earned in the most recent round. */
  lastPoints: number;
}

export interface ScoringContext {
  correct: boolean;
  elapsedMs: number;
  roundMs: number;
  /** Consecutive correct answers including this one (0 if wrong). */
  streak: number;
}

export interface ScoringOptions {
  /** Points for an instant correct answer. Default 1000. */
  maxPoints?: number;
  /** Points for a correct answer at the buzzer. Default 500. */
  minPoints?: number;
  /** Extra points per consecutive correct answer after the first. Default 0. */
  streakBonus?: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type PublicQuestion = Pick<Round, "prompt" | "choices">;

export interface AnswerResult {
  id: string;
  choice: number | null;
  correct: boolean;
  points: number;
}

export type GameEvent =
  | { type: "join"; player: Player }
  | { type: "leave"; player: Player }
  | { type: "question"; round: number; totalRounds: number; question: PublicQuestion; deadline: number; ms: number }
  | { type: "answer"; round: number; playerId: string; answered: number; total: number }
  | { type: "reveal"; round: number; answer: number; results: AnswerResult[] }
  | { type: "leaderboard"; round: number; scoreboard: ScoreEntry[] }
  | { type: "finished"; scoreboard: ScoreEntry[] };

export interface GameOptions {
  rounds: Round[];
  /** Time to answer each question. */
  roundMs: number;
  /** Auto-advance from reveal after this long (otherwise call `next()`). */
  revealMs?: number;
  /** Auto-advance from leaderboard after this long (otherwise call `next()`). */
  leaderboardMs?: number;
  scoring?: ScoringOptions | ((ctx: ScoringContext) => number);
  /** End the question as soon as every player has answered. Default true. */
  endWhenAllAnswered?: boolean;
  minPlayers?: number;
  clock?: Clock;
  onEvent?: (event: GameEvent) => void;
}

export interface GameState {
  phase: GamePhase;
  round: number;
  totalRounds: number;
  question?: PublicQuestion;
  deadline?: number;
  players: number;
}

export type AnswerOutcome =
  | { accepted: true; correct: boolean; points: number }
  | { accepted: false; reason: "not_accepting" | "unknown_player" | "already_answered" | "invalid_choice"; points?: undefined };

export interface Game {
  join(player: Player): boolean;
  leave(playerId: string): void;
  start(): void;
  answer(playerId: string, choice: number, at?: number): AnswerOutcome;
  /** Advance reveal -> leaderboard -> next question/finished (or end a question early). */
  next(): void;
  players(): Player[];
  scoreboard(): ScoreEntry[];
  state(): GameState;
  dispose(): void;
}

interface PlayerState extends Player {
  score: number;
  streak: number;
  lastPoints: number;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function scorer(s: GameOptions["scoring"]): (ctx: ScoringContext) => number {
  if (typeof s === "function") return s;
  const max = s?.maxPoints ?? 1000;
  const min = s?.minPoints ?? 500;
  const bonus = s?.streakBonus ?? 0;
  return ({ correct, elapsedMs, roundMs, streak }) => {
    if (!correct) return 0;
    const speed = 1 - Math.min(1, Math.max(0, elapsedMs / roundMs));
    return Math.round(min + (max - min) * speed) + bonus * Math.max(0, streak - 1);
  };
}

export function createGame(opts: GameOptions): Game {
  const clock = opts.clock ?? realClock;
  const score = scorer(opts.scoring);
  const emit = (e: GameEvent) => opts.onEvent?.(e);
  const roster = new Map<string, PlayerState>();
  let phase: GamePhase = "lobby";
  let round = -1;
  let startedAt = 0;
  let deadline = 0;
  let timer: unknown;
  let answers = new Map<string, AnswerResult>();

  const current = () => opts.rounds[round]!;
  const msFor = (r: Round) => r.ms ?? opts.roundMs;
  const publicQuestion = (r: Round): PublicQuestion => ({ prompt: r.prompt, choices: r.choices });

  const schedule = (ms: number | undefined, fn: () => void) => {
    cancel();
    if (ms !== undefined) timer = clock.setTimeout(fn, ms);
  };
  const cancel = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };

  /** Sorted by score; ties share a rank (1, 2, 2, 4). */
  const scoreboard = (): ScoreEntry[] => {
    const sorted = [...roster.values()].sort((a, b) => b.score - a.score);
    const out: ScoreEntry[] = [];
    sorted.forEach((p, i) => {
      const prev = out[i - 1];
      const rank = prev && prev.score === p.score ? prev.rank : i + 1;
      out.push({ id: p.id, name: p.name, score: p.score, rank, streak: p.streak, lastPoints: p.lastPoints });
    });
    return out;
  };

  const ask = () => {
    round++;
    phase = "question";
    answers = new Map();
    const r = current();
    startedAt = clock.now();
    deadline = startedAt + msFor(r);
    for (const p of roster.values()) p.lastPoints = 0;
    schedule(msFor(r), reveal);
    emit({ type: "question", round, totalRounds: opts.rounds.length, question: publicQuestion(r), deadline, ms: msFor(r) });
  };

  const reveal = () => {
    phase = "reveal";
    const results = [...roster.values()].map(
      (p) => answers.get(p.id) ?? { id: p.id, choice: null, correct: false, points: 0 },
    );
    for (const p of roster.values()) if (!answers.has(p.id)) p.streak = 0;
    schedule(opts.revealMs, leaderboard);
    emit({ type: "reveal", round, answer: current().answer, results });
  };

  const leaderboard = () => {
    phase = "leaderboard";
    schedule(opts.leaderboardMs, advance);
    emit({ type: "leaderboard", round, scoreboard: scoreboard() });
  };

  const advance = () => {
    if (round + 1 < opts.rounds.length) return ask();
    cancel();
    phase = "finished";
    emit({ type: "finished", scoreboard: scoreboard() });
  };

  return {
    join(player) {
      if (phase !== "lobby" || roster.has(player.id)) return false;
      roster.set(player.id, { id: player.id, name: player.name, score: 0, streak: 0, lastPoints: 0 });
      emit({ type: "join", player: { id: player.id, name: player.name } });
      return true;
    },
    leave(playerId) {
      const p = roster.get(playerId);
      if (!p) return;
      roster.delete(playerId);
      emit({ type: "leave", player: { id: p.id, name: p.name } });
      if (phase === "question" && opts.endWhenAllAnswered !== false && roster.size && answers.size >= roster.size) reveal();
    },
    start() {
      if (phase !== "lobby") throw new Error("Game already started");
      if (!opts.rounds.length) throw new Error("Game has no rounds");
      if (roster.size < (opts.minPlayers ?? 1)) throw new Error("Not enough players to start");
      ask();
    },
    answer(playerId, choice, at = clock.now()) {
      if (phase !== "question" || at > deadline) return { accepted: false, reason: "not_accepting" };
      const p = roster.get(playerId);
      if (!p) return { accepted: false, reason: "unknown_player" };
      if (answers.has(playerId)) return { accepted: false, reason: "already_answered" };
      const r = current();
      if (!Number.isInteger(choice) || choice < 0 || choice >= r.choices.length) return { accepted: false, reason: "invalid_choice" };
      const correct = choice === r.answer;
      p.streak = correct ? p.streak + 1 : 0;
      const points = score({ correct, elapsedMs: Math.max(0, at - startedAt), roundMs: msFor(r), streak: p.streak });
      p.score += points;
      p.lastPoints = points;
      answers.set(playerId, { id: playerId, choice, correct, points });
      emit({ type: "answer", round, playerId, answered: answers.size, total: roster.size });
      if (opts.endWhenAllAnswered !== false && answers.size >= roster.size) reveal();
      return { accepted: true, correct, points };
    },
    next() {
      if (phase === "question") reveal();
      else if (phase === "reveal") leaderboard();
      else if (phase === "leaderboard") advance();
      else throw new Error(`Cannot advance from ${phase}`);
    },
    players: () => [...roster.values()].map((p) => ({ id: p.id, name: p.name })),
    scoreboard,
    state() {
      const s: GameState = { phase, round: Math.max(0, round), totalRounds: opts.rounds.length, players: roster.size };
      if (phase === "question") {
        s.question = publicQuestion(current());
        s.deadline = deadline;
      }
      return s;
    },
    dispose: cancel,
  };
}
