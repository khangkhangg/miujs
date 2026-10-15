import { describe, expect, test } from "bun:test";
import { isSchema, t, validate } from "../src/schema.ts";

const ok = (s: Parameters<typeof validate>[0], v: unknown, coerce = false) => {
  const r = validate(s, v, { coerce });
  if (!r.ok) throw new Error("expected ok, got " + JSON.stringify(r.issues));
  return r.value;
};
const issues = (s: Parameters<typeof validate>[0], v: unknown, coerce = false) => {
  const r = validate(s, v, { coerce });
  if (r.ok) throw new Error("expected issues, got ok " + JSON.stringify(r.value));
  return r.issues;
};

describe("t.string", () => {
  test("accepts strings, rejects other types with type name", () => {
    expect(ok(t.string(), "hi")).toBe("hi");
    expect(issues(t.string(), 5)).toEqual([{ path: "", message: "expected string, got number" }]);
    expect(issues(t.string(), null)[0].message).toBe("expected string, got null");
    expect(issues(t.string(), [])[0].message).toBe("expected string, got array");
  });

  test("minLength / maxLength are inclusive", () => {
    const s = t.string({ minLength: 2, maxLength: 3 });
    expect(ok(s, "ab")).toBe("ab");
    expect(ok(s, "abc")).toBe("abc");
    expect(issues(s, "a")[0].message).toBe("must be at least 2 characters");
    expect(issues(s, "abcd")[0].message).toBe("must be at most 3 characters");
  });

  test("pattern", () => {
    const s = t.string({ pattern: /^[a-z]+$/ });
    expect(ok(s, "abc")).toBe("abc");
    expect(issues(s, "aB1")[0].message).toBe("must match /^[a-z]+$/");
    expect(s.json.pattern).toBe("^[a-z]+$");
  });

  test("uuid format", () => {
    const s = t.string({ format: "uuid" });
    expect(ok(s, "123e4567-e89b-12d3-a456-426614174000")).toBeTruthy();
    expect(ok(s, "123E4567-E89B-12D3-A456-426614174000")).toBeTruthy();
    expect(issues(s, "123e4567-e89b-12d3-a456-42661417400")[0].message).toBe("must be a valid uuid");
    expect(issues(s, "not-a-uuid").length).toBe(1);
  });

  test("email format", () => {
    const s = t.string({ format: "email" });
    expect(ok(s, "a@b.co")).toBe("a@b.co");
    expect(issues(s, "a@b")[0].message).toBe("must be a valid email");
    expect(issues(s, "a b@c.de").length).toBe(1);
    expect(issues(s, "@c.de").length).toBe(1);
  });

  test("date-time format", () => {
    const s = t.string({ format: "date-time" });
    expect(ok(s, "2024-01-02T03:04:05Z")).toBeTruthy();
    expect(ok(s, "2024-01-02T03:04:05.123+07:00")).toBeTruthy();
    expect(ok(s, "2024-01-02T03:04Z")).toBeTruthy();
    expect(issues(s, "2024-01-02T03:04:05")[0].message).toBe("must be a valid date-time"); // no tz
    expect(issues(s, "2024-01-02").length).toBe(1);
  });

  test("date and url formats", () => {
    expect(ok(t.string({ format: "date" }), "2024-01-02")).toBe("2024-01-02");
    expect(issues(t.string({ format: "date" }), "2024-1-2").length).toBe(1);
    expect(ok(t.string({ format: "url" }), "https://x.dev/a")).toBeTruthy();
    expect(issues(t.string({ format: "url" }), "ftp://x.dev").length).toBe(1);
  });

  test("json schema includes constraints, description and examples", () => {
    const s = t.string({ minLength: 1, maxLength: 9, format: "email", description: "d", example: "a@b.c" });
    expect(s.json).toEqual({ type: "string", minLength: 1, maxLength: 9, format: "email", description: "d", examples: ["a@b.c"] });
    expect(s.kind).toBe("string");
    expect(s.isOptional).toBe(false);
  });

  test("strings are never coerced from numbers", () => {
    expect(issues(t.string(), 5, true).length).toBe(1);
  });
});

