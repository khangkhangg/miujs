import { describe, expect, test } from "bun:test";
import { t } from "miujs";
import { describeActions } from "@miujs/workflows";
import { schemaFormLib } from "../../src/ui/client/schema-form.ts";

const lib = schemaFormLib();

describe("JSON Schema → form fields", () => {
  test("built-in http action params", () => {
    const http = describeActions().find((a) => a.name === "http")!;
    expect(lib.fields(http.params)).toEqual([
      { name: "url", kind: "text", required: true, format: "url" },
      { name: "method", kind: "enum", required: false, options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { name: "headers", kind: "json", required: false },
      { name: "body", kind: "json", required: false },
    ]);
  });

  test("numbers, integers, booleans, descriptions, unions", () => {
    const s = t.object({
      days: t.integer({ min: 0, description: "Days from now" }),
      ratio: t.optional(t.number()),
      on: t.optional(t.boolean()),
      to: t.union([t.string(), t.array(t.string())]),
      who: t.optional(t.nullable(t.string())),
    });
    expect(lib.fields(s.json)).toEqual([
      { name: "days", kind: "integer", required: true, description: "Days from now" },
      { name: "ratio", kind: "number", required: false },
      { name: "on", kind: "boolean", required: false },
      { name: "to", kind: "json", required: true },
      { name: "who", kind: "text", required: false },
    ]);
  });

  test("non-object schemas give a single JSON field", () => {
    expect(lib.fields({ type: "string" })).toEqual([{ name: "", kind: "json", required: false }]);
    expect(lib.fields(undefined)).toEqual([]);
  });
});

describe("form values → typed object", () => {
  const fields = lib.fields(t.object({ n: t.integer(), x: t.optional(t.number()), b: t.optional(t.boolean()), s: t.optional(t.string()), j: t.optional(t.unknown()), e: t.optional(t.enum(["a", "b"])) }).json);

  test("coerces by kind and leaves out empty optional values", () => {
    expect(lib.coerce(fields, { n: "3", x: "1.5", b: "true", s: "hi", j: '{"a":1}', e: "b" })).toEqual({ value: { n: 3, x: 1.5, b: true, s: "hi", j: { a: 1 }, e: "b" }, errors: [] });
    expect(lib.coerce(fields, { n: "3", x: "", s: "", j: "" })).toEqual({ value: { n: 3 }, errors: [] });
  });

  test("templates stay strings so they are interpolated at run time", () => {
    expect(lib.coerce(fields, { n: "{{ data.days }}", j: "{{ data.record }}" }).value).toEqual({ n: "{{ data.days }}", j: "{{ data.record }}" });
  });

  test("reports bad numbers and bad JSON; JSON fields accept plain text", () => {
    const r = lib.coerce(fields, { n: "many", j: "not json" });
    expect(r.errors).toEqual([{ name: "n", message: "must be a number" }]);
    expect(r.value.j).toBe("not json");
    expect(lib.coerce(fields, { n: "1.5" }).errors).toEqual([{ name: "n", message: "must be a whole number" }]);
  });

  test("toForm turns values back into strings", () => {
    expect(lib.toForm(fields, { n: 3, b: false, j: { a: 1 }, s: "x" })).toEqual({ n: "3", b: "false", j: '{"a":1}', s: "x" });
  });
});
