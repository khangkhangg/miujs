// Keeps the README's realtime snippet compiling (checked by `bun run typecheck`).
import { expect, test } from "bun:test";
import { miu, t } from "miujs";
import { defineRoom, rooms } from "@miujs/realtime";

export const quiz = defineRoom("quiz", {
  state: t.object({ phase: t.enum(["lobby", "question", "reveal"]), scores: t.record(t.number()) }),
  secret: () => ({ correct: 2 }), // server-only state, never sent to clients
  client: { answer: t.object({ choice: t.integer() }) },
  init: () => ({ phase: "lobby" as const, scores: {} }),
  on: {
    answer: ({ room, sender, msg }) => {
      if (msg.choice === room.secret.correct) room.state.scores[sender.id] = (room.state.scores[sender.id] ?? 0) + 1000;
    },
  },
});

test("README realtime snippet builds an app", async () => {
  const app = miu({ logLevel: "silent", plugins: [rooms({ rooms: [quiz] })] });
  await app.ready();
  expect(app.inspect().plugins.map((p) => p.name)).toContain("rooms");
});
