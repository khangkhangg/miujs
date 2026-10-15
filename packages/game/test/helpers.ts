import { definePlugin } from "miujs";

/** Test-only auth: `x-test-user: <id>` (optionally `<id>:<name>`) signs you in. */
export function testAuth() {
  return definePlugin({
    name: "test-auth",
    onRequest(ctx) {
      const h = ctx.headers.get("x-test-user");
      if (h) {
        const [id, name] = h.split(":");
        ctx.user = { id, name: name ?? id, roles: [] };
      }
    },
  });
}

export const as = (user: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), "x-test-user": user, "content-type": "application/json" },
});

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface FakeSocket {
  id: string;
  data: unknown;
  frames: any[];
  closed: { code?: number; reason?: string } | null;
  send(m: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  last(t?: string): any;
  events(name?: string): any[];
}

let sockN = 0;
export function fakeSocket(): FakeSocket {
  const s: FakeSocket = {
    id: `fs_${++sockN}`,
    data: undefined,
    frames: [],
    closed: null,
    send(m) {
      s.frames.push(JSON.parse(String(m)));
    },
    close(code, reason) {
      s.closed = { code, reason };
    },
    last(t) {
      for (let i = s.frames.length - 1; i >= 0; i--) if (!t || s.frames[i].t === t) return s.frames[i];
      return undefined;
    },
    events(name) {
      return s.frames.filter((f) => f.t === "event" && (!name || f.event === name));
    },
  };
  return s;
}

/** Let pending promise chains settle (fake-clock tests). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
