// A safe subset of PHP's serialize()/unserialize(), enough for Laravel session payloads.
//
// Supported: N; b: i: d: s: a: and O:8:"stdClass". Class objects (O: other than stdClass),
// custom-serialized objects (C:), enums (E:) and references (r:/R:) are refused by default:
// nothing here ever instantiates a class, and refusing keeps a hostile payload from surviving a
// round-trip back into PHP where it would be. `classes: "inert"` keeps class objects as tagged
// data instead (still never instantiated).

import { fromUtf8, utf8 } from "./bytes.ts";
import { migrateError } from "./errors.ts";

/** Symbol key holding the PHP class name of an unserialized object (`"stdClass"` or, inert, others). */
export const PHP_CLASS = Symbol.for("miujs.migrate.phpClass");

export interface PhpUnserializeOptions {
  /** `"refuse"` (default): throw on any class other than stdClass. `"inert"`: keep as tagged data. */
  classes?: "refuse" | "inert";
  /** Nesting limit. Default 64. */
  maxDepth?: number;
}

const bad = (message: string) =>
  migrateError("PHP_UNSERIALIZE", 400, `Cannot unserialize PHP data: ${message}`, "Check that the payload is PHP serialize() output (session.serialization = php). For JSON sessions use serialization: \"json\".");

const classRefused = (what: string) =>
  migrateError(
    "PHP_CLASS",
    400,
    `Refusing to unserialize ${what}`,
    "Only scalars, arrays and stdClass are read. Keep objects out of the session (store ids), or pass classes: \"inert\" to read them as plain data.",
  );

