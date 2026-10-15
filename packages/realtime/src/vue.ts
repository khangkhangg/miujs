// Vue binding. No dependency on Vue: pass `shallowRef` (and `onScopeDispose` to auto-close).
//
//   import { shallowRef, onScopeDispose } from "vue";
//   import { useRoom } from "@miujs/realtime/vue";
//   const { state, me, status, send } = useRoom(url, { name: "Ann", shallowRef, onScopeDispose });

import type { ConnectOptions } from "./client.ts";
import { createRoomStore, type RoomStatus, type RoomStore } from "./store.ts";
import type { ErrorFrame, Me } from "./client.ts";

/** A Vue ref, structurally. */
export interface RefLike<T> {
  value: T;
}

export interface UseVueRoomOptions extends ConnectOptions {
  /** Vue's `shallowRef` (or `ref`). State snapshots are replaced whole, so `shallowRef` is enough. */
  shallowRef: <T>(value: T) => RefLike<T>;
  /** Vue's `onScopeDispose`: leave the room when the component/scope goes away. */
  onScopeDispose?: (fn: () => void) => void;
}

export interface VueRoom<S> {
  state: RefLike<S | undefined>;
  me: RefLike<Me | null>;
  connected: RefLike<boolean>;
  status: RefLike<RoomStatus>;
  error: RefLike<ErrorFrame | null>;
  send(type: string, data?: unknown): void;
  close(): void;
  store: RoomStore<S>;
}

/** A composable: reactive refs that follow the room. */
export function useRoom<S = any>(url: string, opts: UseVueRoomOptions): VueRoom<S> {
  const store = createRoomStore<S>(url, opts);
  const s0 = store.getSnapshot();
  const room: VueRoom<S> = {
    state: opts.shallowRef(s0.state),
    me: opts.shallowRef(s0.me),
    connected: opts.shallowRef(s0.connected),
    status: opts.shallowRef(s0.status),
    error: opts.shallowRef(s0.error),
    send: store.send,
    close: () => off(),
    store,
  };
  const sync = () => {
    const s = store.getSnapshot();
    if (room.state.value !== s.state) room.state.value = s.state;
    if (room.me.value !== s.me) room.me.value = s.me;
    if (room.connected.value !== s.connected) room.connected.value = s.connected;
    if (room.status.value !== s.status) room.status.value = s.status;
    if (room.error.value !== s.error) room.error.value = s.error;
  };
  const off = store.subscribe(sync);
  sync();
  opts.onScopeDispose?.(off);
  return room;
}
