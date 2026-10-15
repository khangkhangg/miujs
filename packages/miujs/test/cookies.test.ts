import { describe, expect, test } from "bun:test";
import { parseCookies, serializeCookie } from "../src/cookies.ts";

describe("parseCookies", () => {
  test("empty / null header", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  test("parses pairs and trims whitespace", () => {
    expect(parseCookies("a=1; b=2;c=3 ;  d = 4 ")).toEqual({ a: "1", b: "2", c: "3", d: "4" });
  });

  test("first occurrence wins", () => {
    expect(parseCookies("a=1; a=2")).toEqual({ a: "1" });
  });

  test("skips parts without '=' or with empty name", () => {
    expect(parseCookies("flag; =x; a=1")).toEqual({ a: "1" });
  });

  test("keeps '=' inside values", () => {
    expect(parseCookies("tok=a=b==")).toEqual({ tok: "a=b==" });
  });

  test("strips surrounding double quotes", () => {
    expect(parseCookies('a="hello"; b="x')).toEqual({ a: "hello", b: '"x' });
  });

  test("percent-decodes values, including inside quotes", () => {
    expect(parseCookies("n=J%C3%BCrgen%20M; q=%22%3B")).toEqual({ n: "Jürgen M", q: '";' });
    expect(parseCookies('a="x%20y"')).toEqual({ a: "x y" });
  });

  test("malformed percent-encoding returns raw value instead of throwing", () => {
    expect(parseCookies("a=%E0%A4%A; b=ok")).toEqual({ a: "%E0%A4%A", b: "ok" });
  });

  test("empty value", () => {
    expect(parseCookies("a=; b=1")).toEqual({ a: "", b: "1" });
  });
});

describe("serializeCookie", () => {
  test("secure-ish defaults: Path=/, HttpOnly, SameSite=Lax", () => {
    expect(serializeCookie("sid", "abc")).toBe("sid=abc; Path=/; HttpOnly; SameSite=Lax");
  });

  test("encodes the value and round-trips through parseCookies", () => {
    const v = "a b;c=d,é\"";
    const s = serializeCookie("x", v);
    expect(s.startsWith("x=a%20b%3Bc%3Dd%2C%C3%A9%22;")).toBe(true);
    expect(parseCookies(s.split(";")[0])).toEqual({ x: v });
  });

  test("all options in order", () => {
    const expires = new Date(Date.UTC(2030, 0, 2, 3, 4, 5));
    expect(
      serializeCookie("a", "1", {
        maxAge: 60.9,
        expires,
        path: "/app",
        domain: "example.com",
        secure: true,
        httpOnly: false,
        sameSite: "Strict",
      }),
    ).toBe("a=1; Max-Age=60; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Path=/app; Domain=example.com; Secure; SameSite=Strict");
  });

  test("maxAge 0 is emitted (for deleting cookies)", () => {
    expect(serializeCookie("a", "", { maxAge: 0 })).toBe("a=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
  });

  test("httpOnly false omits HttpOnly; secure false omits Secure", () => {
    const s = serializeCookie("a", "1", { httpOnly: false, secure: false, sameSite: "None" });
    expect(s).toBe("a=1; Path=/; SameSite=None");
  });
});
