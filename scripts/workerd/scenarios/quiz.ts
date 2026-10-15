// examples/quiz on workerd: the HTML page, join codes in KV, Durable Object rooms over real
// WebSockets (join, answer, broadcast), the question deadline on a DO alarm, and a broadcast to N
// simulated players.

import { connect } from "@miujs/realtime/client";
import { Client, check, eq, mcp, metrics, percentiles, scenario, sleep, waitFor, workerdMemoryMb, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

export const app: AppSpec = { name: "quiz", dir: "examples/quiz" };

export async function run(dev: Dev, ctx: SuiteContext) {
  const S = (name: string, fn: () => Promise<string | void>) => scenario("quiz", name, fn);
  const c = new Client(dev.url);

  await S("serves the HTML client (Text module import)", async () => {
    const r = await c.get("/");
    check(r.status === 200 && r.headers.get("content-type")?.includes("text/html") && r.text.includes("MiuJS Quiz"), `status ${r.status}`);
  });

  let room = { id: "", code: "" };
  await S("create game: 6-digit code stored in KV, resolves to the room", async () => {
    const r = await c.post("/api/games");
    check(/^\d{6}$/.test(r.json?.code), `create: ${r.text.slice(0, 300)}`);
    room = r.json;
    const found = await c.get(`/rooms/code/${room.code}`);
    eq(found.json, { type: "quiz", id: room.id }, "code lookup");
    eq((await c.get("/rooms/code/000000")).json?.error?.code, "MIU_E_ROOM_CODE_UNKNOWN", "unknown code");
  });

  await S("plain HTTP on a room URL is 426 MIU_E_WS_EXPECTED; unknown type 404", async () => {
    const r = await c.get(`/rooms/quiz/${room.id}`);
    eq([r.status, r.json?.error?.code], [426, "MIU_E_WS_EXPECTED"], "plain GET");
    const ws = await c.get(`/rooms/nope/${room.id}`, { headers: { upgrade: "websocket" } });
    check(ws.status === 404 || ws.status === 426, `unknown type ${ws.status}`);
  });

  await S("host + 2 players: start, question without the answer, answers, reveal broadcast, next", async () => {
    const url = `${dev.ws}/rooms/quiz/${room.id}`;
    const host = connect(url, { name: "Host", reconnect: false });
    await host.ready;
    eq(host.me?.role, "host", "first joiner is host");
    const ann = connect(url, { name: "Ann", reconnect: false });
    const bob = connect(url, { name: "Bob", reconnect: false });
    await Promise.all([ann.ready, bob.ready]);
    const raw: string[] = [];
    ann.socket!.addEventListener("message", (e) => raw.push(String(e.data)));
    host.send("start");
    await waitFor(() => ann.state?.phase === "question" && bob.state?.phase === "question", 5000, "question phase");
    eq(ann.state.question.choices.length, 4, "choices");
    check(!raw.join("").includes('"answer"') && !raw.join("").includes("correct"), "the answer leaked before reveal");
    ann.send("answer", { choice: 0 });
    bob.send("answer", { choice: 1 });
    await waitFor(() => ann.state?.phase === "reveal" && host.state?.phase === "reveal", 5000, "reveal after everyone answered");
    eq(ann.state.reveal.correct, 0, "correct choice");
    check(ann.state.players[ann.me!.id].score > 0 && bob.state.players[bob.me!.id].score === 0, "scores");
    host.send("next");
    await waitFor(() => bob.state?.phase === "question" && bob.state.round === 1, 5000, "second question");
    for (const x of [host, ann, bob]) x.close();
  });

  await S("MCP: room_state reads the Durable Object", async () => {
    const tools = (await mcp(c, "tools/list")).result.tools.map((x: { name: string }) => x.name);
    check(tools.includes("room_state"), `tools: ${tools}`);
    const r = await mcp(c, "tools/call", { name: "room_state", arguments: { type: "quiz", id: room.id } });
    check(JSON.stringify(r).includes("leaderboard"), JSON.stringify(r).slice(0, 400));
  });

  await S(`broadcast to ${ctx.players} players: question (host action) and reveal (DO alarm at the deadline)`, async () => {
    const created = (await c.post("/api/games")).json;
    const url = `${dev.ws}/rooms/quiz/${created.id}`;
    const host = connect(url, { name: "Host", reconnect: false });
    await host.ready;
    const n = ctx.players;
    interface P {
      ws: WebSocket;
      joined: boolean;
      phaseAt: Record<string, number>;
      phase: string;
    }
    const players: P[] = [];
    const memBefore = workerdMemoryMb();
    // Each join changes shared state (players, leaderboard), so every seated player gets a patch:
    // joining N players sends ~N²/2 frames. Batch times show that cost growing.
    const batchMs: number[] = [];
    let lastFrame = performance.now();
    host.on("state", () => void (lastFrame = performance.now()));
    let frames = 0;
    const joinStart = performance.now();
    const BATCH = 100;
    for (let i = 0; i < n; i += BATCH) {
      const batch: Promise<void>[] = [];
      for (let j = i; j < Math.min(n, i + BATCH); j++) {
        const p: P = { ws: new WebSocket(`${url}?name=p${j}`), joined: false, phaseAt: {}, phase: "lobby" };
        players.push(p);
        batch.push(
          new Promise<void>((res, rej) => {
            const t = setTimeout(() => rej(new Error(`player ${j} did not join within 120 s (${players.filter((x) => x.joined).length} joined)`)), 120_000);
            p.ws.addEventListener("message", (e) => {
              lastFrame = performance.now();
              frames++;
              const f = JSON.parse(String(e.data));
              if (f.t === "state") {
                p.joined = true;
                clearTimeout(t);
                res();
              } else if (f.t === "patch") {
                for (const op of f.ops as { op: string; path: string; value?: any }[]) {
                  const phase = op.path === "/phase" ? op.value : op.path === "" ? op.value?.phase : undefined;
                  if (typeof phase === "string" && phase !== p.phase) {
                    p.phase = phase;
                    p.phaseAt[`${phase}:${Object.keys(p.phaseAt).length}`] = performance.now();
                  }
                }
              }
            });
            p.ws.addEventListener("error", () => rej(new Error(`player ${j} socket error`)));
          }),
        );
      }
      const b0 = performance.now();
      await Promise.all(batch);
      batchMs.push(Math.round(performance.now() - b0));
    }
    const joinMs = performance.now() - joinStart;
    // Joins fan out ~N²/2 patches (each join changes players + leaderboard for everyone). Let that
    // backlog drain before timing, or the broadcast would queue behind it.
    await waitFor(() => performance.now() - lastFrame > 1500, 600_000, "join patches to drain", 100);
    const drainedMs = performance.now() - joinStart;
    const joinFrames = frames;
    const memJoined = workerdMemoryMb();
    await waitFor(() => Object.keys(host.state?.players ?? {}).length === n, 30_000, "host sees every player");

    // 1) Host starts: every player gets the question patch.
    const t0 = performance.now();
    host.send("start");
    await waitFor(() => players.every((p) => p.phase === "question"), 60_000, "question at every player", 10);
    const question = players.map((p) => p.phaseAt["question:0"] - t0);
    const deadline = host.state.deadline as number;

    // 2) Nobody answers: the room's `reveal` timer (a Durable Object alarm) fires at the deadline.
    const wallAtT0 = Date.now();
    await waitFor(() => players.every((p) => p.phase === "reveal"), 40_000, "reveal (alarm) at every player", 10);
    const deadlinePerf = t0 + (deadline - wallAtT0);
    const reveal = players.map((p) => p.phaseAt["reveal:1"] - deadlinePerf);
    const memPeak = workerdMemoryMb();
    for (const p of players) p.ws.close();
    host.close();
    const q = percentiles(question);
    const r = percentiles(reveal);
    metrics.quizBroadcast = { players: n, joinAllMs: Math.round(joinMs), joinDrainedMs: Math.round(drainedMs), joinFrames, joinBatchMs: batchMs, question: q, revealAfterDeadline: r, workerdRssMb: { before: memBefore, joined: memJoined, afterBroadcasts: memPeak } };
    return `${n} joined in ${Math.round(joinMs)} ms (${joinFrames} join frames drained at ${Math.round(drainedMs)} ms); question broadcast p50 ${q.p50} / p95 ${q.p95} / max ${q.max} ms; alarm reveal after deadline p50 ${r.p50} / p95 ${r.p95} ms; workerd RSS ${memBefore} → ${memJoined} → ${memPeak} MB`;
  });

  await S("room survives a workerd restart: state, seat (resume token) and pending timer persist", async () => {
    const created = (await c.post("/api/games")).json;
    const url = `${dev.ws}/rooms/quiz/${created.id}`;
    const host = connect(url, { name: "Host", reconnect: false });
    await host.ready;
    const ann = connect(url, { name: "Ann", reconnect: false });
    await ann.ready;
    const annId = ann.me!.id;
    const resume = ann.resumeToken!;
    const hostResume = host.resumeToken!;
    host.send("start");
    await waitFor(() => ann.state?.phase === "question", 5000, "question");
    const deadline = ann.state.deadline as number;
    host.close();
    ann.close();
    const dev2 = await ctx.restart();
    const ann2 = connect(`${dev2.ws}/rooms/quiz/${created.id}`, { resume, reconnect: false });
    await ann2.ready;
    eq(ann2.me?.id, annId, "same seat after restart");
    eq(ann2.state?.phase, "question", "phase after restart");
    const host2 = connect(`${dev2.ws}/rooms/quiz/${created.id}`, { resume: hostResume, reconnect: false });
    await host2.ready;
    // The quiz's deadline is a named timer persisted in DO storage and armed as an alarm.
    const wait = Math.max(0, deadline - Date.now()) + 5000;
    await waitFor(() => ann2.state?.phase === "reveal", wait, "reveal from the persisted alarm after restart");
    ann2.close();
    host2.close();
    return `reveal arrived ${Date.now() - deadline} ms after the deadline`;
  });
  void sleep;
}
