// React binding. No dependency on React: pass your React (structural type) once.
//
//   import * as React from "react";
//   import { createUseRoom } from "@miujs/realtime/react";
//   export const useRoom = createUseRoom(React);
//   const { state, me, status, send } = useRoom("wss://example.com/rooms/quiz/r1a2", { name: "Ann" });

import type { ConnectOptions } from "./client.ts";
import { createRoomStore, type RoomStore, type RoomView } from "./store.ts";

/** The parts of React this hook uses. */
export interface ReactLike {
  useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
}

export interface UseRoomOptions extends ConnectOptions {
  /** Your React (`import * as React from "react"`), unless you use `createUseRoom(React)`. */
  react?: ReactLike;
}

export interface UseRoomResult<S> extends RoomView<S> {
  send(type: string, data?: unknown): void;
  store: RoomStore<S>;
}

/** Bind React once and get a `useRoom(url, opts)` hook. */
export function createUseRoom(react: ReactLike) {
  return function useRoom<S = any>(url: string, opts: ConnectOptions = {}): UseRoomResult<S> {
    // One store per room URL and identity; it connects on subscribe and closes on unmount.
    const store = react.useMemo(() => createRoomStore<S>(url, opts), [url, opts.name, opts.role, opts.encoding, opts.resume, opts.hostKey]);
    const view = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return { ...view, send: store.send, store };
  };
}

/** `useRoom(url, { name, react: React })`: join a room and re-render on every state change. */
export function useRoom<S = any>(url: string, opts: UseRoomOptions): UseRoomResult<S> {
  if (!opts?.react) {
    // A plain Error with MiuError-style code/fix: browser modules must not import the server core.
    throw Object.assign(new Error("useRoom() needs your React"), {
      code: "MIU_E_ROOM_REACT_MISSING",
      fix: 'Pass it: useRoom(url, { name, react: React }), or bind once: const useRoom = createUseRoom(React) (import * as React from "react").',
    });
  }
  return createUseRoom(opts.react)<S>(url, opts);
}
