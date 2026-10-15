import { describe, expect, test } from "bun:test";
import { PHP_CLASS, phpSerialize, phpUnserialize } from "../src/php.ts";

// Expected strings are what PHP 8's serialize() prints for the same values (see php.net/serialize).
describe("phpUnserialize", () => {
  test("scalars", () => {
    expect(phpUnserialize("N;")).toBe(null);
    expect(phpUnserialize("b:1;")).toBe(true);
    expect(phpUnserialize("b:0;")).toBe(false);
    expect(phpUnserialize("i:42;")).toBe(42);
    expect(phpUnserialize("i:-7;")).toBe(-7);
    expect(phpUnserialize("d:1.5;")).toBe(1.5);
    expect(phpUnserialize("d:1.0E+25;")).toBe(1e25);
    expect(phpUnserialize("d:INF;")).toBe(Infinity);
    expect(phpUnserialize("d:-INF;")).toBe(-Infinity);
    expect(Number.isNaN(phpUnserialize("d:NAN;"))).toBe(true);
    expect(phpUnserialize('s:5:"hello";')).toBe("hello");
  });

  test("string lengths are bytes, not characters", () => {
    expect(phpUnserialize('s:6:"héllo";')).toBe("héllo");
    expect(phpUnserialize('s:4:"a";b";')).toBe('a";b');
  });

  test("a list becomes an array, a map becomes an object", () => {
    expect(phpUnserialize('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')).toEqual(["a", "b"]);
    expect(phpUnserialize('a:2:{s:3:"foo";i:1;i:5;b:1;}')).toEqual({ foo: 1, 5: true });
    expect(phpUnserialize("a:0:{}")).toEqual([]);
  });

  test("a Laravel session payload", () => {
    const payload =
      'a:3:{s:6:"_token";s:40:"Xb4cqf5fz1a2fT0Hr7m9Bq2vLx8Kp3Ws6Ye1Ud0N";s:9:"_previous";a:1:{s:3:"url";s:22:"http://localhost/login";}s:50:"login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d";i:7;}';
    const data = phpUnserialize(payload) as Record<string, unknown>;
    expect(data._token).toBe("Xb4cqf5fz1a2fT0Hr7m9Bq2vLx8Kp3Ws6Ye1Ud0N");
    expect(data._previous).toEqual({ url: "http://localhost/login" });
    expect(data.login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d).toBe(7);
  });

  test("stdClass objects become tagged plain objects", () => {
    const v = phpUnserialize('O:8:"stdClass":2:{s:1:"a";i:1;s:1:"b";a:0:{}}') as Record<string | symbol, unknown>;
    expect(v).toEqual({ a: 1, b: [] });
    expect(v[PHP_CLASS]).toBe("stdClass");
  });

  test("a __proto__ key stays data", () => {
    const v = phpUnserialize('a:1:{s:9:"__proto__";a:1:{s:5:"admin";b:1;}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.hasOwn(v, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  describe("refuses", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return "no error";
    };
    test("class objects (gadget chains)", () => {
      expect(code(() => phpUnserialize('O:29:"Illuminate\\Support\\MessageBag":0:{}'))).toBe("MIU_E_MIGRATE_PHP_CLASS");
      expect(code(() => phpUnserialize('a:1:{s:1:"x";O:3:"Foo":0:{}}'))).toBe("MIU_E_MIGRATE_PHP_CLASS");
    });
    test("custom-serialized objects, enums and references", () => {
      expect(code(() => phpUnserialize('C:3:"Foo":0:{}'))).toBe("MIU_E_MIGRATE_PHP_CLASS");
      expect(code(() => phpUnserialize('E:7:"Foo:Bar";'))).toBe("MIU_E_MIGRATE_PHP_CLASS");
      expect(code(() => phpUnserialize('a:2:{i:0;a:0:{}i:1;r:2;}'))).toBe("MIU_E_MIGRATE_PHP_UNSERIALIZE");
      expect(code(() => phpUnserialize('a:2:{i:0;a:0:{}i:1;R:2;}'))).toBe("MIU_E_MIGRATE_PHP_UNSERIALIZE");
    });
    test("malformed input", () => {
      for (const bad of ["", "x", "i:;", "i:1", "s:10:\"short\";", 's:1:"ab";', "a:2:{i:0;i:1;}", "a:1:{i:0;i:1;", "b:2;", "i:1;i:2;", "d:abc;", "a:-1:{}", "a:1:{a:0:{}i:1;}", "s:-1:\"\";"]) {
        expect(code(() => phpUnserialize(bad))).toBe("MIU_E_MIGRATE_PHP_UNSERIALIZE");
      }
    });
    test("absurd counts and deep nesting", () => {
      expect(code(() => phpUnserialize("a:99999999:{}"))).toBe("MIU_E_MIGRATE_PHP_UNSERIALIZE");
      // Refused up front from the count, before reading any element.
      expect(() => phpUnserialize("a:99999999:{}")).toThrow(/bad element count/);
      expect(code(() => phpUnserialize("a:1:{i:0;".repeat(200) + "N;" + "}".repeat(200)))).toBe("MIU_E_MIGRATE_PHP_UNSERIALIZE");
    });
  });

  test("inert mode keeps class objects as data, never instantiates", () => {
    const v = phpUnserialize('O:3:"Foo":1:{s:1:"x";i:1;}', { classes: "inert" }) as Record<string | symbol, unknown>;
    expect(v).toEqual({ x: 1 });
    expect(v[PHP_CLASS]).toBe("Foo");
    expect(phpSerialize(v)).toBe('O:3:"Foo":1:{s:1:"x";i:1;}');
  });
});

describe("phpSerialize", () => {
  test("scalars", () => {
    expect(phpSerialize(null)).toBe("N;");
    expect(phpSerialize(undefined)).toBe("N;");
    expect(phpSerialize(true)).toBe("b:1;");
    expect(phpSerialize(false)).toBe("b:0;");
    expect(phpSerialize(42)).toBe("i:42;");
    expect(phpSerialize(1.5)).toBe("d:1.5;");
    expect(phpSerialize(1e25)).toBe("d:1.0E+25;");
    expect(phpSerialize(Infinity)).toBe("d:INF;");
    expect(phpSerialize(-Infinity)).toBe("d:-INF;");
    expect(phpSerialize(NaN)).toBe("d:NAN;");
    expect(phpSerialize("héllo")).toBe('s:6:"héllo";');
  });

  test("arrays and maps", () => {
    expect(phpSerialize(["a", "b"])).toBe('a:2:{i:0;s:1:"a";i:1;s:1:"b";}');
    expect(phpSerialize({ foo: 1, 5: true })).toBe('a:2:{i:5;b:1;s:3:"foo";i:1;}');
    expect(phpSerialize({ "05": 1, "-3": 2 })).toBe('a:2:{s:2:"05";i:1;i:-3;i:2;}');
    expect(phpSerialize({ a: { [PHP_CLASS]: "stdClass", b: 1 } })).toBe('a:1:{s:1:"a";O:8:"stdClass":1:{s:1:"b";i:1;}}');
  });

  test("round-trips", () => {
    const value = { _token: "abc", _flash: { old: [], new: [] }, login_web_x: 7, ratio: 0.25, nested: [1, [2, { k: "v" }]], none: null };
    expect(phpUnserialize(phpSerialize(value))).toEqual(value);
  });

  test("refuses functions and symbols", () => {
    expect(() => phpSerialize({ f: () => 1 })).toThrow();
    expect(() => phpSerialize(Symbol("x"))).toThrow();
  });
});
