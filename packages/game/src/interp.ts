// Browser-safe game helpers (no imports): snapshot interpolation for remote entities and
// client-side prediction with server reconciliation for the local player.
//
//   import { snapshotInterpolation, predictor } from "@miujs/game/client";   (re-exported there)

// ---- client: interpolation ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/**
 * Blend two snapshots: numbers are interpolated (deeply, through objects and equal-length
 * arrays); everything else comes from `a`. Keys only in `b` (new entities) are taken from `b`.
 */
export function lerpState<T>(a: T, b: T, alpha: number, o: { angles?: string[] } = {}, key?: string): T {
  if (typeof a === "number" && typeof b === "number") return (key && o.angles?.includes(key) ? lerpAngle(a, b, alpha) : a + (b - a) * alpha) as T;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((x, i) => lerpState(x, b[i], alpha, o, key)) as T;
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) out[k] = k in b ? lerpState(a[k], b[k], alpha, o, k) : a[k];
    for (const k of Object.keys(b)) if (!(k in a)) out[k] = b[k];
    return out as T;
  }
  return a;
}

export interface Interpolator<T> {
  /** Add a snapshot taken at `time` (server ms). Older-than-newest snapshots are ignored. */
  push(time: number, state: T): void;
  /** State to render at `now` (same clock as `push`), i.e. at `now - delayMs`. Do not mutate it. */
  sample(now: number): T | undefined;
  readonly size: number;
}

/** Buffer server snapshots and render a little in the past, interpolating between two of them. */
export function snapshotInterpolation<T>(o: { delayMs?: number; maxSnapshots?: number; angles?: string[] } = {}): Interpolator<T> {
  const delay = o.delayMs ?? 100;
  const max = o.maxSnapshots ?? 32;
  const buf: { t: number; s: T }[] = [];
  return {
    push(time, state) {
      if (buf.length && time <= buf[buf.length - 1].t) return;
      buf.push({ t: time, s: state });
      while (buf.length > max) buf.shift();
    },
    sample(now) {
      if (!buf.length) return undefined;
      const target = now - delay;
      if (target <= buf[0].t) return buf[0].s;
      const last = buf[buf.length - 1];
      if (target >= last.t) return last.s;
      let i = buf.length - 2;
      while (i > 0 && buf[i].t > target) i--;
      const a = buf[i];
      const b = buf[i + 1];
      return lerpState(a.s, b.s, (target - a.t) / (b.t - a.t), o);
    },
    get size() {
      return buf.length;
    },
  };
}

// ---- client: prediction + reconciliation ---------------------------------------------------------------

export interface Predictor<S, I> {
  /** Apply an input locally now; send `{ seq, input }` to the server. */
  input(input: I): { seq: number; input: I };
  /** Server state that includes inputs up to `ackSeq`: replay the rest on top of it. */
  reconcile(serverState: S, ackSeq: number): S;
  readonly state: S;
  /** Inputs sent but not yet acknowledged. */
  readonly pending: number;
}

/** Client-side prediction for the local player. `apply` must be pure and match the server's. */
export function predictor<S, I>(o: { initial: S; apply: (state: S, input: I) => S }): Predictor<S, I> {
  let seq = 0;
  let state = o.initial;
  let pending: { seq: number; input: I }[] = [];
  return {
    input(input) {
      seq++;
      pending.push({ seq, input });
      state = o.apply(state, input);
      return { seq, input };
    },
    reconcile(serverState, ackSeq) {
      pending = pending.filter((p) => p.seq > ackSeq);
      state = pending.reduce((s, p) => o.apply(s, p.input), serverState);
      return state;
    },
    get state() {
      return state;
    },
    get pending() {
      return pending.length;
    },
  };
}