describe("t.number / t.integer", () => {
  test("accepts numbers, rejects NaN and strings without coerce", () => {
    expect(ok(t.number(), 1.5)).toBe(1.5);
    expect(issues(t.number(), NaN)[0].message).toBe("expected number, got number");
    expect(issues(t.number(), "12")).toEqual([{ path: "", message: "expected number, got string" }]);
  });

  test("coerces numeric strings only when coerce=true", () => {
    expect(ok(t.number(), "12", true)).toBe(12);
    expect(ok(t.number(), "-1.5", true)).toBe(-1.5);
    expect(issues(t.number(), "abc", true)[0].message).toBe("expected number, got string");
  });

  test("empty / whitespace string is not coerced to 0", () => {
    expect(issues(t.number(), "", true).length).toBe(1);
    expect(issues(t.number(), "   ", true).length).toBe(1);
  });

  test("min / max inclusive", () => {
    const s = t.number({ min: 1, max: 10 });
    expect(ok(s, 1)).toBe(1);
    expect(ok(s, 10)).toBe(10);
    expect(issues(s, 0)[0].message).toBe("must be >= 1");
    expect(issues(s, 11)[0].message).toBe("must be <= 10");
    expect(s.json).toEqual({ type: "number", minimum: 1, maximum: 10 });
  });

  test("integer rejects fractions", () => {
    const s = t.integer({ min: 0 });
    expect(ok(s, 3)).toBe(3);
    expect(issues(s, 1.5)[0].message).toBe("must be an integer");
    expect(issues(s, "1.5", true)[0].message).toBe("must be an integer");
    expect(issues(s, "x", true)[0].message).toBe("expected integer, got string");
    expect(s.kind).toBe("integer");
    expect(s.json).toEqual({ type: "integer", minimum: 0 });
  });
});

describe("t.boolean", () => {
  test("accepts booleans; rejects strings without coerce", () => {
    expect(ok(t.boolean(), false)).toBe(false);
    expect(issues(t.boolean(), "true")[0].message).toBe("expected boolean, got string");
  });

  test("coerces true/false/1/0 strings", () => {
    expect(ok(t.boolean(), "true", true)).toBe(true);
    expect(ok(t.boolean(), "1", true)).toBe(true);
    expect(ok(t.boolean(), "false", true)).toBe(false);
    expect(ok(t.boolean(), "0", true)).toBe(false);
    expect(issues(t.boolean(), "yes", true).length).toBe(1);
    expect(issues(t.boolean(), 1, true).length).toBe(1);
  });
});

describe("t.literal", () => {
  test("exact match", () => {
    expect(ok(t.literal("a"), "a")).toBe("a");
    expect(issues(t.literal("a"), "b")).toEqual([{ path: "", message: 'expected "a"' }]);
    expect(t.literal(3).json).toEqual({ const: 3 });
  });

  test("coerces string form of number / boolean literal only with coerce", () => {
    expect(ok(t.literal(3), "3", true)).toBe(3);
    expect(ok(t.literal(true), "true", true)).toBe(true);
    expect(issues(t.literal(3), "3").length).toBe(1);
  });
});

describe("t.enum", () => {
  test("string enum", () => {
    const s = t.enum(["a", "b"]);
    expect(ok(s, "b")).toBe("b");
    expect(issues(s, "c")).toEqual([{ path: "", message: 'expected one of "a", "b"' }]);
    expect(s.json).toEqual({ enum: ["a", "b"], type: "string" });
  });

  test("numeric enum coerces from string only with coerce", () => {
    const s = t.enum([1, 2, 3]);
    expect(s.json).toEqual({ enum: [1, 2, 3] });
    expect(ok(s, 2)).toBe(2);
    expect(ok(s, "2", true)).toBe(2);
    expect(issues(s, "2").length).toBe(1);
    expect(issues(s, "4", true).length).toBe(1);
  });

  test("empty string is not coerced to 0", () => {
    expect(issues(t.enum([0, 1]), "", true).length).toBe(1);
    expect(issues(t.enum([0, 1]), "  ", true).length).toBe(1);
  });
});

