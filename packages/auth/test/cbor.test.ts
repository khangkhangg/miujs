import { describe, expect, test } from "bun:test";
import { decodeCbor, decodeCborPrefix } from "../src/cbor.ts";

const h = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));

describe("decodeCbor (RFC 8949 Appendix A vectors)", () => {
  const cases: [string, unknown][] = [
    ["00", 0],
    ["17", 23],
    ["1818", 24],
    ["1903e8", 1000],
    ["1a000f4240", 1000000],
    ["1b000000e8d4a51000", 1000000000000],
    ["20", -1],
    ["3863", -100],
    ["390100", -257],
    ["f4", false],
    ["f5", true],
    ["f6", null],
    ["f7", undefined],
    ["f93c00", 1],
    ["fa47c35000", 100000],
    ["fb3ff199999999999a", 1.1],
    ["60", ""],
    ["6449455446", "IETF"],
    ["62c3bc", "ü"],
    ["80", []],
    ["83010203", [1, 2, 3]],
    ["8301820203820405", [1, [2, 3], [4, 5]]],
  ];
  for (const [hex, want] of cases) {
    test(hex, () => expect(decodeCbor(h(hex)) as unknown).toEqual(want));
  }

  test("byte strings decode to Uint8Array", () => {
    expect(decodeCbor(h("4401020304"))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("maps decode to Map (COSE keys are integers)", () => {
    const m = decodeCbor(h("a201020304")) as Map<unknown, unknown>;
    expect(m).toBeInstanceOf(Map);
    expect(m.get(1)).toBe(2);
    expect(m.get(3)).toBe(4);
    const s = decodeCbor(h("a26161016162820203")) as Map<unknown, unknown>;
    expect(s.get("a")).toBe(1);
    expect(s.get("b")).toEqual([2, 3]);
  });

  test("tags are unwrapped", () => {
    expect(decodeCbor(h("c11a514b67b0"))).toBe(1363896240);
  });

  test("decodeCborPrefix reports how many bytes the first item used", () => {
    const { value, length } = decodeCborPrefix(h("a1010218ff00"));
    expect((value as Map<number, number>).get(1)).toBe(2);
    expect(length).toBe(3);
  });
});

describe("decodeCbor rejects malformed input", () => {
  const bad: [string, string][] = [
    ["truncated uint", "19 03"],
    ["truncated bytes", "44 0102"],
    ["truncated array", "83 0102"],
    ["trailing bytes", "00 00"],
    ["empty", ""],
    ["indefinite length", "9f 01 ff"],
    ["reserved additional info", "1c"],
    ["duplicate map key", "a2 01 02 01 03"],
    ["invalid utf-8", "62 c3 28"],
    ["length beyond input", "5b 00000000ffffffff"],
  ];
  for (const [name, hex] of bad) {
    test(name, () => expect(() => decodeCbor(h(hex.replace(/\s/g, "")))).toThrow());
  }

  test("deep nesting is refused", () => {
    expect(() => decodeCbor(new Uint8Array([...new Array(200).fill(0x81), 0x00]))).toThrow();
  });
});
