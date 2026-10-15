// Game-loop helpers for action games.
//
// Server: `fixedStep` (tick loops), `acceptInput` / `processInputs` / `ackedSeqs` (ordered inputs
// with acks). Client helpers (`snapshotInterpolation`, `lerpState`, `predictor`) live in
// ./client.ts (import "@miujs/game/client" in browsers) and are re-exported here.
//
// Durable Objects: a tick loop must not use closures (`room.after` / `room.tick`), because a
// hibernated object forgets them. `fixedStep.define(name, { hz, update })` re-arms itself with
// `room.schedule(name, ...)` each step; spread its `.timers` into `defineRoom({ timers })`.
// The step counter travels in the timer data, so it survives hibernation. A late alarm catches
// up at most `maxCatchUp` steps and then skips ahead on the same cadence.

import type { Room } from "@miujs/realtime";
import { gameErrors } from "./errors.ts";

// ---- fixedStep -------------------------------------------------------------------------------------

export interface StepContext<R extends Room = Room> {
  room: R;
  /** Fixed step length in ms (1000 / hz). */
  dt: number;
  /** Step number, starting at 1. */
  tick: number;
  /** The step's scheduled time (deterministic; not the wall clock of the late alarm). */
  now: number;
}

/** Return `false` to stop the loop. */
export type StepFn<R extends Room = Room> = (ctx: StepContext<R>) => void | boolean;

export interface FixedStepOptions<R extends Room = Room> {
  hz: number;
  update: StepFn<R>;
  /** Most steps one wake-up may run to catch up. Default 5 (raised to `stepsPerAlarm` if lower). */
  maxCatchUp?: number;
  /**
   * Run this many steps per alarm (default 1). With N, the room wakes every N steps and runs the N
   * due steps back to back (each still gets its own fixed `dt` and scheduled `now`): N times
   * fewer Durable Object alarms, at the cost of up to (N-1) steps of extra latency per update.
   */
  stepsPerAlarm?: number;
}

interface StepData {
  tick: number;
  at: number;
  step: number;
}

const RAW = Symbol.for("miujs.game.rawRoom");
const keyOf = (room: Room): object => ((room as any)[RAW] as object | undefined) ?? room;

function checkHz(hz: number): number {
  if (!(Number.isFinite(hz) && hz > 0 && hz <= 120)) {
    throw gameErrors.roomConfig(`fixedStep: hz must be between 0 and 120 (got ${hz})`, "Use e.g. hz: 20 for a server simulation; render smoothly on clients with snapshotInterpolation().");
  }
  return 1000 / hz;
}

/** Advance `at` past `now` on the same cadence. */
function skipAhead(at: number, now: number, step: number): number {
  return at <= now ? at + (Math.floor((now - at) / step) + 1) * step : at;
}

function defineStep<R extends Room = Room>(name: string, opts: FixedStepOptions<R>) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw gameErrors.roomConfig(`fixedStep.define: bad timer name "${name}"`, 'Use letters, digits, _ . or -, e.g. fixedStep.define("physics", ...).');
  const step = checkHz(opts.hz);
  const batch = opts.stepsPerAlarm ?? 1;
  if (!Number.isInteger(batch) || batch < 1) {
    throw gameErrors.roomConfig(`fixedStep.define("${name}"): stepsPerAlarm must be a positive integer (got ${batch})`, "e.g. stepsPerAlarm: 4 runs 4 steps per alarm.");
  }
  const maxCatchUp = Math.max(opts.maxCatchUp ?? 5, batch);
  const running = new WeakMap<object, string>();

  /** `at` is the next step's time; the alarm fires when the whole batch is due. */
  const arm = (room: Room, tick: number, at: number) => {
    const data: StepData = { tick, at, step };
    running.set(keyOf(room), room.schedule(name, Math.max(0, at + (batch - 1) * step - room.now()), data));
  };

  return {
    name,
    hz: opts.hz,
    /** Spread into `defineRoom({ timers: { ...loop.timers } })`. */
    timers: {
      [name]: ({ room, data, now }: { room: Room; data: StepData; now: number }) => {
        let { tick, at } = data;
        for (let n = 0; at <= now && n < maxCatchUp; n++) {
          tick++;
          if (opts.update({ room: room as R, dt: step, tick, now: at }) === false) {
            running.delete(keyOf(room));
            return;
          }
          at += step;
        }
        arm(room, tick, skipAhead(at, now, step));
      },
    },
    /** Start the loop (first step one interval from now). False if it already runs in this room. */
    start(room: Room): boolean {
      if (running.has(keyOf(room))) return false;
      arm(room, 0, room.now() + step);
      return true;
    },
    /**
     * Stop the loop. Works while the room object is alive; after Durable Object hibernation,
     * stop by returning `false` from `update` (e.g. when `room.state.phase !== "play"`).
     */
    stop(room: Room): boolean {
      const id = running.get(keyOf(room));
      if (!id) return false;
      running.delete(keyOf(room));
      return room.cancel(id);
    },
  };
}

