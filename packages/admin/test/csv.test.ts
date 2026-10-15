import { describe, expect, test } from "bun:test";
import { csvCell, csvRow, parseCsv } from "../src/csv.ts";

describe("csvCell", () => {
  test("quotes commas, quotes and newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("cr\r")).toBe('"cr\r"');
    expect(csvCell(null)).toBe("");
  });

  test("formula injection: = + - @ (and tab/CR) get a leading quote", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
    expect(csvCell("a=b")).toBe("a=b");
  });

  test("numbers are never prefixed", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("-5", { numeric: true })).toBe("-5");
  });

  test("csvRow joins with commas and CRLF", () => {
    expect(csvRow(["a", "b,c", null])).toBe('a,"b,c",\r\n');
  });
});

describe("parseCsv", () => {
  test("RFC 4180: quotes, escaped quotes, embedded newlines, CRLF and LF, BOM", () => {
    expect(parseCsv('﻿name,notes\r\n"Lee, Ann","said ""hi""\nthen left"\nBen,\n')).toEqual([
      ["name", "notes"],
      ["Lee, Ann", 'said "hi"\nthen left'],
      ["Ben", ""],
    ]);
  });

  test("skips blank lines; keeps trailing empty cells", () => {
    expect(parseCsv("a,b\n\n1,\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  test("round trips through csvRow", () => {
    const rows = [["x", 'q"uote', "multi\nline", "c,omma"]];
    expect(parseCsv(rows.map((r) => csvRow(r)).join(""))).toEqual(rows);
  });

  test("unterminated quote is an error", () => {
    expect(() => parseCsv('a\n"open')).toThrow(/quote/);
  });
});
