// packages/game/examples/arena on workerd: the matchmaking queue in a Durable Object
// (MiuMatchmaker), signed tickets gating the room Durable Object (MiuRooms), tic-tac-toe over
// real WebSockets, then ratings, achievements and the weekly leaderboard in D1.

import { connect } from "@miujs/realtime/client";
import { connectMatch, findMatch } from "@miujs/game/client";
import { Client, check, eq, mcp, scenario, waitFor, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

export const app: AppSpec = { name: "arena", dir: "packages/game/examples/arena", vars: { MIU_GAME_SECRET: "workerd-harness-game-secret-0123456789abcdef" } };

const auth = (name: string) => ({ authorization: `Bearer guest:${name}` });

export async function run(dev: Dev, _ctx: SuiteContext) {
  const S = (name: string, fn: () => Promise<string | void>) => scenario("arena", name, fn);
  const base = dev.url;
  const wsBase = dev.ws;

  await S("matchmaking without auth is 401", async () => {
    const r = await new Client(base).post("/match/duel/join", {});
    eq(r.status, 401, "anonymous join");
  });

  let annMatch: any;
  let bobMatch: any;
  await S("two guests queue in the matchmaker Durable Object and get matched", async () => {
    const t0 = performance.now();
    [annMatch, bobMatch] = await Promise.all([findMatch(base, "duel", { headers: auth("ann") }), findMatch(base, "duel", { headers: auth("bob") })]);
    eq(annMatch.room.id, bobMatch.room.id, "same room");
    eq(annMatch.matchId, bobMatch.matchId, "same match");
    check(annMatch.team !== bobMatch.team, "different teams");
    return `matched in ${Math.round(performance.now() - t0)} ms`;
  });

  await S("the room refuses connections without a genuine ticket", async () => {
    const intruder = connect(wsBase + annMatch.room.url, { name: "eve", reconnect: false });
    let refused = false;
    await intruder.ready.catch(() => (refused = true));
    check(refused, "no-ticket connection joined");
    const forged = connectMatch(wsBase + annMatch.room.url, "not-a-ticket", { name: "eve", reconnect: false });
    let forgedRefused = false;
    await forged.seated.catch(() => (forgedRefused = true));
    check(forgedRefused, "forged ticket was seated");
  });

  await S("tickets seat both players; turns enforced; X wins; ratings, achievement and game.over broadcast", async () => {
    const ann = connectMatch(wsBase + annMatch.room.url, annMatch.ticket, { name: "ann" });
    const bob = connectMatch(wsBase + bobMatch.room.url, bobMatch.ticket, { name: "bob" });
    const [annSeat, bobSeat] = await Promise.all([ann.seated, bob.seated]);
    eq([annSeat.userId, bobSeat.userId], ["g_ann", "g_bob"], "seats");
    const x = annMatch.team === 0 ? ann : bob;
    const o = annMatch.team === 0 ? bob : ann;
    const xUser = annMatch.team === 0 ? "g_ann" : "g_bob";
    const events: Record<string, any[]> = { x: [], o: [] };
    for (const [k, c] of [["x", x], ["o", o]] as const) {
      c.room.on("game.over", (d) => events[k].push(["game.over", d]));
      c.room.on("achievement.unlocked", (d) => events[k].push(["achievement.unlocked", d]));
    }
    await waitFor(() => x.room.state?.phase === "playing" && o.room.state?.phase === "playing", 5000, "playing");
    const oErrors: string[] = [];
    o.room.on("error", (e) => oErrors.push(e.code));
    o.room.send("move", { cell: 4 });
    await waitFor(() => oErrors.includes("MIU_E_ARENA_NOT_YOUR_TURN"), 5000, "not your turn");
    const play = async (c: typeof x, cell: number) => {
      c.room.send("move", { cell });
      await waitFor(() => x.room.state.board[cell] !== "" && o.room.state.board[cell] !== "", 5000, `move ${cell}`);
    };
    await play(x, 0);
    await play(o, 3);
    await play(x, 1);
    await play(o, 4);
    await play(x, 2);
    await waitFor(() => o.room.state.phase === "over", 5000, "game over");
    eq(o.room.state.winner, xUser, "winner");
    await waitFor(() => events.o.length > 0 && events.x.some((e) => e[0] === "achievement.unlocked"), 10_000, "game.over + achievement events");
    const over = events.o.find((e) => e[0] === "game.over")![1];
    check(Math.abs(over.ratings[xUser].after - 1516) < 1e-6, `rating after ${over.ratings[xUser]?.after}`);
    ann.room.close();
    bob.room.close();
    (globalThis as any).__arenaWinner = xUser;
  });

  await S("profile, achievements and weekly leaderboard read back from D1", async () => {
    const xUser = (globalThis as any).__arenaWinner as string;
    check(xUser, "no finished game");
    const me = await new Client(base, auth(xUser.slice(2))).get("/players/me");
    check(Math.abs(me.json.profile.ratings.duel.rating - 1516) < 1e-6, `profile: ${me.text.slice(0, 300)}`);
    eq([me.json.profile.gamesPlayed, me.json.profile.gamesWon], [1, 1], "games");
    eq(me.json.achievements.map((a: any) => a.id), ["firstWin"], "achievements");
    const top = await new Client(base).get("/leaderboards/arena-wins/top?n=5");
    eq(top.json.entries, [{ rank: 1, playerId: xUser, score: 1, name: xUser.slice(2) }], "leaderboard");
  });

  await S("MCP: match_status and leaderboard tools", async () => {
    const bot = new Client(base, auth("ann"));
    const tools = (await mcp(bot, "tools/list")).result.tools.map((t: { name: string }) => t.name);
    check(tools.includes("match_status") && tools.some((n: string) => n.startsWith("leaderboard_")), `tools: ${tools}`);
    const st = await mcp(bot, "tools/call", { name: "match_status", arguments: { queue: "duel" } });
    check(!st.error && !st.result?.isError, JSON.stringify(st).slice(0, 300));
  });

  await S("matchmaking notify WebSocket (forwarded to the matchmaker Durable Object)", async () => {
    // Browsers cannot set headers on WebSockets; Bun's WebSocket can.
    const ws = new WebSocket(`${wsBase}/match/duel/notify`, { headers: auth("cat") } as any);
    const frames: any[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    await waitFor(() => ws.readyState === WebSocket.OPEN, 5000, "notify socket open");
    await new Client(base, auth("cat")).post("/match/duel/join", {});
    await waitFor(() => frames.some((f) => f.t === "match" && f.status?.state === "queued"), 5000, "queued push");
    await new Client(base, auth("cat")).req("DELETE", "/match/duel/leave");
    ws.close();
    return `${frames.length} frames`;
  });
}
