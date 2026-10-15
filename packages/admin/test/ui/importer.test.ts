import { describe, expect, test } from "bun:test";
import { adminSchema } from "../../src/index.ts";
import { importerLib } from "../../src/ui/client/importer.ts";
import { monthGrid, monthRange, parseMonth } from "../../src/ui/calendar.ts";
import { uiResources } from "./fixtures.ts";

const fields = adminSchema(uiResources()).resources[1].fields;
const lib = importerLib();

describe("import wizard: headers and mapping", () => {
  test("reads the header row (BOM, quotes, commas and newlines in quotes, CRLF)", () => {
    expect(lib.headers('﻿Name,"E-mail, work","Line\nbreak",value\r\nAnn,a@x.io,x,1\r\n')).toEqual(["Name", "E-mail, work", "Line\nbreak", "value"]);
    expect(lib.headers('"say ""hi""",b')).toEqual(['say "hi"', "b"]);
    expect(lib.headers("")).toEqual([]);
  });

  test("guesses fields by name or label (case/space-insensitive); skips the rest", () => {
    expect(lib.guess(["Name", "EMAIL", "Next follow-up", "Value", "Stage", "id", "Created"], fields)).toEqual({
      Name: "name",
      EMAIL: "email",
      "Next follow-up": null,
      Value: "value",
      Stage: "stage",
      id: null,
      Created: null,
    });
  });

  test("mappable fields exclude system and read-only fields", () => {
    const names = lib.targets(fields).map((f) => f.name);
    expect(names).toContain("name");
    expect(names).not.toContain("id");
    expect(names).not.toContain("createdAt");
    expect(names).not.toContain("secret");
  });

  test("request body for dry-run and commit", () => {
    expect(lib.body("a,b\n1,2", { a: "name", b: null }, true)).toEqual({ csv: "a,b\n1,2", mapping: { a: "name", b: null }, dryRun: true });
    expect(lib.body("a\n1", { a: "name" }, false)).toEqual({ csv: "a\n1", mapping: { a: "name" }, dryRun: false });
  });

  test("a field mapped twice is reported before sending", () => {
    expect(lib.duplicates({ a: "name", b: "name", c: null, d: "email" })).toEqual(["name"]);
  });

  test("report summary and per-row lines", () => {
    const r = lib.summary({ dryRun: true, total: 3, valid: 2, invalid: 1, columns: { Name: "name" }, ignored: ["X"], errors: [{ row: 2, errors: [{ field: "email", message: "must be an email" }] }] });
    expect(r.title).toBe("2 of 3 rows are valid; 1 has errors. Nothing was written.");
    expect(r.canCommit).toBe(false);
    expect(r.rows).toEqual([{ row: 2, text: "email: must be an email" }]);
    expect(lib.summary({ dryRun: true, total: 2, valid: 2, invalid: 0, columns: {}, ignored: [], errors: [] }).canCommit).toBe(true);
    expect(lib.summary({ dryRun: false, total: 2, valid: 2, invalid: 0, columns: {}, ignored: [], errors: [], imported: 2 }).title).toBe("Imported 2 rows.");
  });
});

describe("calendar month grid", () => {
  test("parseMonth accepts YYYY-MM and falls back to the given date", () => {
    expect(parseMonth("2026-03", new Date(Date.UTC(2020, 0, 1)))).toEqual({ year: 2026, month: 3 });
    expect(parseMonth("2026-13", new Date(Date.UTC(2020, 4, 9)))).toEqual({ year: 2020, month: 5 });
    expect(parseMonth(undefined, new Date(Date.UTC(2020, 4, 9)))).toEqual({ year: 2020, month: 5 });
  });

  test("weeks start on Monday and cover the whole month", () => {
    const g = monthGrid(2026, 3);
    expect(g.length).toBe(6);
    expect(g[0][0]).toEqual({ date: "2026-02-23", inMonth: false });
    expect(g[0][6]).toEqual({ date: "2026-03-01", inMonth: true });
    expect(g[5][1]).toEqual({ date: "2026-03-31", inMonth: true });
    expect(g.every((w) => w.length === 7)).toBe(true);
  });

  test("range, prev and next months", () => {
    expect(monthRange(2026, 12)).toEqual({ first: "2026-12-01", last: "2026-12-31", prev: "2026-11", next: "2027-01", label: "December 2026" });
    expect(monthRange(2026, 1).prev).toBe("2025-12");
  });
});
