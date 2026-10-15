import { expect, test } from "bun:test";
import { decode, encode } from "../src/msgpack.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const bytes = (s: string) => new Uint8Array(s.split(" ").filter(Boolean).map((x) => parseInt(x, 16)));

// Byte vectors from the MessagePack spec (https://github.com/msgpack/msgpack/blob/master/spec.md).
const vectors: [unknown, string][] = [
  [null, "c0"],
  [false, "c2"],
  [true, "c3"],
  [0, "00"],
  [127, "7f"],
  [128, "cc 80"],
  [255, "cc ff"],
  [256, "cd 01 00"],
  [65535, "cd ff ff"],
  [65536, "ce 00 01 00 00"],
  [4294967295, "ce ff ff ff ff"],
  [4294967296, "cf 00 00 00 01 00 00 00 00"],
  [-1, "ff"],
  [-32, "e0"],
  [-33, "d0 df"],
  [-128, "d0 80"],
  [-129, "d1 ff 7f"],
  [-32768, "d1 80 00"],
  [-32769, "d2 ff ff 7f ff"],
  [-2147483649, "d3 ff ff ff ff 7f ff ff ff"],
  [1.5, "cb 3f f8 00 00 00 00 00 00"],
  [-0.25, "cb bf d0 00 00 00 00 00 00"],
  ["", "a0"],
  ["a", "a1 61"],
  ["é", "a2 c3 a9"],
  [[], "90"],
  [[1, 2], "92 01 02"],
  [{}, "80"],
  [{ a: 1 }, "81 a1 61 01"],
  [{ t: "ping" }, "81 a1 74 a4 70 69 6e 67"],
  [new Uint8Array([1, 2]), "c4 02 01 02"],
];

for (const [value, expected] of vectors) {
  test(`encode ${JSON.stringify(value instanceof Uint8Array ? [...value] : value)} → ${expected}`, () => {
    expect(hex(encode(value))).toBe(expected);
    expect(decode(bytes(expected))).toEqual(value as any);
  });
}

test("lengths switch to str8/str16, array16 and map16 at the spec boundaries", () => {
  expect(hex(encode("x".repeat(31))).slice(0, 2)).toBe("bf");
  expect(hex(encode("x".repeat(32))).slice(0, 5)).toBe("d9 20");
  expect(hex(encode("x".repeat(256))).slice(0, 8)).toBe("da 01 00");
  expect(hex(encode("x".repeat(65536))).slice(0, 14)).toBe("db 00 01 00 00");
  expect(hex(encode(new Array(15).fill(0))).slice(0, 2)).toBe("9f");
  expect(hex(encode(new Array(16).fill(0))).slice(0, 8)).toBe("dc 00 10");
  const m16: Record<string, number> = {};
  for (let i = 0; i < 16; i++) m16[`k${i}`] = i;
  expect(hex(encode(m16)).slice(0, 8)).toBe("de 00 10");
  expect(decode(encode(m16))).toEqual(m16);
  expect(decode(encode("x".repeat(65536)))).toBe("x".repeat(65536));
});

test("decodes formats the encoder never emits: float32, int64, uint64, int8 positives, bin16", () => {
  expect(decode(bytes("ca 3f c0 00 00"))).toBe(1.5);
  expect(decode(bytes("d3 ff ff ff ff ff ff ff ff"))).toBe(-1);
  expect(decode(bytes("cf 00 00 00 00 00 00 00 05"))).toBe(5);
  expect(decode(bytes("d0 05"))).toBe(5);
  expect(decode(bytes("c5 00 01 07"))).toEqual(new Uint8Array([7]));
});

test("undefined object fields are dropped like JSON; undefined alone is nil", () => {
  expect(hex(encode({ a: undefined, b: 1 }))).toBe("81 a1 62 01");
  expect(hex(encode(undefined))).toBe("c0");
});

test("a nested protocol frame round-trips", () => {
  const f = { t: "patch", ops: [{ op: "replace", path: "/players/p_1/score", value: 1234.5 }, { op: "remove", path: "/x" }] };
  expect(decode(encode(f))).toEqual(f);
});

test("decode accepts an ArrayBuffer", () => {
  expect(decode(encode({ a: [1, "b"] }).buffer as ArrayBuffer)).toEqual({ a: [1, "b"] });
});

test("malformed input throws: truncated data, the never-used byte 0xc1, trailing bytes", () => {
  expect(() => decode(bytes("a3 61 62"))).toThrow();
  expect(() => decode(bytes("cd 01"))).toThrow();
  expect(() => decode(bytes("c1"))).toThrow();
  expect(() => decode(bytes("01 02"))).toThrow();
  expect(() => decode(new Uint8Array())).toThrow();
});

test("values msgpack cannot carry are refused", () => {
  expect(() => encode(() => 1)).toThrow();
  expect(() => encode(Symbol("x"))).toThrow();
});
