import type { MiuSocket } from "miujs";
import { decode } from "../src/msgpack.ts";

export interface FakeSocket extends MiuSocket {
  frames: any[];
  /** What was sent, before decoding (string for JSON, Uint8Array for MessagePack). */
  raw: (string | Uint8Array)[];
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
    raw: [],
    closed: null,
    send(m) {
      const bin = typeof m === "string" ? null : m instanceof Uint8Array ? m : new Uint8Array(m);
      s.raw.push(bin ?? (m as string));
      s.frames.push(bin ? decode(bin) : JSON.parse(String(m)));
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
