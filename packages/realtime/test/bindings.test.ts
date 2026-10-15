import { beforeEach, expect, test } from "bun:test";
import { useRoom as useReactRoom, createUseRoom } from "../src/react.ts";
import { createRoomStore } from "../src/store.ts";
import { roomStore } from "../src/svelte.ts";
import { useRoom as useVueRoom } from "../src/vue.ts";
import { FakeWS } from "./fakews.ts";

const URL_ = "ws://x/rooms/chat/1";
const tick = () => new Promise((r) => queueMicrotask(() => r(undefined)));

beforeEach(() => {
  FakeWS.all = [];
});

// ---- shared store --------------------------------------------------------------------------

test("createRoomStore connects on first subscribe, publishes immutable snapshots, closes after the last unsubscribe", async () => {
  const store = createRoomStore(URL_, { name: "Ann", WebSocket: FakeWS as any });
  expect(FakeWS.all.length).toBe(0); // lazy
  const s0 = store.getSnapshot();
  expect(s0).toMatchObject({ state: undefined, me: null, connected: false, status: "idle", error: null });
  let calls = 0;
  const off = store.subscribe(() => calls++);
  expect(FakeWS.all.length).toBe(1);
  expect(new URL(FakeWS.last().url).searchParams.get("name")).toBe("Ann");
  FakeWS.last().joined({ lines: [] });
  const s1 = store.getSnapshot();
  expect(s1).toMatchObject({ state: { lines: [] }, me: { name: "Ann" }, connected: true, status: "open" });
  expect(s1).not.toBe(s0);
  expect(store.getSnapshot()).toBe(s1); // stable between changes (useSyncExternalStore needs this)
  expect(calls).toBeGreaterThan(0);

  FakeWS.last().receive({ t: "patch", ops: [{ op: "replace", path: "/lines", value: ["hi"] }] });
  expect(store.getSnapshot().state).toEqual({ lines: ["hi"] });
  expect(s1.state).toEqual({ lines: [] }); // old snapshots are not mutated

  FakeWS.last().receive({ t: "error", code: "MIU_E_X", message: "no" });
  expect(store.getSnapshot().error).toMatchObject({ code: "MIU_E_X" });

  store.send("say", { text: "yo" });
  expect(JSON.parse(FakeWS.last().sent.at(-1) as string)).toEqual({ t: "msg", type: "say", data: { text: "yo" } });

  off();
  expect(FakeWS.last().readyState).toBe(1); // not yet: a re-subscribe in the same tick keeps it
  await tick();
  expect(FakeWS.last().readyState).toBe(3);
});

test("an unsubscribe immediately followed by a subscribe (React StrictMode) keeps one connection", async () => {
  const store = createRoomStore(URL_, { name: "Ann", WebSocket: FakeWS as any });
  store.subscribe(() => {})();
  store.subscribe(() => {});
  await tick();
  expect(FakeWS.all.length).toBe(1);
  expect(FakeWS.last().readyState).not.toBe(3);
});

// ---- React ---------------------------------------------------------------------------------

/** Just enough React: one component instance, hooks by call order. */
function fakeReact() {
  const memo: { deps: unknown[]; value: unknown }[] = [];
  let i = 0;
  const subs: (() => void)[] = [];
  const React = {
    useMemo<T>(fn: () => T, deps: unknown[]): T {
      const slot = memo[i++];
      if (slot && slot.deps.length === deps.length && slot.deps.every((d, k) => Object.is(d, deps[k]))) return slot.value as T;
      const value = fn();
      memo[i - 1] = { deps, value };
      return value;
    },
    useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T {
      if (!subs.length) subs.push(subscribe(() => {}));
      return getSnapshot();
    },
  };
  return {
    React,
    render<T>(hook: () => T): T {
      i = 0;
      return hook();
    },
    unmount() {
      for (const u of subs.splice(0)) u();
    },
  };
}

test("React useRoom is built on useSyncExternalStore and re-renders with new state", async () => {
  const r = fakeReact();
  const first = r.render(() => useReactRoom(URL_, { name: "Ann", WebSocket: FakeWS as any, react: r.React }));
  expect(first.status).toBe("connecting");
  FakeWS.last().joined({ n: 1 });
  const second = r.render(() => useReactRoom(URL_, { name: "Ann", WebSocket: FakeWS as any, react: r.React }));
  expect(second.state).toEqual({ n: 1 });
  expect(second.connected).toBe(true);
  second.send("go", {});
  expect(FakeWS.last().sent.length).toBe(1);
  expect(FakeWS.all.length).toBe(1); // same store across renders
  r.unmount();
  await tick();
  expect(FakeWS.last().readyState).toBe(3);
});

test("createUseRoom(React) binds React once", () => {
  const r = fakeReact();
  const useRoom = createUseRoom(r.React);
  const v = r.render(() => useRoom(URL_, { name: "Ann", WebSocket: FakeWS as any }));
  expect(v.status).toBe("connecting");
});

test("React useRoom without a React gives a clear MiuError", () => {
  expect(() => useReactRoom(URL_, { name: "Ann" } as any)).toThrow(expect.objectContaining({ code: "MIU_E_ROOM_REACT_MISSING" }));
});

// ---- Vue -----------------------------------------------------------------------------------

test("Vue useRoom returns refs from the injected shallowRef and closes on scope dispose", async () => {
  const shallowRef = <T>(value: T) => ({ value });
  let dispose: (() => void) | null = null;
  const room = useVueRoom(URL_, { name: "Ann", WebSocket: FakeWS as any, shallowRef, onScopeDispose: (fn) => (dispose = fn) });
  expect(room.state.value).toBeUndefined();
  FakeWS.last().joined({ n: 2 });
  expect(room.state.value).toEqual({ n: 2 });
  expect(room.me.value).toMatchObject({ name: "Ann" });
  expect(room.connected.value).toBe(true);
  expect(room.status.value).toBe("open");
  room.send("x", {});
  expect(FakeWS.last().sent.length).toBe(1);
  dispose!();
  await tick();
  expect(FakeWS.last().readyState).toBe(3);
});

// ---- Svelte --------------------------------------------------------------------------------

test("Svelte roomStore follows the readable store contract", async () => {
  const store = roomStore(URL_, { name: "Ann", WebSocket: FakeWS as any });
  const seen: any[] = [];
  const unsub = store.subscribe((v) => seen.push(v));
  expect(seen.length).toBe(1); // called synchronously with the current value
  expect(seen[0].status).toBe("connecting");
  FakeWS.last().joined({ n: 3 });
  expect(seen.at(-1).state).toEqual({ n: 3 });
  store.send("x", {});
  expect(FakeWS.last().sent.length).toBe(1);
  unsub();
  await tick();
  expect(FakeWS.last().readyState).toBe(3);
});
