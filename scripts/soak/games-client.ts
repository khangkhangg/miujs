// Load-driver child process for scripts/soak/games.ts. Prints `JOINED <n>` once its sockets are in,
// then the Recorder as JSON on its last stdout line.
//
//   bun scripts/soak/games-client.ts idle  <port> <json {rooms, perRoom, holdMs, vu}>
//   bun scripts/soak/games-client.ts flood <port> <json {rooms, perRoom, intervalMs, durationMs, view, vu}>
//   bun scripts/soak/games-client.ts life  <port> <json {vus, durationMs, vu}>
//
// Raw WebSockets with string matching on the hot path (no JSON.parse per patch), so the client is
// cheap next to the server it measures. Every socket carries its own x-soak-ip.

import { Recorder, rand, sleep, waitFor } from "./lib.ts";

const [mode, port, cfgJson] = process.argv.slice(2);
const cfg = JSON.parse(cfgJson ?? "{}");
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
const rec = new Recorder();
let ipN = (cfg.vu ?? 0) * 100_000;
const freshIp = () => {
  ipN++;
  return `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN & 255}`;
};

interface Sock {
  ws: WebSocket;
  me: string | null;
  resume: string | null;
  joined: Promise<boolean>;
  onText: ((s: string) => void) | null;
  closed: boolean;
}

function open(type: string, id: string, query: string, ip = freshIp()): Sock {
  // Bun's WebSocket takes headers (the soak server reads x-soak-ip as the client address).
  const ws = new (WebSocket as any)(`${wsBase}/rooms/${type}/${id}?${query}`, { headers: { "x-soak-ip": ip } }) as WebSocket;
  const s: Sock = { ws, me: null, resume: null, joined: null as never, onText: null, closed: false };
  s.joined = new Promise<boolean>((resolve) => {
    let welcomed = false;
    ws.onmessage = (e) => {
      const text = String(e.data);
      rec.wsFramesIn++;
      if (!welcomed && text.startsWith('{"t":"welcome"')) {
        const f = JSON.parse(text);
        s.me = f.me.id;
        s.resume = f.resumeToken;
        welcomed = true;
        return;
      }
      if (welcomed && text.startsWith('{"t":"state"')) resolve(true);
      if (text.startsWith('{"t":"error"')) rec.err("ws", JSON.parse(text).code);
      s.onText?.(text);
    };
    ws.onclose = () => {
      s.closed = true;
      resolve(false);
    };
  });
  return s;
}

async function create(type: string): Promise<{ id: string; hostKey?: string }> {
  return (await fetch(`${base}/__soak/room?type=${type}`, { method: "POST" })).json();
}

const send = (s: Sock, type: string, data: unknown) => {
  if (s.ws.readyState !== 1) return false;
  s.ws.send(JSON.stringify({ t: "msg", type, data }));
  rec.wsFramesOut++;
  return true;
};

// ---- idle: N joined sockets that do nothing (bytes per idle player) --------------------------------

async function idle() {
  const socks: Sock[] = [];
  for (const r of cfg.rooms as { type: string; id: string; hostKey?: string }[]) {
    for (let i = 0; i < cfg.perRoom; i++) socks.push(open(r.type, r.id, `name=p${i}`));
    // Join in small waves: the measurement is memory at rest, not a join storm.
    await Promise.all(socks.slice(-cfg.perRoom).map((s) => s.joined));
  }
  const ok = (await Promise.all(socks.map((s) => s.joined))).filter(Boolean).length;
  console.log(`JOINED ${ok}`);
  await sleep(cfg.holdMs);
  for (const s of socks) s.ws.close();
  await sleep(200);
}

// ---- flood: players stream moves; latency = send → own update arrives ---------------------------------

async function flood() {
  const players: { s: Sock; idx: number }[] = [];
  let idx = 0;
  for (const r of cfg.rooms as { type: string; id: string }[]) {
    const batch: Sock[] = [];
    for (let i = 0; i < cfg.perRoom; i++) {
      const s = open(r.type, r.id, `name=p${i}`);
      batch.push(s);
      players.push({ s, idx: idx++ });
    }
    await Promise.all(batch.map((s) => s.joined));
  }
  console.log(`JOINED ${players.filter((p) => p.s.me).length}`);
  const end = performance.now() + cfg.durationMs;
  let bytesIn = 0;
  await Promise.all(
    players.map(async ({ s }) => {
      let seq = 0;
      const pending = new Map<number, number>();
      let wake: (() => void) | null = null;
      // The patch that carries our own move back to us.
      const needle = (n: number) => (cfg.view ? `"/me/x","value":${n}}` : `/pos/${s.me}/x","value":${n}}`);
      s.onText = (text) => {
        bytesIn += text.length;
        if (!pending.size) return;
        for (const [n, at] of pending) {
          if (text.includes(needle(n))) {
            rec.ok("move → own update", performance.now() - at);
            pending.delete(n);
            if (n === seq && wake) wake();
          }
        }
      };
      await sleep(rand(Math.max(1, cfg.intervalMs || 5)));
      while (performance.now() < end && !s.closed) {
        seq++;
        pending.set(seq, performance.now());
        send(s, "move", { x: seq, y: 1 });
        if (cfg.intervalMs > 0) await sleep(cfg.intervalMs);
        else
          await new Promise<void>((r) => {
            const t = setTimeout(r, 5_000);
            wake = () => {
              clearTimeout(t);
              wake = null;
              r();
            };
          });
        // A move superseded before its patch went out never echoes back: forget old ones.
        for (const n of pending.keys()) if (n < seq - 20) pending.delete(n);
      }
    }),
  );
  (rec as any).bytesIn = bytesIn;
  for (const { s } of players) s.ws.close();
  await sleep(200);
}

