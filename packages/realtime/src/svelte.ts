// Svelte binding: a readable-store-compatible object (works with `$room` in components).
//
//   import { roomStore } from "@miujs/realtime/svelte";
//   const room = roomStore(url, { name: "Ann" });
//   // {$room.state?.phase}   <button on:click={() => room.send("start")}>

import type { ConnectOptions } from "./client.ts";
import { createRoomStore, type RoomStore, type RoomView } from "./store.ts";

export interface SvelteRoomStore<S> {
  /** Svelte store contract: `run` is called now and on every change; returns unsubscribe. */
  subscribe(run: (value: RoomView<S>) => void): () => void;
  send(type: string, data?: unknown): void;
  close(): void;
  store: RoomStore<S>;
}

export function roomStore<S = any>(url: string, opts: ConnectOptions = {}): SvelteRoomStore<S> {
  const store = createRoomStore<S>(url, opts);
  return {
    subscribe(run) {
      let ready = false; // the first run below delivers the initial value exactly once
      const off = store.subscribe(() => {
        if (ready) run(store.getSnapshot());
      });
      ready = true;
      run(store.getSnapshot());
      return off;
    },
    send: store.send,
    close: store.close,
    store,
  };
}
