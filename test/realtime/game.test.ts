import { describe, expect, test } from "bun:test";
import { createGame, type GameEvent } from "../../src/realtime/game.ts";

/** Deterministic clock: timers fire only when `advance()` is called. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

const rounds = [
  { prompt: "2+2?", choices: ["3", "4"], answer: 1 },
  { prompt: "Capital of France?", choices: ["Paris", "Rome", "Oslo"], answer: 0 },
];

function setup(extra: Partial<Parameters<typeof createGame>[0]> = {}) {
  const clock = fakeClock();
  const events: GameEvent[] = [];
  const game = createGame({ rounds, roundMs: 10_000, clock, onEvent: (e) => events.push(e), ...extra });
  return { clock, events, game };
}

describe("createGame", () => {
  test("lobby: join, duplicate join, leave; start needs players", () => {
    const { game, events } = setup();
    expect(game.state().phase).toBe("lobby");
    expect(() => game.start()).toThrow(/player/);
    expect(game.join({ id: "a", name: "Ann" })).toBe(true);
    expect(game.join({ id: "a", name: "Ann again" })).toBe(false);
    game.join({ id: "b", name: "Bob" });
    game.leave("b");
    expect(game.players().map((p) => p.name)).toEqual(["Ann"]);
    expect(events.map((e) => e.type)).toEqual(["join", "join", "leave"]);
  });

  test("question phase hides the answer and has a deadline", () => {
    const { game, events } = setup();
    game.join({ id: "a", name: "Ann" });
    game.start();
    const s = game.state();
    expect(s.phase).toBe("question");
    expect(s.round).toBe(0);
    expect(s.totalRounds).toBe(2);
    expect(s.deadline).toBe(10_000);
    expect(s.question).toEqual({ prompt: "2+2?", choices: ["3", "4"] });
    expect(events.at(-1)).toMatchObject({ type: "question", round: 0, question: { prompt: "2+2?", choices: ["3", "4"] } });
    expect(JSON.stringify(events.at(-1))).not.toContain('"answer"');
    expect(game.join({ id: "z", name: "Late" })).toBe(false);
  });

  test("faster correct answers score more; wrong answers score zero", () => {
    const { game, clock } = setup();
    game.join({ id: "a", name: "Ann" });
    game.join({ id: "b", name: "Bob" });
    game.join({ id: "c", name: "Cat" });
    game.start();
    expect(game.answer("a", 1, 0)).toMatchObject({ accepted: true, correct: true, points: 1000 });
    clock.advance(5000);
    expect(game.answer("b", 1)).toMatchObject({ accepted: true, correct: true, points: 750 });
    expect(game.answer("b", 0)).toMatchObject({ accepted: false, reason: "already_answered" });
    expect(game.answer("nobody", 0)).toMatchObject({ accepted: false, reason: "unknown_player" });
    expect(game.answer("c", 7)).toMatchObject({ accepted: false, reason: "invalid_choice" });
    expect(game.answer("c", 0)).toMatchObject({ accepted: true, correct: false, points: 0 });
  });

  test("everyone answering ends the question early and reveals", () => {
    const { game, events } = setup();
    game.join({ id: "a", name: "Ann" });
    game.start();
    game.answer("a", 1, 2000);
    expect(game.state().phase).toBe("reveal");
    const reveal = events.find((e) => e.type === "reveal")!;
    expect(reveal).toMatchObject({ type: "reveal", round: 0, answer: 1, results: [{ id: "a", choice: 1, correct: true, points: 900 }] });
  });

  test("timer expiry reveals; late answers are rejected; manual next() runs leaderboard -> next question -> finished", () => {
    const { game, clock, events } = setup();
    game.join({ id: "a", name: "Ann" });
    game.join({ id: "b", name: "Bob" });
    game.start();
    game.answer("a", 1, 1000);
    clock.advance(10_000);
    expect(game.state().phase).toBe("reveal");
    expect(game.answer("b", 1)).toMatchObject({ accepted: false, reason: "not_accepting" });

    game.next();
    expect(game.state().phase).toBe("leaderboard");
    expect(events.at(-1)).toMatchObject({ type: "leaderboard", scoreboard: [{ id: "a", score: 950, rank: 1 }, { id: "b", score: 0, rank: 2 }] });

    game.next();
    expect(game.state()).toMatchObject({ phase: "question", round: 1, deadline: 20_000 });
    game.answer("b", 0, 10_000);
    game.answer("a", 2, 10_001);
    expect(game.state().phase).toBe("reveal");
    game.next();
    game.next();
    expect(game.state().phase).toBe("finished");
    expect(events.at(-1)).toMatchObject({ type: "finished" });
    expect(game.scoreboard().map((p) => [p.id, p.score, p.rank])).toEqual([
      ["b", 1000, 1],
      ["a", 950, 2],
    ]);
    expect(() => game.next()).toThrow();
  });

  test("auto-advance with revealMs/leaderboardMs", () => {
    const { game, clock } = setup({ revealMs: 3000, leaderboardMs: 2000 });
    game.join({ id: "a", name: "Ann" });
    game.start();
    clock.advance(10_000);
    expect(game.state().phase).toBe("reveal");
    clock.advance(3000);
    expect(game.state().phase).toBe("leaderboard");
    clock.advance(2000);
    expect(game.state()).toMatchObject({ phase: "question", round: 1 });
    clock.advance(15_000);
    expect(game.state().phase).toBe("finished");
    expect(clock.pending()).toBe(0);
  });

  test("custom scoring: function form and options form with streak bonus", () => {
    const fn = setup({ scoring: ({ correct, elapsedMs }) => (correct ? 10_000 - elapsedMs : -5) });
    fn.game.join({ id: "a", name: "Ann" });
    fn.game.join({ id: "b", name: "Bob" });
    fn.game.start();
    expect(fn.game.answer("a", 1, 1234).points).toBe(8766);
    expect(fn.game.answer("b", 0, 0).points).toBe(-5);

    const opt = setup({ scoring: { maxPoints: 100, minPoints: 100, streakBonus: 10 } });
    opt.game.join({ id: "a", name: "Ann" });
    opt.game.start();
    expect(opt.game.answer("a", 1, 0).points).toBe(100);
    opt.game.next();
    opt.game.next();
    expect(opt.game.answer("a", 0, 5000).points).toBe(110);
    expect(opt.game.scoreboard()[0]).toMatchObject({ score: 210, streak: 2 });
  });

  test("dispose() clears timers", () => {
    const { game, clock } = setup();
    game.join({ id: "a", name: "Ann" });
    game.start();
    expect(clock.pending()).toBe(1);
    game.dispose();
    expect(clock.pending()).toBe(0);
  });

  test("ties share a rank", () => {
    const { game } = setup();
    for (const id of ["a", "b", "c"]) game.join({ id, name: id });
    game.start();
    game.answer("a", 1, 0);
    game.answer("b", 1, 0);
    game.answer("c", 0, 0);
    expect(game.scoreboard().map((p) => p.rank)).toEqual([1, 1, 3]);
  });
});
