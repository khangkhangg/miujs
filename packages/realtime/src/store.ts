// A framework-agnostic external store over the room client: what the React, Vue and Svelte
// bindings share. It connects on the first subscriber, publishes a new immutable snapshot on every
// change, and closes the connection once nobody is subscribed (after a microtask, so React
// StrictMode's unsubscribe/resubscribe keeps one connection).

import { connect, type ConnectOptions, type ErrorFrame, type Me, type RoomClient } from "./client.ts";

export type RoomStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface RoomView<S = any> {
  /** Latest server state (or your `view` of it); undefined until the first `state` frame. */
  readonly state: S | undefined;
  readonly me: Me | null;
  readonly connected: boolean;
  readonly status: RoomStatus;
  /** Last `error` frame from the server, if any. */
  readonly error: ErrorFrame | null;
}

export interface RoomStore<S = any> {
  subscribe(onChange: () => void): () => void;
  /** The current snapshot; the same object until something changes. */
  getSnapshot(): RoomView<S>;
  send(type: string, data?: unknown): void;
  /** Leave the room now. */
  close(): void;
  /** The underlying client while connected. */
  readonly client: RoomClient<S> | null;
}

export function createRoomStore<S = any>(url: string, opts: ConnectOptions = {}): RoomStore<S> {
  let snap: RoomView<S> = { state: undefined, me: null, connected: false, status: "idle", error: null };
  const subs = new Set<() => void>();
  let client: RoomClient<S> | null = null;
  let offs: (() => void)[] = [];
  const pending: [string, unknown][] = [];

  const set = (patch: Partial<RoomView<S>>) => {
    snap = { ...snap, ...patch, connected: client?.connected ?? false };
    for (const fn of [...subs]) fn();
  };

  const start = () => {
    const c = connect<S>(url, opts);
    client = c;
    offs = [
      c.on("welcome", () => set({ me: c.me, status: "open" })),
      // The client patches its state in place: snapshot a copy so old views stay immutable.
      c.on("state", (s) => set({ state: s === undefined ? undefined : structuredClone(s), status: "open" })),
      c.on("error", (e) => set({ error: e })),
      c.on("reconnecting", () => set({ status: "reconnecting" })),
      c.on("close", (e: { willReconnect: boolean }) => set({ status: e.willReconnect ? "reconnecting" : "closed" })),
    ];
    for (const [type, data] of pending.splice(0)) c.send(type, data);
    set({ status: "connecting" });
  };

  const stop = () => {
    for (const off of offs) off();
    offs = [];
    const c = client;
    client = null;
    c?.close();
    snap = { ...snap, connected: false, status: "closed" };
  };

  return {
    subscribe(onChange) {
      subs.add(onChange);
      if (!client) start();
      return () => {
        subs.delete(onChange);
        queueMicrotask(() => {
          if (subs.size === 0 && client) stop();
        });
      };
    },
    getSnapshot: () => snap,
    send(type, data = {}) {
      if (client) client.send(type, data);
      else pending.push([type, data]);
    },
    close: stop,
    get client() {
      return client;
    },
  };
}
