import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { decodePhpSession, phpSessionBridge, serializePhp, unserializePhp } from "../../src/migrate/php-session.ts";

// Fixtures generated with PHP 8.3 serialize() / session_encode().
describe("unserializePhp", () => {
  test("scalars", () => {
    expect(unserializePhp("N;")).toBe(null);
    expect(unserializePhp("b:1;")).toBe(true);
    expect(unserializePhp("b:0;")).toBe(false);
    expect(unserializePhp("i:-42;")).toBe(-42);
    expect(unserializePhp("d:0.1;")).toBe(0.1);
    expect(unserializePhp("d:1.0E+20;")).toBe(1e20);
    expect(unserializePhp("d:INF;")).toBe(Infinity);
    expect(unserializePhp("d:-INF;")).toBe(-Infinity);
    expect(unserializePhp("d:NAN;")).toBeNaN();
    expect(unserializePhp('s:7:"a;b|c"d";')).toBe('a;b|c"d');
  });

  test("strings use UTF-8 byte lengths", () => {
    expect(unserializePhp('s:6:"héllo";')).toBe("héllo");
    expect(unserializePhp('s:4:"🐱";')).toBe("🐱");
  });

  test("arrays become objects, or JS arrays when keys are 0..n-1", () => {
    const s = 'a:6:{s:1:"a";i:1;s:1:"b";a:4:{i:0;b:1;i:1;N;i:2;d:1.5;i:3;s:6:"héllo";}i:3;s:1:"x";s:3:"neg";i:-42;s:1:"f";d:0.1;s:1:"e";d:1.0E+20;}';
    expect(unserializePhp(s)).toEqual({ a: 1, b: [true, null, 1.5, "héllo"], 3: "x", neg: -42, f: 0.1, e: 1e20 });
    expect(unserializePhp('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')).toEqual(["a", "b"]);
    expect(unserializePhp("a:0:{}")).toEqual([]);
  });

  test("objects become plain objects with __class; visibility prefixes are stripped", () => {
    const s = 'O:4:"User":3:{s:4:"name";s:3:"ann";s:7:"\0*\0role";s:5:"admin";s:8:"\0User\0id";i:7;}';
    expect(unserializePhp(s)).toEqual({ __class: "User", name: "ann", role: "admin", id: 7 });
  });

  test("references and enums", () => {
    expect(unserializePhp('a:2:{i:0;s:1:"x";i:1;R:2;}')).toEqual(["x", "x"]);
    expect(unserializePhp('E:11:"Suit:Hearts";')).toBe("Suit:Hearts");
  });

  test("malformed input throws", () => {
    for (const bad of ["", "x:1;", 's:5:"abc";', "a:1:{i:0;i:1;", "i:1"]) expect(() => unserializePhp(bad)).toThrow();
  });
});

describe("serializePhp", () => {
  test("round-trips and matches PHP output", () => {
    expect(serializePhp(null)).toBe("N;");
    expect(serializePhp(true)).toBe("b:1;");
    expect(serializePhp(42)).toBe("i:42;");
    expect(serializePhp(1.5)).toBe("d:1.5;");
    expect(serializePhp("héllo")).toBe('s:6:"héllo";');
    expect(serializePhp(["a", "b"])).toBe('a:2:{i:0;s:1:"a";i:1;s:1:"b";}');
    expect(serializePhp({ user_id: 42, name: "Zoë" })).toBe('a:2:{s:7:"user_id";i:42;s:4:"name";s:4:"Zoë";}');
    expect(serializePhp({ 3: "x" })).toBe('a:1:{i:3;s:1:"x";}');
    const v = { a: [1, { b: null }], s: "x;y" };
    expect(unserializePhp(serializePhp(v))).toEqual(v);
  });
});

describe("decodePhpSession", () => {
  test("default php handler", () => {
    const data = 'user_id|i:42;name|s:4:"Zoë";cart|a:1:{s:5:"items";a:2:{i:0;i:1;i:1;i:2;}}flag|b:0;';
    expect(decodePhpSession(data)).toEqual({ user_id: 42, name: "Zoë", cart: { items: [1, 2] }, flag: false });
  });

  test("php_serialize handler is auto-detected", () => {
    expect(decodePhpSession('a:2:{s:7:"user_id";i:42;s:4:"name";s:4:"Zoë";}')).toEqual({ user_id: 42, name: "Zoë" });
    expect(decodePhpSession('a:1:{s:1:"k";i:1;}', "php_serialize")).toEqual({ k: 1 });
  });

  test("empty session", () => {
    expect(decodePhpSession("")).toEqual({});
  });
});

describe("phpSessionBridge", () => {
  const store: Record<string, string> = { abc123: 'user_id|i:42;name|s:4:"Zoë";' };
  const app = new Miu({ logger: false });
  const seen: string[] = [];
  app.use(phpSessionBridge({ read: async (id) => (seen.push(id), store[id]) }));
  app.get("/me", (c) => ({ session: c.get("legacySession") ?? null }));

  test("loads the legacy session by PHPSESSID cookie", async () => {
    const res = await app.request("/me", { headers: { cookie: "PHPSESSID=abc123" } });
    expect(await res.json()).toEqual({ session: { user_id: 42, name: "Zoë" } });
  });

  test("missing cookie or unknown id leaves it unset", async () => {
    expect(await (await app.request("/me")).json()).toEqual({ session: null });
    expect(await (await app.request("/me", { headers: { cookie: "PHPSESSID=nope" } })).json()).toEqual({ session: null });
  });

  test("ignores ids with path characters", async () => {
    seen.length = 0;
    await app.request("/me", { headers: { cookie: "PHPSESSID=../../etc/passwd" } });
    expect(seen).toEqual([]);
  });

  test("custom cookie name (e.g. Laravel-style)", async () => {
    const a2 = new Miu({ logger: false });
    a2.use(phpSessionBridge({ cookieName: "legacy", read: async () => 'a:1:{s:1:"k";i:1;}' }));
    a2.get("/", (c) => c.get("legacySession"));
    expect(await (await a2.request("/", { headers: { cookie: "legacy=zzz" } })).json()).toEqual({ k: 1 });
  });
});
