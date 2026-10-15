import { expect, test } from "bun:test";
import { FakeClock, applyPatch, createRoomInstance } from "@miujs/realtime";
import type { MiuSocket } from "miujs";
import { QUESTIONS, createQuiz } from "../room.ts";

const QUESTION_MS = 20_000;
const quiz = createQuiz(
  [
    { text: "2 + 2?", choices: ["3", "4", "5"], answer: 1 },
    { text: "Capital of France?", choices: ["Paris", "Rome"], answer: 0 },
  ],
  { questionMs: QUESTION_MS },
);

interface Client extends MiuSocket {
  frames: any[];
  view: any;
  me: any;
  errors: any[];
}

function hasKey(v: unknown, key: string): boolean {
  if (!v || typeof v !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(v, key)) return true;
  return Object.values(v).some((x) => hasKey(x, key));
}

let n = 0;
function client(): Client {
  const c: Client = {
    id: `c${++n}`,
    data: undefined,
    frames: [],
    view: undefined,
    me: null,
    errors: [],
    send(m) {
      const f = JSON.parse(String(m));
      c.frames.push(f);
      if (f.t === "welcome") c.me = f.me;
      if (f.t === "state") c.view = f.state;
      if (f.t === "patch") c.view = applyPatch(c.view, f.ops);
      if (f.t === "error") c.errors.push(f);
      // The correct answer may only appear once the view is in reveal (or done).
      if (hasKey(f, "correct")) expect(["reveal", "done"]).toContain(c.view.phase);
    },
    close() {},
  };
  return c;
}

function setup() {
  const clock = new FakeClock(1_700_000_000_000);
  const inst = createRoomInstance(quiz, { id: "123456", clock });
  const say = (c: Client, type: string, data: unknown = {}) => inst.receive(c, JSON.stringify({ t: "msg", type, data }));
  return { clock, inst, say };
}

test("a full game with a host and 3 players: scoring, phases, leaderboard, no early leak", () => {
  const { clock, inst, say } = setup();
  const host = client();
  const [ann, bob, cat] = [client(), client(), client()];
  inst.connect(host, { name: "Host" });
  inst.connect(ann, { name: "Ann" });
  inst.connect(bob, { name: "Bob" });
  inst.connect(cat, { name: "Cat" });
  clock.advance(50); // joins reach the host in one batch per 50 ms presence window
  expect(host.me.role).toBe("host");
  expect(host.view.phase).toBe("lobby");
  expect(Object.keys(host.view.players)).toHaveLength(3); // the host does not play
  // Players get a slim view: themselves, not the roster.
  expect(ann.view.players).toBeUndefined();
  expect(ann.view.me).toEqual({ name: "Ann", score: 0, gained: 0, answered: false, rank: null });

  // Only the host can start.
  say(ann, "start");
  expect(ann.errors.at(-1).code).toBe("MIU_E_FORBIDDEN");
  say(host, "start");
  expect(ann.view.phase).toBe("question");
  expect(ann.view.question).toEqual({ text: "2 + 2?", choices: ["3", "4", "5"] });
  expect(ann.view.deadline).toBe(clock.now() + QUESTION_MS);

  // Q1 (answer 1): Ann instantly right, Bob right at half time, Cat wrong.
  say(ann, "answer", { choice: 1 });
  say(ann, "answer", { choice: 0 });
  expect(ann.errors.at(-1).code).toBe("MIU_E_QUIZ_ALREADY_ANSWERED");
  say(host, "answer", { choice: 1 });
  expect(host.errors.at(-1).code).toBe("MIU_E_FORBIDDEN");
  clock.advance(10_000);
  say(bob, "answer", { choice: 1 });
  say(cat, "answer", { choice: 9 });
  expect(cat.errors.at(-1).code).toBe("MIU_E_QUIZ_BAD_CHOICE");
  expect(cat.view.phase).toBe("question");
  expect(Object.keys(host.view.answered).sort()).toEqual([ann.me.id, bob.me.id].sort());
  expect([ann.view.me.answered, cat.view.me.answered]).toEqual([true, false]);
  say(cat, "answer", { choice: 0 });
  // Everyone answered → reveal right away.
  expect(cat.view.phase).toBe("reveal");
  expect(cat.view.reveal).toEqual({ correct: 1, counts: [1, 2, 0] });
  expect(host.view.players[ann.me.id]).toMatchObject({ score: 1000, gained: 1000 });
  expect(host.view.players[bob.me.id]).toMatchObject({ score: 750, gained: 750 });
  expect(cat.view.me).toMatchObject({ score: 0, gained: 0, rank: 3 });
  expect(ann.view.me).toMatchObject({ score: 1000, gained: 1000, rank: 1 });

  // Only the host moves on.
  say(bob, "next");
  expect(bob.errors.at(-1).code).toBe("MIU_E_FORBIDDEN");
  say(host, "next");
  expect(ann.view.phase).toBe("question");
  expect(ann.view.round).toBe(1);
  expect(ann.view.reveal).toBeNull();

  // Q2 (answer 0): Ann wrong, Bob right after 5s, Cat silent → deadline reveals.
  say(ann, "answer", { choice: 1 });
  clock.advance(5_000);
  say(bob, "answer", { choice: 0 });
  clock.advance(14_999);
  expect(ann.view.phase).toBe("question");
  clock.advance(1);
  expect(ann.view.phase).toBe("reveal");
  expect(ann.view.reveal).toEqual({ correct: 0, counts: [1, 1] });

  say(host, "next");
  for (const c of [host, ann, bob, cat]) {
    expect(c.view.phase).toBe("done");
    expect(c.view.leaderboard).toEqual([
      { id: bob.me.id, name: "Bob", score: 750 + 875 },
      { id: ann.me.id, name: "Ann", score: 1000 },
      { id: cat.me.id, name: "Cat", score: 0 },
    ]);
  }
  // The host's view is the server's state exactly.
  expect(host.view).toEqual(JSON.parse(JSON.stringify(inst.room.state)));
});

