// Load testing for rooms: N simulated clients join one room, send actions at a steady rate, and
// we measure how long it takes for a `state` patch to arrive after each action. `miu loadtest`
// calls this; it also works from a script:
//
//   import { loadtest } from "@miujs/realtime/loadtest";
//   const r = await loadtest({ url: "ws://localhost:3000/rooms/quiz/r1", players: 200, durationMs: 30_000,
//                              actions: [{ type: "answer", data: { choice: 1 } }] });
//   console.log(r.latency); // { p50, p95, p99, ... } in ms
//
// Latency is measured from sending an action to the next patch that client receives. Patches are
// not tagged with the action that caused them, so in busy rooms another player's change can
// answer first; treat the numbers as "time until this client saw the room move".

import { connect, type ConnectOptions, type RoomClient } from "./client.ts";

export interface LoadAction {
  type: string;
  data?: unknown;
}

export interface LoadtestOptions {
  /** Room WebSocket URL, e.g. `ws://localhost:3000/rooms/quiz/r1`. */
  url: string;
  players: number;
  durationMs: number;
  /**
   * Actions to cycle through, or a function picking one per send (`n` counts that player's sends).
   * Leave out (or pass `[]`) for a join-only run: players join, stay connected for `durationMs`,
   * and the report's `joinLatency` / `welcomeLatency` are the numbers to read.
   */
  actions?: LoadAction[] | ((ctx: { player: number; n: number }) => LoadAction);
  /** Sends per second per player. Default 5. */
  ratePerSecond?: number;
  /** Give up on players that have not joined after this long. Default 5000 ms. */
  joinTimeoutMs?: number;
  /** After the run, wait this long for outstanding patches. Default 500 ms. */
  drainMs?: number;
  encoding?: ConnectOptions["encoding"];
  WebSocket?: ConnectOptions["WebSocket"];
  /** Bot display names. Default `bot1`, `bot2`, ... */
  name?: (player: number) => string;
}

export interface LatencySummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface LoadtestReport {
  players: number;
  /** Players that joined in time. */
  joined: number;
  durationMs: number;
  /** Actions sent. */
  sent: number;
  /** Actions that were followed by a patch (latency samples). */
  samples: number;
  /** Error frames received, in total and by code. */
  errors: number;
  errorCodes: Record<string, number>;
  /** Milliseconds from action to the next state patch. */
  latency: LatencySummary;
  /** Milliseconds from opening the socket to the `welcome` frame, for players that got one. */
  welcomeLatency: LatencySummary;
  /** Milliseconds from opening the socket to the first full `state` (joined), for players that joined. */
  joinLatency: LatencySummary;
  /**
   * Players that did not join, by reason: the error code the server sent (e.g. `MIU_E_ROOM_FULL`),
   * else `close_<code>` for a socket closed before joining, else `timeout`.
   */
  joinFailures: Record<string, number>;
}

/** Nearest-rank percentile of ascending-sorted samples (0 for none). */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(samples: readonly number[]): LatencySummary {
  if (!samples.length) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  const xs = [...samples].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { count: xs.length, min: xs[0], max: xs[xs.length - 1], mean, p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99) };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves with `p`, or `fallback` after `ms`; the timer is cleared either way so nothing keeps the process alive. */
function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)));
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Simulate `players` clients against one room and report patch latency percentiles. */
export async function loadtest(opts: LoadtestOptions): Promise<LoadtestReport> {
  const rate = opts.ratePerSecond ?? 5;
  const list = Array.isArray(opts.actions) ? opts.actions : [];
  const joinOnly = typeof opts.actions !== "function" && list.length === 0;
  const pick = typeof opts.actions === "function" ? opts.actions : (ctx: { n: number }) => list[ctx.n % list.length];
  const samples: number[] = [];
  const welcomeTimes: number[] = [];
  const joinTimes: number[] = [];
  const joinFailures: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  let sent = 0;

  const bots = Array.from({ length: opts.players }, (_, i) => {
    const started = now();
    const bot = { failure: null as string | null, joined: false };
    const client: RoomClient = connect(opts.url, {
      name: opts.name?.(i) ?? `bot${i + 1}`,
      reconnect: false,
      encoding: opts.encoding,
      WebSocket: opts.WebSocket,
    });
    const pending: number[] = [];
    client.on("state", (_s, ops?: unknown[]) => {
      if (ops && ops.length && pending.length) samples.push(now() - pending.shift()!);
    });
    client.on("error", (e: { code: string }) => {
      errorCodes[e.code] = (errorCodes[e.code] ?? 0) + 1;
      if (!bot.joined && !bot.failure) bot.failure = e.code;
    });
    client.on("welcome", () => welcomeTimes.push(now() - started));
    client.on("close", (e: { code: number }) => {
      if (!bot.joined && !bot.failure) bot.failure = `close_${e.code}`;
    });
    client.ready.then(
      () => {
        bot.joined = true;
        joinTimes.push(now() - started);
      },
      () => {},
    );
    return { i, client, pending, n: 0, bot };
  });

  const timeout = opts.joinTimeoutMs ?? 5_000;
  const joined = await Promise.all(bots.map((b) => raceTimeout(b.client.ready.then(() => true, () => false), timeout, false)));
  const live = bots.filter((_, k) => joined[k]);
  // Give close/error events for failed joins a moment to arrive, then count reasons.
  if (live.length < bots.length) await sleep(10);
  for (const [k, b] of bots.entries()) {
    if (joined[k]) continue;
    const reason = b.bot.failure ?? "timeout";
    joinFailures[reason] = (joinFailures[reason] ?? 0) + 1;
  }

  const start = now();
  const interval = 1000 / rate;
  await Promise.all(
    live.map(async (b) => {
      // Spread the bots over one interval so they do not all fire in lockstep.
      if (joinOnly) {
        await sleep(Math.max(0, opts.durationMs - (now() - start)));
        return;
      }
      await sleep((interval * b.i) / Math.max(1, live.length));
      while (now() - start < opts.durationMs) {
        const a = pick({ player: b.i, n: b.n++ });
        b.pending.push(now());
        b.client.send(a.type, a.data ?? {});
        sent++;
        await sleep(interval);
      }
    }),
  );
  const drainUntil = now() + (opts.drainMs ?? 500);
  while (now() < drainUntil && live.some((b) => b.pending.length)) await sleep(10);
  for (const b of bots) b.client.close();

  const errors = Object.values(errorCodes).reduce((a, b) => a + b, 0);
  return { players: opts.players, joined: live.length, durationMs: opts.durationMs, sent, samples: samples.length, errors, errorCodes, latency: summarize(samples), welcomeLatency: summarize(welcomeTimes), joinLatency: summarize(joinTimes), joinFailures };
}
