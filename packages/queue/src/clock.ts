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

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
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
