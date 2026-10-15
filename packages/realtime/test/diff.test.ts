import { expect, test } from "bun:test";
import { applyPatch, diff } from "../src/diff.ts";

test("no changes → no ops", () => {
  expect(diff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
});

test("top-level and nested key changes become replace/add/remove ops", () => {
  const prev = { a: 1, b: { c: 2, d: 3 }, gone: true };
  const next = { a: 2, b: { c: 2, e: 4 }, fresh: "x" };
  expect(diff(prev, next)).toEqual([
    { op: "replace", path: "/a", value: 2 },
    { op: "remove", path: "/b/d" },
    { op: "add", path: "/b/e", value: 4 },
    { op: "remove", path: "/gone" },
    { op: "add", path: "/fresh", value: "x" },
  ]);
});

test("arrays are replaced whole", () => {
  expect(diff({ list: [1, 2, 3] }, { list: [1, 2, 4] })).toEqual([{ op: "replace", path: "/list", value: [1, 2, 4] }]);
});

test("object ↔ non-object switches replace the value", () => {
  expect(diff({ q: null }, { q: { text: "hi" } })).toEqual([{ op: "replace", path: "/q", value: { text: "hi" } }]);
  expect(diff({ q: { text: "hi" } }, { q: null })).toEqual([{ op: "replace", path: "/q", value: null }]);
});

test("keys with / and ~ are escaped per RFC 6901", () => {
  expect(diff({}, { "a/b~c": 1 })).toEqual([{ op: "add", path: "/a~1b~0c", value: 1 }]);
});

test("applyPatch(prev, diff(prev, next)) equals next", () => {
  const prev = { a: 1, b: { c: 2, d: 3, "x/y": 1 }, list: [1], gone: true };
  const next = { a: 2, b: { c: 2, e: { f: 1 } }, list: [1, 2], fresh: null };
  const out = applyPatch(structuredClone(prev), diff(prev, next));
  expect(out).toEqual(next);
});

test("a root replace swaps the whole document", () => {
  expect(applyPatch({ a: 1 }, [{ op: "replace", path: "", value: { b: 2 } }])).toEqual({ b: 2 });
});
