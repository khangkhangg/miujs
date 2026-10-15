import { expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { gameErrors } from "../src/errors.ts";
import * as api from "../src/index.ts";
import * as client from "../src/client.ts";

test("every game error is a MiuError with a MIU_E_GAME_* code, a message and a fix", () => {
  const cfg = ["something is wrong here", "do this other thing instead"];
  const sample: Record<string, unknown[]> = { queueConfig: cfg, roomConfig: cfg, leaderboardConfig: cfg, queueUnknown: ["x", ["ranked"]], regionRequired: [["eu"]], lobbyNotReady: [["Bob"], 2], scoreRateLimited: [10] };
  for (const [name, make] of Object.entries(gameErrors)) {
    const err = (make as (...a: unknown[]) => unknown)(...(sample[name] ?? ["x", "y"]));
    expect(isMiuError(err)).toBe(true);
    const e = err as { code: string; message: string; fix?: string; status: number };
    expect(e.code).toMatch(/^MIU_E_GAME_[A-Z_]+$/);
    expect(e.message.length).toBeGreaterThan(5);
    expect(e.fix?.length ?? 0).toBeGreaterThan(10);
  }
});

test("public entry points export the documented API", () => {
  for (const name of ["matchmaker", "lobbies", "leaderboard", "defineAchievements", "gameRoom", "reportResult", "seatOf", "fixedStep", "acceptInput", "processInputs", "ackedSeqs", "profiles", "createMatchmakerDurableObject", "createLobbyDurableObject", "GameStore", "gameMigrations", "eloMatch", "glicko2Match", "periodKey", "signResult", "resultReporter", "signScoreProof"]) {
    expect(typeof (api as Record<string, unknown>)[name]).not.toBe("undefined");
  }
  expect(Object.keys(client).sort()).toEqual(["connectMatch", "findMatch", "lerpState", "predictor", "snapshotInterpolation"]);
});
