/**
 * Time source for the memory queue (retry backoff, delays, schedules). Swap in `manualClock()`
 * in tests so nothing waits for real seconds.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * Test clocks only: jump to `time` (ms), firing due timers. `drain()` uses it to skip
   * retry and delay waits.
   */
  advanceTo?(time: number): void;
}

/** Longest delay a JS timer holds; longer ones fire at once (Node, Bun, browsers). */
export const MAX_TIMER_MS = 2_147_483_647;

type Native = ReturnType<typeof setTimeout>;
/** A timer longer than MAX_TIMER_MS, re-armed in steps. */
interface LongTimer {
  t: Native;
  unrefd: boolean;
  unref(): void;
}

const isLong = (h: unknown): h is LongTimer => typeof h === "object" && h !== null && "unrefd" in h;

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    if (!(ms > MAX_TIMER_MS)) return setTimeout(fn, ms);
    const h = { unrefd: false } as LongTimer;
    const arm = (left: number) => {
      h.t = setTimeout(left > MAX_TIMER_MS ? () => arm(left - MAX_TIMER_MS) : fn, Math.min(left, MAX_TIMER_MS));
      if (h.unrefd) (h.t as { unref?: () => void }).unref?.();
    };
    h.unref = () => {
      h.unrefd = true;
      (h.t as { unref?: () => void }).unref?.();
    };
    arm(ms);
    return h;
  },
  clearTimeout: (h) => clearTimeout(isLong(h) ? h.t : (h as Native)),
};

export interface ManualClock extends Clock {
  advanceTo(time: number): void;
  /** Move forward `ms`, firing every timer that comes due, in order. */
  advance(ms: number): void;
  /** Number of timers waiting. */
  pending(): number;
}

/** A fake clock for tests. Time only moves when you call `advance`/`advanceTo`. */
export function manualClock(start = 0): ManualClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const advanceTo = (time: number) => {
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) if (entry[1].at <= time && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    now = Math.max(now, time);
  };

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    advanceTo,
    advance: (ms) => advanceTo(now + ms),
    pending: () => timers.size,
  };
}