function setKey(obj: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function phpUnserialize(input: string | Uint8Array, opts: PhpUnserializeOptions = {}): unknown {
  const b = typeof input === "string" ? utf8(input) : input;
  const inert = opts.classes === "inert";
  const maxDepth = opts.maxDepth ?? 64;
  let i = 0;

  const expect = (ch: string) => {
    if (b[i] !== ch.charCodeAt(0)) throw bad(`expected "${ch}" at byte ${i}`);
    i++;
  };
  /** Reads up to (not including) `term`, then skips it. */
  const until = (term: string): string => {
    const t = term.charCodeAt(0);
    const start = i;
    while (i < b.length && b[i] !== t) i++;
    if (i >= b.length) throw bad(`unterminated value at byte ${start}`);
    const s = fromUtf8(b.subarray(start, i));
    i++;
    return s;
  };
  const int = (term: string): number => {
    const s = until(term);
    if (!/^[+-]?\d+$/.test(s)) throw bad(`bad integer "${s.slice(0, 20)}"`);
    const n = Number(s);
    if (!Number.isSafeInteger(n)) throw bad(`integer out of range "${s.slice(0, 20)}"`);
    return n;
  };
  const count = (): number => {
    const n = int(":");
    // Every element takes at least 4 bytes ("N;" key + value), so a bigger count is a lie.
    if (n < 0 || n * 4 > b.length - i) throw bad(`bad element count ${n}`);
    return n;
  };
  const str = (): string => {
    const len = int(":");
    if (len < 0 || i + 1 + len + 2 > b.length) throw bad(`bad string length ${len}`);
    expect('"');
    const s = fromUtf8(b.subarray(i, i + len));
    i += len;
    expect('"');
    return s;
  };

  const key = (): string | number => {
    const t = String.fromCharCode(b[i]);
    i++;
    expect(":");
    if (t === "i") return int(";");
    if (t === "s") {
      const s = str();
      expect(";");
      return s;
    }
    throw bad(`bad array key type "${t}"`);
  };

  const members = (n: number, depth: number): [string | number, unknown][] => {
    expect("{");
    const out: [string | number, unknown][] = [];
    for (let k = 0; k < n; k++) out.push([key(), value(depth + 1)]);
    expect("}");
    return out;
  };

  const value = (depth: number): unknown => {
    if (depth > maxDepth) throw bad(`nested deeper than ${maxDepth}`);
    if (i >= b.length) throw bad("unexpected end of input");
    const t = String.fromCharCode(b[i]);
    i++;
    if (t === "N") {
      expect(";");
      return null;
    }
    if (t === "C" || t === "E") throw classRefused(t === "C" ? "a custom-serialized object (C:)" : "an enum (E:)");
    if (t === "r" || t === "R") throw bad("references (r:/R:) are not supported");
    expect(":");
    switch (t) {
      case "b": {
        const s = until(";");
        if (s !== "0" && s !== "1") throw bad(`bad boolean "${s.slice(0, 20)}"`);
        return s === "1";
      }
      case "i":
        return int(";");
      case "d": {
        const s = until(";");
        if (s === "INF") return Infinity;
        if (s === "-INF") return -Infinity;
        if (s === "NAN") return NaN;
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw bad(`bad float "${s.slice(0, 20)}"`);
        return Number(s);
      }
      case "s": {
        const s = str();
        expect(";");
        return s;
      }
      case "a": {
        const n = count();
        const entries = members(n, depth);
        if (entries.every(([k], idx) => k === idx)) return entries.map(([, v]) => v);
        const obj: Record<string, unknown> = {};
        for (const [k, v] of entries) setKey(obj, String(k), v);
        return obj;
      }
      case "O": {
        const name = str();
        expect(":");
        if (name !== "stdClass" && !inert) throw classRefused(`an object of class ${name.slice(0, 100)}`);
        const n = count();
        const obj: Record<string | symbol, unknown> = {};
        for (const [k, v] of members(n, depth)) setKey(obj as Record<string, unknown>, String(k), v);
        Object.defineProperty(obj, PHP_CLASS, { value: name, enumerable: false });
        return obj;
      }
      default:
        throw bad(`unknown type "${t}" at byte ${i - 1}`);
    }
  };

  const out = value(0);
  if (i !== b.length) throw bad(`trailing data at byte ${i}`);
  return out;
}

function phpFloat(n: number): string {
  if (Number.isNaN(n)) return "NAN";
  if (n === Infinity) return "INF";
  if (n === -Infinity) return "-INF";
  const s = String(n);
  const e = s.indexOf("e");
  if (e === -1) return s;
  // PHP prints exponents as 1.0E+25 / 1.5E-7.
  const mant = s.slice(0, e);
  return `${mant.includes(".") ? mant : `${mant}.0`}E${s.slice(e + 1)}`;
}

const INT_KEY = /^(0|-?[1-9]\d*)$/;

function phpKey(k: string): string {
  if (INT_KEY.test(k) && Number.isSafeInteger(Number(k))) return `i:${k};`;
  return phpString(k);
}

function phpString(s: string): string {
  return `s:${utf8(s).length}:"${s}";`;
}

/** PHP serialize() for JSON-like values. Arrays become lists, objects maps (or stdClass when tagged). */
export function phpSerialize(value: unknown): string {
  if (value === null || value === undefined) return "N;";
  switch (typeof value) {
    case "boolean":
      return value ? "b:1;" : "b:0;";
    case "number":
      return Number.isInteger(value) && Number.isSafeInteger(value) ? `i:${value};` : `d:${phpFloat(value)};`;
    case "bigint":
      return `i:${value};`;
    case "string":
      return phpString(value);
    case "object": {
      if (Array.isArray(value)) return `a:${value.length}:{${value.map((v, idx) => `i:${idx};${phpSerialize(v)}`).join("")}}`;
      const entries = Object.entries(value);
      const body = entries.map(([k, v]) => phpKey(k) + phpSerialize(v)).join("");
      const cls = (value as Record<symbol, unknown>)[PHP_CLASS];
      if (typeof cls === "string") return `O:${utf8(cls).length}:"${cls}":${entries.length}:{${entries.map(([k, v]) => phpString(k) + phpSerialize(v)).join("")}}`;
      return `a:${entries.length}:{${body}}`;
    }
    default:
      throw migrateError("PHP_SERIALIZE", 500, `Cannot serialize a ${typeof value} for PHP`, "Store only JSON-like values (strings, numbers, booleans, null, arrays, objects) in a shared session.");
  }
}