/**
 * Run `update` `hz` times per second in a local room (closure-based; returns a stop function).
 * Throws MIU_E_GAME_LOOP_NOT_DURABLE on Durable Objects: use `fixedStep.define` there.
 */
function fixedStepFn<R extends Room>(room: R, hz: number, update: StepFn<R>, o: { maxCatchUp?: number } = {}): () => void {
  const step = checkHz(hz);
  const maxCatchUp = o.maxCatchUp ?? 5;
  let tick = 0;
  let at = room.now() + step;
  let stopped = false;
  let cancel: () => void = () => {};
  const run = () => {
    if (stopped) return;
    const now = room.now();
    for (let n = 0; at <= now && n < maxCatchUp; n++) {
      tick++;
      if (update({ room, dt: step, tick, now: at }) === false) {
        stopped = true;
        return;
      }
      at += step;
    }
    at = skipAhead(at, now, step);
    arm();
  };
  const arm = () => {
    cancel = room.after(Math.max(0, at - room.now()), run);
  };
  try {
    arm();
  } catch (err) {
    if ((err as { code?: string })?.code === "MIU_E_ROOM_TIMER_NOT_DURABLE") throw gameErrors.loopDurable();
    throw err;
  }
  return () => {
    stopped = true;
    cancel();
  };
}

export const fixedStep = Object.assign(fixedStepFn, { define: defineStep });

// ---- server: ordered inputs with acks ----------------------------------------------------------------

/** Plain JSON, so it can live in `room.secret` and survive hibernation. */
export interface InputState {
  max: number;
  players: Record<string, { last: number; pending: [number, unknown][] }>;
}

export type InputVerdict = "accepted" | "duplicate" | "stale" | "overflow" | "invalid";

export function createInputState(o: { maxBuffered?: number } = {}): InputState {
  return { max: o.maxBuffered ?? 64, players: {} };
}

/** Buffer one client input. `seq` must increase per player (1, 2, 3, ...); old or repeated seqs are dropped. */
export function acceptInput(st: InputState, playerId: string, seq: number, input: unknown): InputVerdict {
  if (!Number.isSafeInteger(seq) || seq < 0) return "invalid";
  const p = (st.players[playerId] ??= { last: 0, pending: [] });
  if (seq <= p.last) return "stale";
  if (p.pending.some(([s]) => s === seq)) return "duplicate";
  if (p.pending.length >= st.max) return "overflow";
  p.pending.push([seq, input]);
  p.pending.sort((a, b) => a[0] - b[0]);
  return "accepted";
}

/** Apply buffered inputs in seq order (players in join order). Returns how many ran. */
export function processInputs(st: InputState, apply: (playerId: string, input: unknown, seq: number) => void, o: { maxPerStep?: number } = {}): number {
  let n = 0;
  for (const [playerId, p] of Object.entries(st.players)) {
    const batch = p.pending.splice(0, o.maxPerStep ?? p.pending.length);
    for (const [seq, input] of batch) {
      apply(playerId, input, seq);
      p.last = seq;
      n++;
    }
  }
  return n;
}

/** Last processed seq per player: put it in state (e.g. `room.state.acks`) for reconciliation. */
export function ackedSeqs(st: InputState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, p] of Object.entries(st.players)) if (p.last > 0) out[id] = p.last;
  return out;
}

/** Forget a player's inputs (on leave). */
export function dropInputs(st: InputState, playerId: string): void {
  delete st.players[playerId];
}

export { lerpState, predictor, snapshotInterpolation, type Interpolator, type Predictor } from "./interp.ts";
