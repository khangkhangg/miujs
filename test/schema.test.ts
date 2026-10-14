import { describe, expect, test } from "bun:test";
import { t, validate, toJSONSchema } from "../src/core/schema.ts";

describe("t schema builder", () => {
  test("string accepts strings and rejects others", () => {
    expect(validate(t.string(), "hi")).toEqual({ ok: true, value: "hi" });
    const r = validate(t.string(), 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toEqual({ path: [], message: "Expected string" });
  });

  test("string min/max/format", () => {
    expect(validate(t.string({ min: 3 }), "ab").ok).toBe(false);
    expect(validate(t.string({ max: 2 }), "abc").ok).toBe(false);
    expect(validate(t.string({ format: "email" }), "a@b.co").ok).toBe(true);
    expect(validate(t.string({ format: "email" }), "nope").ok).toBe(false);
  });

  test("number coerces numeric strings when coerce is on", () => {
    expect(validate(t.number(), "42", { coerce: true })).toEqual({ ok: true, value: 42 });
    expect(validate(t.number(), "42").ok).toBe(false);
    expect(validate(t.number(), "abc", { coerce: true }).ok).toBe(false);
  });

  test("integer rejects fractions", () => {
    expect(validate(t.integer(), 1.5).ok).toBe(false);
    expect(validate(t.integer(), 2).ok).toBe(true);
  });

  test("boolean coerces 'true'/'false'", () => {
    expect(validate(t.boolean(), "true", { coerce: true })).toEqual({ ok: true, value: true });
    expect(validate(t.boolean(), "0", { coerce: true })).toEqual({ ok: true, value: false });
  });

  test("enum", () => {
    const s = t.enum(["a", "b"]);
    expect(validate(s, "a").ok).toBe(true);
    expect(validate(s, "c").ok).toBe(false);
  });

  test("object validates nested fields and reports paths", () => {
    const s = t.object({ name: t.string(), age: t.number(), tags: t.array(t.string()) });
    const r = validate(s, { name: "x", age: "no", tags: ["a", 1] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.path)).toEqual([["age"], ["tags", 1]]);
    }
  });

  test("object missing required field", () => {
    const r = validate(t.object({ a: t.string() }), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toEqual({ path: ["a"], message: "Required" });
  });

  test("optional fields may be absent and defaults apply", () => {
    const s = t.object({ a: t.optional(t.string()), b: t.default(t.number(), 10) });
    expect(validate(s, {})).toEqual({ ok: true, value: { b: 10 } });
  });

  test("object strips unknown keys", () => {
    expect(validate(t.object({ a: t.string() }), { a: "x", evil: 1 })).toEqual({ ok: true, value: { a: "x" } });
  });

  test("toJSONSchema produces draft 2020-12 compatible output", () => {
    const s = t.object(
      { id: t.integer({ min: 1 }), email: t.string({ format: "email" }), role: t.optional(t.enum(["admin", "user"])) },
      { description: "A user" },
    );
    expect(toJSONSchema(s)).toEqual({
      type: "object",
      description: "A user",
      properties: {
        id: { type: "integer", minimum: 1 },
        email: { type: "string", format: "email" },
        role: { type: "string", enum: ["admin", "user"] },
      },
      required: ["id", "email"],
      additionalProperties: false,
    });
  });

  test("accepts Standard Schema validators (zod/valibot/arktype)", async () => {
    const standard = {
      "~standard": {
        version: 1 as const,
        vendor: "fake",
        validate: (v: unknown) =>
          typeof v === "string" ? { value: v.toUpperCase() } : { issues: [{ message: "bad", path: ["x"] }] },
      },
    };
    expect(await validate(standard, "hi")).toEqual({ ok: true, value: "HI" });
    const r = await validate(standard, 1);
    expect(r).toEqual({ ok: false, issues: [{ path: ["x"], message: "bad" }] });
  });
});
