// End-to-end: the arena example over real WebSockets on Bun. Two guests queue, get matched,
// present their tickets, play tic-tac-toe, and the result moves Elo ratings, the weekly wins
// leaderboard and unlocks "First win".

import { expect, test } from "bun:test";
import app from "../examples/arena/app.ts";
import { connect } from "@miujs/realtime/client";
import { connectMatch, findMatch } from "../src/client.ts";
import { waitFor } from "./helpers.ts";

const auth = (name: string) => ({ authorization: `Bearer guest:${name}` });

test("arena: matchmaking → tickets → play over WebSockets → ratings, leaderboard, achievement", async () => {
  const server = await app.listen(0);
  const base = server.url.replace(/\/$/, "");
  const wsBase = base.replace(/^http/, "ws");
  try {
    // Both players queue; long-polling status resolves when the matchmaker pairs them.
    const [annMatch, bobMatch] = await Promise.all([findMatch(base, "duel", { headers: auth("ann") }), findMatch(base, "duel", { headers: auth("bob") })]);
    expect(annMatch.room.id).toBe(bobMatch.room.id);
    expect(annMatch.matchId).toBe(bobMatch.matchId);
    expect(annMatch.team).not.toBe(bobMatch.team);

    // Without a genuine ticket the upgrade is refused before the room sees the connection,
    // so nobody can take a seat (or fill the room) ahead of the matched players.
    const intruder = connect(wsBase + annMatch.room.url, { name: "eve", reconnect: false });
    await expect(intruder.ready).rejects.toThrow();
    const forged = connectMatch(wsBase + annMatch.room.url, "not-a-ticket", { name: "eve", reconnect: false });
    await expect(forged.seated).rejects.toThrow();

    const ann = connectMatch(wsBase + annMatch.room.url, annMatch.ticket, { name: "ann" });
    const bob = connectMatch(wsBase + bobMatch.room.url, bobMatch.ticket, { name: "bob" });
    const [annSeat, bobSeat] = await Promise.all([ann.seated, bob.seated]);
    expect(annSeat.userId).toBe("g_ann");
    expect(bobSeat.userId).toBe("g_bob");

    const x = annMatch.team === 0 ? ann : bob;
    const o = annMatch.team === 0 ? bob : ann;
    const xUser = annMatch.team === 0 ? "g_ann" : "g_bob";
    const events: Record<string, any[]> = { x: [], o: [] };
    for (const [k, c] of [["x", x], ["o", o]] as const) {
      c.room.on("game.over", (d) => events[k].push(["game.over", d]));
      c.room.on("achievement.unlocked", (d) => events[k].push(["achievement.unlocked", d]));
    }
    await waitFor(() => x.room.state?.phase === "playing" && o.room.state?.phase === "playing");
    expect(x.room.state.marks).toEqual({ g_ann: annMatch.team === 0 ? "X" : "O", g_bob: annMatch.team === 0 ? "O" : "X" });

    // O may not move first.
    const oErrors: string[] = [];
    o.room.on("error", (e) => oErrors.push(e.code));
    o.room.send("move", { cell: 4 });
    await waitFor(() => oErrors.includes("MIU_E_ARENA_NOT_YOUR_TURN"));

    const play = async (c: typeof x, cell: number) => {
      c.room.send("move", { cell });
      await waitFor(() => x.room.state.board[cell] !== "" && o.room.state.board[cell] !== "");
    };
    await play(x, 0);
    await play(o, 3);
    await play(x, 1);
    await play(o, 4);
    await play(x, 2); // top row: X wins
    await waitFor(() => o.room.state.phase === "over");
    expect(o.room.state.winner).toBe(xUser);
    await waitFor(() => events.o.length > 0 && events.x.some((e) => e[0] === "achievement.unlocked"));
    const over = events.o.find((e) => e[0] === "game.over")![1];
    expect(over.winner).toBe(xUser);
    expect(over.ratings[xUser].after).toBeCloseTo(1516, 6);
    expect(events.x.find((e) => e[0] === "achievement.unlocked")![1]).toMatchObject({ id: "firstWin", playerId: xUser });
    expect(events.o.some((e) => e[0] === "achievement.unlocked")).toBe(false);

    // Moves after the game are refused.
    x.room.send("move", { cell: 8 });
    const xErrors: string[] = [];
    x.room.on("error", (e) => xErrors.push(e.code));
    await waitFor(() => xErrors.includes("MIU_E_ARENA_GAME_OVER"));

    // Profiles, leaderboard and achievements over HTTP.
    const me = await (await fetch(`${base}/players/me`, { headers: auth(xUser.slice(2)) })).json();
    expect(me.profile.ratings.duel.rating).toBeCloseTo(1516, 6);
    expect(me.profile).toMatchObject({ gamesPlayed: 1, gamesWon: 1 });
    expect(me.achievements.map((a: any) => a.id)).toEqual(["firstWin"]);
    const top = await (await fetch(`${base}/leaderboards/arena-wins/top?n=5`)).json();
    expect(top.entries).toEqual([{ rank: 1, playerId: xUser, score: 1, name: xUser.slice(2) }]);

    ann.room.close();
    bob.room.close();
  } finally {
    await server.stop();
  }
}, 30_000);

test("arena: the app wires every game plugin and declares its Cloudflare needs", async () => {
  await app.ready();
  const info = app.inspect() as any;
  const names = info.plugins.map((p: any) => p.name);
  expect(names).toEqual(expect.arrayContaining(["rooms", "matchmaker", "leaderboard:arena-wins", "profiles"]));
  expect(info.cloudflare.durableObjects).toEqual(expect.arrayContaining([{ binding: "MIU_ROOMS", className: "MiuRooms" }, { binding: "MIU_MATCH", className: "MiuMatchmaker" }]));
  const tools = app.tools().map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["leaderboard_arena-wins_top", "player_profile", "match_status"]));
});
