import { describe, expect, test } from "bun:test";
import { adminSchema } from "../../src/index.ts";
import { filterLib } from "../../src/ui/client/filters.ts";
import { uiResources } from "./fixtures.ts";

const fields = adminSchema(uiResources()).resources[1].fields;
const lib = filterLib();

describe("filter builder: operators and inputs", () => {
  test("operators come from the field metadata, with labels", () => {
    expect(lib.operators(fields.find((f) => f.name === "tags")!).map((o) => o.op)).toEqual(["contains", "isNull"]);
    const ops = lib.operators(fields.find((f) => f.name === "value")!);
    expect(ops.map((o) => o.op)).toEqual(["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"]);
    expect(ops.find((o) => o.op === "gte")!.label).toBe("≥");
  });

  test("value input kind follows the field type and operator", () => {
    const f = (n: string) => fields.find((x) => x.name === n)!;
    expect(lib.valueInput(f("name"), "contains")).toEqual({ kind: "text" });
    expect(lib.valueInput(f("value"), "gte")).toEqual({ kind: "number", step: "0.01" });
    expect(lib.valueInput(f("score"), "eq")).toEqual({ kind: "number", step: "1" });
    expect(lib.valueInput(f("birthday"), "lt")).toEqual({ kind: "date" });
    expect(lib.valueInput(f("lastSeen"), "gt")).toEqual({ kind: "datetime-local" });
    expect(lib.valueInput(f("vip"), "eq")).toEqual({ kind: "boolean" });
    expect(lib.valueInput(f("stage"), "eq")).toMatchObject({ kind: "select", options: [{ value: "lead", label: "Lead" }, { value: "customer" }, { value: "lost" }] });
    expect(lib.valueInput(f("stage"), "in")).toEqual({ kind: "text", hint: "comma-separated" });
    expect(lib.valueInput(f("name"), "isNull")).toEqual({ kind: "boolean" });
  });
});

describe("filter builder: rows → filter JSON", () => {
  test("converts values by type: money in major units, numbers, booleans, lists", () => {
    const out = lib.rowsToFilter(
      [
        { field: "value", op: "gte", value: "12.5" },
        { field: "value", op: "lt", value: "100" },
        { field: "score", op: "in", value: "1, 2 ,3" },
        { field: "vip", op: "eq", value: "true" },
        { field: "name", op: "contains", value: "ann" },
        { field: "stage", op: "in", value: "lead,customer" },
        { field: "email", op: "isNull", value: "false" },
        { field: "birthday", op: "gte", value: "today" },
      ],
      fields,
    );
    expect(out.errors).toEqual([]);
    expect(out.filter).toEqual({
      value: { gte: 1250, lt: 10000 },
      score: { in: [1, 2, 3] },
      vip: { eq: true },
      name: { contains: "ann" },
      stage: { in: ["lead", "customer"] },
      email: { isNull: false },
      birthday: { gte: "today" },
    });
  });

  test("datetime-local values are read as UTC", () => {
    expect(lib.rowsToFilter([{ field: "lastSeen", op: "gt", value: "2026-03-01T09:30" }], fields).filter).toEqual({ lastSeen: { gt: "2026-03-01T09:30:00.000Z" } });
  });

  test("bad rows are reported by index and left out", () => {
    const out = lib.rowsToFilter(
      [
        { field: "value", op: "gte", value: "lots" },
        { field: "nope", op: "eq", value: "x" },
        { field: "tags", op: "gt", value: "x" },
        { field: "name", op: "eq", value: "" },
        { field: "name", op: "eq", value: "Ann" },
      ],
      fields,
    );
    expect(out.filter).toEqual({ name: { eq: "Ann" } });
    expect(out.errors.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(out.errors[0].message).toContain("number");
  });

  test("a field cannot be named __proto__", () => {
    const out = lib.rowsToFilter([{ field: "__proto__", op: "eq", value: "x" }], fields);
    expect(out.filter).toEqual({});
    expect(Object.getPrototypeOf(out.filter)).toBe(Object.prototype);
  });
});

describe("filter builder: filter JSON → rows (round trip)", () => {
  test("eq shorthand, operator objects, money back to major units, lists joined", () => {
    const rows = lib.filterToRows({ stage: "lead", value: { gte: 1250 }, score: { in: [1, 2] }, vip: { eq: true }, email: { isNull: true } }, fields);
    expect(rows).toEqual([
      { field: "stage", op: "eq", value: "lead" },
      { field: "value", op: "gte", value: "12.50" },
      { field: "score", op: "in", value: "1, 2" },
      { field: "vip", op: "eq", value: "true" },
      { field: "email", op: "isNull", value: "true" },
    ]);
    expect(lib.rowsToFilter(rows, fields).filter).toEqual({ stage: { eq: "lead" }, value: { gte: 1250 }, score: { in: [1, 2] }, vip: { eq: true }, email: { isNull: true } });
  });

  test("garbage input gives no rows instead of throwing", () => {
    expect(lib.filterToRows(null, fields)).toEqual([]);
    expect(lib.filterToRows("x", fields)).toEqual([]);
    expect(lib.filterToRows({ unknown: 1 }, fields)).toEqual([]);
  });
});

describe("filter builder: query string", () => {
  test("keeps q, sort and view; drops empty filters and the cursor", () => {
    expect(lib.toQuery({ filter: { stage: { eq: "lead" } }, q: "ann", sort: "-name", view: "leads", cursor: "abc" })).toBe(
      "view=leads&filter=%7B%22stage%22%3A%7B%22eq%22%3A%22lead%22%7D%7D&q=ann&sort=-name",
    );
    expect(lib.toQuery({ filter: {}, q: "" })).toBe("");
  });
});