describe("t.array", () => {
  test("validates items with indexed paths", () => {
    const s = t.array(t.number());
    expect(ok(s, [1, 2])).toEqual([1, 2]);
    expect(issues(s, [1, "x", 3, "y"]).map((i) => i.path)).toEqual(["1", "3"]);
    expect(issues(s, "x")[0].message).toBe("expected array, got string");
  });

  test("min / max items", () => {
    const s = t.array(t.any(), { min: 1, max: 2 });
    expect(issues(s, [])[0].message).toBe("must have at least 1 items");
    expect(issues(s, [1, 2, 3])[0].message).toBe("must have at most 2 items");
    expect(s.json).toEqual({ type: "array", items: {}, minItems: 1, maxItems: 2 });
  });

  test("min / max items are inclusive", () => {
    const s = t.array(t.any(), { min: 2, max: 2 });
    expect(ok(s, [1, 2])).toEqual([1, 2]);
  });

  test("coerce wraps single value and coerces items", () => {
    expect(ok(t.array(t.number()), "5", true)).toEqual([5]);
    expect(ok(t.array(t.number()), ["1", "2"], true)).toEqual([1, 2]);
    expect(issues(t.array(t.number()), 5).length).toBe(1); // no wrap without coerce
  });
});

describe("t.object", () => {
  test("strips unknown keys", () => {
    const s = t.object({ a: t.string() });
    expect(ok(s, { a: "x", b: 1, c: {} })).toEqual({ a: "x" });
  });

  test("required keys produce 'is required' at dotted path", () => {
    const s = t.object({ user: t.object({ name: t.string() }) });
    expect(issues(s, { user: {} })).toEqual([{ path: "user.name", message: "is required" }]);
    expect(issues(s, [])[0].message).toBe("expected object, got array");
    expect(issues(s, null)[0].message).toBe("expected object, got null");
  });

  test("nested array path like items.2.qty", () => {
    const s = t.object({ items: t.array(t.object({ qty: t.integer({ min: 1 }) })) });
    const r = issues(s, { items: [{ qty: 1 }, { qty: 2 }, { qty: 0 }] });
    expect(r).toEqual([{ path: "items.2.qty", message: "must be >= 1" }]);
    const r2 = validate(s, { items: [{}] }, { path: "body" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues[0].path).toBe("body.items.0.qty");
  });

  test("optional keys are omitted, default keys are filled", () => {
    const s = t.object({ a: t.optional(t.string()), b: t.default(t.number(), 7) });
    const v = ok(s, {});
    expect(v).toEqual({ b: 7 });
    expect("a" in (v as object)).toBe(false);
    expect(ok(s, { a: "x", b: 1 })).toEqual({ a: "x", b: 1 });
    expect(issues(s, { a: 1 })[0].path).toBe("a"); // optional still validates when present
  });

  test("json schema lists only required keys", () => {
    const s = t.object({ a: t.string(), b: t.optional(t.number()), c: t.default(t.boolean(), true) });
    expect(s.json).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean", default: true } },
      required: ["a"],
    });
    expect(t.object({ x: t.optional(t.string()) }).json.required).toBeUndefined();
    expect(Object.keys(s.shape)).toEqual(["a", "b", "c"]);
  });

  test("coerce propagates to fields", () => {
    const s = t.object({ page: t.integer(), q: t.optional(t.boolean()) });
    expect(ok(s, { page: "3", q: "1" }, true)).toEqual({ page: 3, q: true });
    expect(issues(s, { page: "3" }).length).toBe(1);
  });

  test("null for a required key is a type error, not 'is required'", () => {
    expect(issues(t.object({ a: t.string() }), { a: null })[0].message).toBe("expected string, got null");
  });
});

