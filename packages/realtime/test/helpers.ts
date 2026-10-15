import type { MiuSocket } from "miujs";

export interface FakeSocket extends MiuSocket {
  frames: any[];
  closed: { code?: number; reason?: string } | null;
  /** Frames received since the last call. */
  take(): any[];
  last(t?: string): any;
}

let n = 0;
export function fakeSocket(): FakeSocket {
  let cursor = 0;
  const s: FakeSocket = {
    id: `fake_${++n}`,
    data: undefined,
    frames: [],
    closed: null,
    send(m) {
      s.frames.push(JSON.parse(String(m)));
    },
    close(code, reason) {
      s.closed = { code, reason };
    },
    take() {
      const out = s.frames.slice(cursor);
      cursor = s.frames.length;
      return out;
    },
    last(t) {
      for (let i = s.frames.length - 1; i >= 0; i--) if (!t || s.frames[i].t === t) return s.frames[i];
      return undefined;
    },
  };
  return s;
}