// ---- life: rooms are created, played and finished; players join, leave and reconnect ------------------

async function quizGame(vu: number) {
  const room = await create("quiz");
  const host = open("quiz", room.id, `name=Host&role=host&hostKey=${room.hostKey}`);
  if (!(await host.joined)) return rec.err("quiz", "host join");
  const n = 3 + rand(6);
  let players = Array.from({ length: n }, (_, i) => open("quiz", room.id, `name=P${vu}_${i}`));
  const t0 = performance.now();
  if ((await Promise.all(players.map((p) => p.joined))).some((x) => !x)) rec.err("quiz", "player join");
  rec.ok("quiz join (all players)", performance.now() - t0);
  let phase = "";
  host.onText = (text) => {
    const m = /\/phase","value":"(\w+)"/.exec(text) ?? /"phase":"(\w+)"/.exec(text);
    if (m) phase = m[1];
  };
  send(host, "start", {});
  for (let round = 0; round < 5 && !rec.stopped; round++) {
    if (!(await waitFor(() => phase === "question", 25_000))) return rec.err("quiz", `round ${round} never opened`);
    // Someone drops (no close frame) and comes back with their resume token mid-question.
    if (round === 2 && players.length > 2) {
      const gone = players.pop()!;
      const token = gone.resume;
      gone.ws.close(4000, "network blip"); // non-terminal: the seat is kept for the grace period
      await sleep(rand(200));
      const back = open("quiz", room.id, `resume=${token}`);
      const t = performance.now();
      if (await back.joined) {
        rec.ok("quiz resume", performance.now() - t);
        players.push(back);
      }
    }
    const t = performance.now();
    for (const p of players) send(p, "answer", { choice: rand(4) });
    if (!(await waitFor(() => phase === "reveal", 25_000))) return rec.err("quiz", `round ${round} never revealed`);
    rec.ok("quiz answers → reveal", performance.now() - t);
    // In some games a player leaves for good after round 3.
    if (round === 3 && vu % 3 === 0 && players.length > 2) players.pop()!.ws.close(1000, "bye");
    send(host, "next", {});
  }
  await waitFor(() => phase === "done", 5_000);
  rec.ok("quiz game", performance.now() - t0);
  for (const p of [host, ...players]) p.ws.close(1000, "bye");
  players = [];
}

async function actionGame(vu: number) {
  const view = vu % 2 === 0;
  const room = await create(view ? "actionview" : "action");
  const type = view ? "actionview" : "action";
  const n = 4 + rand(9);
  const players = Array.from({ length: n }, (_, i) => open(type, room.id, `name=A${vu}_${i}`));
  await Promise.all(players.map((p) => p.joined));
  const started = performance.now();
  const end = started + 2_000 + rand(6_000);
  let seq = 0;
  while (performance.now() < end && !rec.stopped) {
    for (const p of players) send(p, "move", { x: ++seq, y: rand(100) });
    // Abrupt drop + resume of a random player now and then.
    if (rand(40) === 0) {
      const i = rand(players.length);
      const token = players[i].resume;
      players[i].ws.close(4000, "blip");
      const back = open(type, room.id, `resume=${token}`);
      const t = performance.now();
      if (await back.joined) {
        rec.ok("action resume", performance.now() - t);
        players[i] = back;
      }
    }
    await sleep(50); // 20 Hz inputs
  }
  rec.ok("action game (2-8 s at 20 Hz)", performance.now() - started);
  for (const p of players) p.ws.close(1000, "bye");
}

async function life() {
  console.log("JOINED 0");
  const stopAt = performance.now() + cfg.durationMs;
  setTimeout(() => (rec.stopped = true), cfg.durationMs);
  await Promise.all(
    Array.from({ length: cfg.vus }, async (_, i) => {
      const vu = (cfg.vu ?? 0) * 1000 + i;
      while (performance.now() < stopAt) {
        try {
          if (i % 2 === 0) await quizGame(vu);
          else await actionGame(vu);
        } catch (e) {
          rec.err("vu", String(e).slice(0, 80));
        }
        await sleep(rand(100));
      }
    }),
  );
}

if (mode === "idle") await idle();
else if (mode === "flood") await flood();
else if (mode === "life") await life();
else throw new Error(`unknown mode ${mode}`);

console.log(
  JSON.stringify({
    all: rec.all.toJSON(),
    ops: Object.fromEntries([...rec.ops].map(([k, h]) => [k, h.toJSON()])),
    errors: Object.fromEntries(rec.errors),
    wsFramesIn: rec.wsFramesIn,
    wsFramesOut: rec.wsFramesOut,
    bytesIn: (rec as any).bytesIn ?? 0,
  }),
);
process.exit(0);
