// What a cheater in the classroom can try against the quiz.
import { expect, test } from "bun:test";
import { connect } from "@miujs/realtime/client";
import { miu } from "miujs";
import { FakeClock, createRoomInstance } from "@miujs/realtime";
import app, { createApp } from "../app.ts";
import { createQuiz } from "../room.ts";

async function waitFor(fn: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a player who joins before the host does not become host; the creator's hostKey makes the host", async () => {
  const s = await app.listen(0);
  try {
    const created = await (await fetch(s.url + "api/games", { method: "POST" })).json();
    expect(typeof created.hostKey).toBe("string");
    const url = s.url.replace("http", "ws") + `rooms/quiz/${created.id}`;
    const eve = connect(url, { name: "Eve", reconnect: false });
    await eve.ready;
    expect(eve.me?.role).toBe("player");
    const errors: string[] = [];
    eve.on("error", (e: { code: string }) => errors.push(e.code));
    eve.send("start");
    await waitFor(() => errors.length > 0);
    expect(errors[0]).toBe("MIU_E_FORBIDDEN");
    const host = connect(url, { name: "Host", role: "host", hostKey: created.hostKey, reconnect: false });
    await host.ready;
    expect(host.me?.role).toBe("host");
    eve.close();
    host.close();
  } finally {
    await s.stop();
  }
});

test("rooms only exist once POST /api/games made them (no conjuring a quiz at a random URL)", async () => {
  const res = await app.request("/rooms/quiz/attacker-made", { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(404);
});

test("POST /api/games is rate limited per IP (no flooding rooms and join codes)", async () => {
  const quizApp = createApp({ gamesPerMinute: 6, gamesBurst: 3 });
  const s = await quizApp.listen(0);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(s.url + "api/games", { method: "POST" })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  } finally {
    await s.stop();
  }
});

test("a room holds at most 500 players", () => {
  const quiz = createQuiz([{ text: "q", choices: ["a", "b"], answer: 0 }]);
  expect(quiz.def.maxPlayers).toBe(500);
  const inst = createRoomInstance(quiz, { id: "x", clock: new FakeClock(0) });
  expect(inst.room.players).toEqual([]);
  void miu;
});
