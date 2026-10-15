// Time source for rooms. Real rooms use the platform clock; tests inject a FakeClock and
// advance it by hand, so timers (question deadlines, reconnect grace, empty-room disposal)
// are deterministic.

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Let (or stop letting) a clock timer keep the process alive. Housekeeping timers (empty-room
 * disposal, reconnect grace) are unref'd so a script or a stopped server can exit; a no-op for
 * handles without ref/unref (FakeClock ids, Workers).
 */
export function setTimerRef(handle: unknown, keepAlive: boolean): void {
  const h = handle as { ref?: () => unknown; unref?: () => unknown } | null;
  if (h && typeof h === "object") (keepAlive ? h.ref : h.unref)?.call(h);
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** A manual clock: nothing happens until you call `advance(ms)`. */
export class FakeClock implements Clock {
  private t: number;
  private timers: FakeTimer[] = [];
  private seq = 0;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** Moves time forward, firing every timer that comes due (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: FakeTimer | undefined;
      for (const x of this.timers) if (x.at <= target && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = target;
  }

  /** Number of pending timers. */
  get pending(): number {
    return this.timers.length;
  }
}
