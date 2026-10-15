// Type-level tests: these fail `bun run typecheck`, not `bun test`.
import { expect, test } from "bun:test";
import { t, validate, type Infer } from "../src/index.ts";

const S = t.object({ a: t.default(t.string(), "x"), b: t.optional(t.string()), c: t.string() });
type Out = Infer<typeof S>;

test("t.default fields are required in the output type; t.optional fields are optional", () => {
  const out: Out = { a: "x", c: "y" };
  const a: string = out.a; // must not be `string | undefined`
  // @ts-expect-error b may be undefined
  const b: string = out.b;
  expect(a).toBe("x");
  expect(b).toBeUndefined();
});

test("t.string pattern accepts a string as well as a RegExp", () => {
  const s = t.string({ pattern: "^[a-z]+$" });
  expect(validate(s, "abc").ok).toBe(true);
  expect(validate(s, "ABC").ok).toBe(false);
});