describe("t.record", () => {
  test("validates each value with key path", () => {
    const s = t.record(t.number());
    expect(ok(s, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(issues(s, { a: 1, b: "x" })).toEqual([{ path: "b", message: "expected number, got string" }]);
    expect(issues(s, 1)[0].message).toBe("expected object, got number");
    expect(s.json).toEqual({ type: "object", additionalProperties: { type: "number" } });
  });

  test("ignores inherited enumerable properties", () => {
    const input = Object.create({ inherited: "x" });
    input.own = 1;
    expect(ok(t.record(t.any()), input)).toEqual({ own: 1 });
    expect(Object.keys(ok(t.record(t.any()), input) as object)).toEqual(["own"]);
  });

  test("__proto__ key from JSON does not change the output prototype", () => {
    const input = JSON.parse('{"__proto__": {"isAdmin": true}, "a": {"x": 1}}');
    const v = ok(t.record(t.any()), input) as Record<string, any>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(v.isAdmin).toBeUndefined();
    expect(Object.keys(v).sort()).toEqual(["__proto__", "a"]);
  });
});

describe("t.union", () => {
  test("returns the first matching option", () => {
    const s = t.union([t.number(), t.string()]);
    expect(ok(s, 1)).toBe(1);
    expect(ok(s, "x")).toBe("x");
    // With coerce, "5" matches number first.
    expect(ok(s, "5", true)).toBe(5);
    expect(ok(t.union([t.string(), t.number()]), "5", true)).toBe("5");
  });

  test("failing all options reports one issue, not inner issues", () => {
    const s = t.union([t.number(), t.boolean()]);
    expect(issues(s, "x")).toEqual([{ path: "", message: "did not match any of: number, boolean" }]);
    expect(s.json).toEqual({ anyOf: [{ type: "number" }, { type: "boolean" }] });
  });

  test("first option with no issues wins even if a later one would strip differently", () => {
    const s = t.union([t.object({ a: t.string() }), t.object({ a: t.string(), b: t.number() })]);
    expect(ok(s, { a: "x", b: 1 })).toEqual({ a: "x" });
  });
});

describe("optional / default / nullable", () => {
  test("optional at top level accepts undefined", () => {
    const s = t.optional(t.string());
    expect(s.isOptional).toBe(true);
    expect(ok(s, undefined)).toBeUndefined();
    expect(issues(s, null).length).toBe(1);
  });

  test("default fills undefined, validates otherwise", () => {
    const s = t.default(t.integer(), 10);
    expect(ok(s, undefined)).toBe(10);
    expect(ok(s, "4", true)).toBe(4);
    expect(issues(s, "a", true).length).toBe(1);
    expect(s.json).toEqual({ type: "integer", default: 10 });
  });

  test("object/array defaults are not shared between validations", () => {
    const s = t.object({ tags: t.default(t.array(t.string()), [] as string[]) });
    const a = ok(s, {}) as { tags: string[] };
    a.tags.push("leak");
    const b = ok(s, {}) as { tags: string[] };
    expect(b.tags).toEqual([]);
  });

  test("nullable accepts null and keeps inner optionality", () => {
    const s = t.nullable(t.number());
    expect(ok(s, null)).toBeNull();
    expect(ok(s, 1)).toBe(1);
    expect(issues(s, "x").length).toBe(1);
    expect(s.isOptional).toBe(false);
    expect(s.json).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
    expect(t.nullable(t.optional(t.number())).isOptional).toBe(true);
  });
});

describe("any / unknown / isSchema / validate", () => {
  test("any and unknown pass through", () => {
    const obj = { x: 1 };
    expect(ok(t.any(), obj)).toBe(obj);
    expect(ok(t.unknown(), undefined)).toBeUndefined();
    expect(t.any().json).toEqual({});
  });

  test("isSchema", () => {
    expect(isSchema(t.string())).toBe(true);
    expect(isSchema({ parse() {} })).toBe(false);
    expect(isSchema(null)).toBe(false);
  });

  test("validate defaults coerce to false and collects all issues", () => {
    const s = t.object({ a: t.number(), b: t.string() });
    expect(validate(s, { a: "1", b: 2 })).toEqual({
      ok: false,
      issues: [
        { path: "a", message: "expected number, got string" },
        { path: "b", message: "expected string, got number" },
      ],
    });
    expect(validate(s, { a: "1", b: "x" }, { coerce: true })).toEqual({ ok: true, value: { a: 1, b: "x" } });
  });
});
