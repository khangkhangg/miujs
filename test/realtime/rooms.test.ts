import { describe, expect, test } from "bun:test";
import { createRoomHub } from "../../src/realtime/rooms.ts";

function fakeSocket(id: string) {
  const sent: string[] = [];
  const closers: (() => void)[] = [];
  return {
    id,
    sent,
    send(d: string | ArrayBuffer | Uint8Array) {
      sent.push(String(d));
    },
    onClose(fn: () => void) {
      closers.push(fn);
      return () => closers.splice(closers.indexOf(fn), 1);
    },
    fireClose() {
      for (const f of [...closers]) f();
    },
  };
}

describe("createRoomHub", () => {
  test("join, members with meta, leave", () => {
    const hub = createRoomHub<{ name: string }>();
    const a = fakeSocket("a");
    const b = fakeSocket("b");
    hub.join("lobby", a, { name: "Ann" });
    hub.join("lobby", b, { name: "Bob" });
    expect(hub.members("lobby")).toEqual([
      { id: "a", meta: { name: "Ann" } },
      { id: "b", meta: { name: "Bob" } },
    ]);
    expect(hub.size("lobby")).toBe(2);
    expect(hub.has("lobby", a)).toBe(true);
    hub.leave("lobby", a);
    expect(hub.members("lobby").map((m) => m.id)).toEqual(["b"]);
    expect(hub.rooms()).toEqual(["lobby"]);
  });

  test("broadcast serializes objects and honours except", () => {
    const hub = createRoomHub();
    const a = fakeSocket("a");
    const b = fakeSocket("b");
    const c = fakeSocket("c");
    for (const s of [a, b, c]) hub.join("r", s);
    expect(hub.broadcast("r", { hi: 1 }, { except: a })).toBe(2);
    hub.broadcast("r", "raw", { except: [a, "b"] });
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual(['{"hi":1}']);
    expect(c.sent).toEqual(['{"hi":1}', "raw"]);
  });

  test("a socket that throws on send does not stop the broadcast", () => {
    const hub = createRoomHub();
    const bad = { id: "bad", send() { throw new Error("closed"); } };
    const ok = fakeSocket("ok");
    hub.join("r", bad);
    hub.join("r", ok);
    expect(hub.broadcast("r", "x")).toBe(1);
    expect(ok.sent).toEqual(["x"]);
  });

  test("onEmpty fires and the room is removed when the last member leaves", () => {
    const emptied: string[] = [];
    const hub = createRoomHub({ onEmpty: (room) => emptied.push(room) });
    const a = fakeSocket("a");
    hub.join("r", a);
    hub.leave("r", a);
    expect(emptied).toEqual(["r"]);
    expect(hub.rooms()).toEqual([]);
    expect(hub.members("r")).toEqual([]);
  });

  test("closing a socket leaves every room automatically", () => {
    const events: string[] = [];
    const hub = createRoomHub({
      onJoin: (room, m) => events.push(`join:${room}:${m.id}`),
      onLeave: (room, m) => events.push(`leave:${room}:${m.id}`),
    });
    const a = fakeSocket("a");
    hub.join("x", a);
    hub.join("y", a);
    a.fireClose();
    expect(hub.rooms()).toEqual([]);
    expect(events).toEqual(["join:x:a", "join:y:a", "leave:x:a", "leave:y:a"]);
  });

  test("re-joining updates meta without duplicating", () => {
    const hub = createRoomHub<{ ready: boolean }>();
    const a = fakeSocket("a");
    hub.join("r", a, { ready: false });
    hub.join("r", a, { ready: true });
    expect(hub.members("r")).toEqual([{ id: "a", meta: { ready: true } }]);
  });

  test("sockets without ids get generated ids", () => {
    const hub = createRoomHub();
    hub.join("r", { send() {} });
    expect(typeof hub.members("r")[0]!.id).toBe("string");
  });
});
