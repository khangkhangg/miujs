import { expect, test } from "bun:test";
import { FakeClock, createRoomInstance, defineRoom, joinParamsFrom, t } from "../src/index.ts";
import { decode, encode } from "../src/msgpack.ts";
import { fakeSocket } from "./helpers.ts";

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  client: { say: t.object({ text: t.string() }) },
  init: () => ({ lines: [] }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`];
      room.broadcast("said", { by: sender.name });
    },
  },
});

function setup() {
  return createRoomInstance(chat, { id: "M", clock: new FakeClock() });
}

test("?enc=msgpack is read from the query", () => {
  expect(joinParamsFrom({ name: "Ann", enc: "msgpack" }).enc).toBe("msgpack");
});

test("a msgpack connection gets every frame as binary MessagePack", () => {
  const inst = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann", enc: "msgpack" });
  expect(a.raw.every((r) => r instanceof Uint8Array)).toBe(true);
  expect(a.frames.map((f) => f.t)).toEqual(["welcome", "state"]);
  expect(a.last("state").state).toEqual({ lines: [] });
});

test("binary msgpack client frames run handlers; JSON and msgpack clients share one room", () => {
  const inst = setup();
  const bin = fakeSocket();
  const txt = fakeSocket();
  inst.connect(bin, { name: "Bin", enc: "msgpack" });
  inst.connect(txt, { name: "Txt" });
  bin.take();
  txt.take();
  inst.receive(bin, encode({ t: "msg", type: "say", data: { text: "hi" } }));
  const expected = [
    { t: "patch", ops: [{ op: "replace", path: "/lines", value: ["Bin: hi"] }] },
    { t: "event", event: "said", data: { by: "Bin" } },
  ];
  expect(bin.take()).toEqual(expected);
  expect(txt.take()).toEqual(expected);
  expect(bin.raw.at(-1)).toBeInstanceOf(Uint8Array);
  expect(typeof txt.raw.at(-1)).toBe("string");
  inst.receive(bin, encode({ t: "ping" }).buffer as ArrayBuffer);
  expect(bin.last()).toEqual({ t: "pong" });
});

test("malformed MessagePack is a BAD_FRAME error, sent back in MessagePack", () => {
  const inst = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann", enc: "msgpack" });
  inst.receive(a, new Uint8Array([0xc1]));
  expect(a.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_BAD_FRAME" });
  expect(decode(a.raw.at(-1) as Uint8Array)).toMatchObject({ code: "MIU_E_ROOM_BAD_FRAME" });
});

test("binary frames on a JSON connection point to ?enc=msgpack", () => {
  const inst = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann" });
  inst.receive(a, encode({ t: "ping" }));
  expect(a.last().code).toBe("MIU_E_ROOM_BAD_FRAME");
  expect(a.last().fix).toContain("enc=msgpack");
});

test("an unknown encoding is refused and the socket closed with 1003", () => {
  const inst = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann", enc: "cbor" });
  expect(a.last()).toMatchObject({ t: "error", code: "MIU_E_ROOM_ENCODING_UNSUPPORTED" });
  expect(a.last().fix).toContain("msgpack");
  expect(a.closed?.code).toBe(1003);
  expect(inst.room.players).toEqual([]);
});

test("attach() keeps a re-attached socket's encoding", () => {
  const inst = setup();
  const a = fakeSocket();
  inst.connect(a, { name: "Ann", enc: "msgpack" });
  const snap = JSON.parse(JSON.stringify(inst.snapshot()));
  const woken = createRoomInstance(chat, { id: "M", clock: new FakeClock(), restore: snap });
  const again = fakeSocket();
  woken.attach(again, a.last("welcome").me.id, "msgpack");
  woken.receive(again, encode({ t: "msg", type: "say", data: { text: "back" } }));
  expect(again.raw.every((r) => r instanceof Uint8Array)).toBe(true);
  expect(again.frames[0]).toMatchObject({ t: "patch" });
});
