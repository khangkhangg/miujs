import { describe, expect, test } from "bun:test";
import { cleanFilename, contentDisposition, etagMatches, inlineSafe, parseRange } from "../src/http.ts";

describe("http helpers", () => {
  test("parseRange", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=0-0", 10)).toEqual({ offset: 0, length: 1 });
    expect(parseRange("bytes=9-", 10)).toEqual({ offset: 9, length: 1 });
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-", 10)).toBeNull();
    expect(parseRange("bytes=99999999999999999999-", 10)).toBeNull();
  });

  test("cleanFilename strips paths, quotes and control characters", () => {
    expect(cleanFilename('..\\..\\evil"\r\n.png')).toBe("evil.png");
    expect(cleanFilename("/etc/passwd")).toBe("passwd");
    expect(cleanFilename("\u0000")).toBe("download");
    expect(cleanFilename("a".repeat(500)).length).toBe(200);
  });

  test("contentDisposition never lets a name break out of the header", () => {
    const cd = contentDisposition('x"; filename="evil.html\r\nSet-Cookie: a=b');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd.match(/"/g)!.length).toBe(2);
    expect(contentDisposition(undefined)).toBe("attachment");
  });

  test("etagMatches", () => {
    expect(etagMatches('"a"', "a")).toBe(true);
    expect(etagMatches('W/"a"', "a")).toBe(true);
    expect(etagMatches('"b", "a"', "a")).toBe(true);
    expect(etagMatches('"b"', "a")).toBe(false);
    expect(etagMatches("a", "a")).toBe(false);
  });

  test("inlineSafe", () => {
    for (const t of ["image/png", "video/mp4", "application/pdf", "text/plain; charset=utf-8"]) expect(inlineSafe(t)).toBe(true);
    for (const t of ["text/html", "image/svg+xml", "application/javascript", "application/xhtml+xml", "text/xml", ""]) expect(inlineSafe(t)).toBe(false);
  });
});