test("seating players fans out to the host only, not to every player (no O(N²) join frames)", () => {
  const { clock, inst } = setup();
  const host = client();
  inst.connect(host, { name: "Host" });
  const players: Client[] = [];
  for (let i = 0; i < 200; i++) {
    const c = client();
    inst.connect(c, { name: `p${i}` });
    players.push(c);
    if (i % 20 === 19) clock.advance(10);
  }
  clock.advance(100);
  expect(Object.keys(host.view.players)).toHaveLength(200);
  // Each player got welcome + state and nothing else while others joined.
  for (const p of players) expect(p.frames.map((f) => f.t)).toEqual(["welcome", "state"]);
  expect(host.frames.length).toBeLessThan(30);
});

test("an answer reaches only the host and the player who answered", () => {
  const { clock, inst, say } = setup();
  const host = client();
  inst.connect(host, { name: "Host" });
  const [ann, bob, cat] = [client(), client(), client()];
  for (const [c, name] of [[ann, "Ann"], [bob, "Bob"], [cat, "Cat"]] as const) inst.connect(c, { name });
  clock.advance(50);
  say(host, "start");
  const before = [host, ann, bob, cat].map((c) => c.frames.length);
  say(ann, "answer", { choice: 1 });
  expect([host, ann, bob, cat].map((c, i) => c.frames.length - before[i])).toEqual([1, 1, 0, 0]);
  expect(host.view.answered).toEqual({ [ann.me.id]: true });
});

test("leaving players drop out of the host's roster; the leaderboard is only built when scores exist", () => {
  const { clock, inst, say } = setup();
  const host = client();
  const ann = client();
  const bob = client();
  inst.connect(host, { name: "Host" });
  inst.connect(ann, { name: "Ann" });
  inst.connect(bob, { name: "Bob" });
  clock.advance(50);
  expect(host.view.leaderboard).toEqual([]);
  inst.room.kick(bob.me.id);
  clock.advance(50);
  expect(Object.keys(host.view.players)).toEqual([ann.me.id]);
  say(host, "start");
  say(ann, "answer", { choice: 1 });
  expect(host.view.leaderboard).toEqual([{ id: ann.me.id, name: "Ann", score: 1000 }]);
  expect(ann.view.leaderboard).toEqual([{ id: ann.me.id, name: "Ann", score: 1000 }]);
});

test("answers sent outside a question are rejected", () => {
  const { inst, say } = setup();
  const host = client();
  const ann = client();
  inst.connect(host, { name: "Host" });
  inst.connect(ann, { name: "Ann" });
  say(ann, "answer", { choice: 0 });
  expect(ann.errors.at(-1).code).toBe("MIU_E_QUIZ_NOT_ACCEPTING");
  say(host, "next");
  expect(host.errors.at(-1).code).toBe("MIU_E_QUIZ_WRONG_PHASE");
});

test("starting needs at least one player", () => {
  const { inst, say } = setup();
  const host = client();
  inst.connect(host, { name: "Host" });
  say(host, "start");
  expect(host.errors.at(-1).code).toBe("MIU_E_QUIZ_NO_PLAYERS");
});

test("the built-in question set never ships answers in state", () => {
  expect(QUESTIONS.length).toBeGreaterThan(3);
  const def = createQuiz(QUESTIONS);
  const inst = createRoomInstance(def, { id: "1", clock: new FakeClock() });
  const host = client();
  inst.connect(host, { name: "Host" });
  inst.connect(client(), { name: "Ann" });
  inst.receive(host, JSON.stringify({ t: "msg", type: "start", data: {} }));
  expect(JSON.stringify(inst.room.state)).not.toContain('"answer"');
  expect(hasKey(inst.room.state, "correct")).toBe(false);
});

test("the question deadline is a named timer, so it survives hibernation (snapshot → durable restore)", async () => {
  const { clock, inst, say } = setup();
  const host = client();
  const ann = client();
  inst.connect(host, { name: "Host" });
  inst.connect(ann, { name: "Ann" });
  say(host, "start");
  const snap = JSON.parse(JSON.stringify(inst.snapshot()));
  inst.close();
  expect(snap.timers).toEqual([expect.objectContaining({ name: "reveal", at: clock.now() + QUESTION_MS })]);

  const woken = createRoomInstance(quiz, { id: "123456", clock, durable: true, restore: snap });
  woken.attach(ann, ann.me.id);
  clock.advance(QUESTION_MS);
  await woken.runDue();
  expect(woken.room.state.phase).toBe("reveal");
  expect(ann.view.phase).toBe("reveal");
});

test("a stale deadline from an earlier round never reveals the next question early", () => {
  const { clock, inst, say } = setup();
  const host = client();
  const ann = client();
  inst.connect(host, { name: "Host" });
  inst.connect(ann, { name: "Ann" });
  say(host, "start");
  clock.advance(1_000);
  say(ann, "answer", { choice: 1 }); // everyone answered → reveal now; round-0 deadline is moot
  say(host, "next");
  clock.advance(QUESTION_MS - 1_000); // round 0's deadline time passes during round 1
  expect(ann.view.phase).toBe("question");
  clock.advance(1_000);
  expect(ann.view.phase).toBe("reveal");
});
