// Django signing and sessions.
//
// Test vectors come from test/reference/django.ts, an independent node:crypto + node:zlib port of
// django.core.signing written from the Python source. The pinned vectors below were printed once
// by that reference with SECRET_KEY "django-insecure-test-secret-key-0123456789" and
// timestamp 1760000000 (base62 "1v6mOm"):
//   PINNED_SESSION = dumps({_auth_user_id: "1", _auth_user_backend: "...ModelBackend", _auth_user_hash: "abc"},
//                          salt="django.contrib.sessions.SessionStore", compress=True)
//   PINNED_PLAIN   = dumps({a: "é"})   (default salt, no compression; shows ensure_ascii escaping)

import { beforeEach, describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { sqlite, type Database } from "@miujs/db";
import {
  djangoDatabaseStore,
  djangoSession,
  djangoSessionAuthHash,
  djangoSignedCookieStore,
  djangoSigningDumps,
  djangoSigningLoads,
} from "../src/django.ts";
import { b62Encode, refDumps, refLoads, refSessionAuthHash } from "./reference/django.ts";

const SECRET = "django-insecure-test-secret-key-0123456789";
const OTHER = "another-secret-key-another-secret-key-xx";
const SALT = "django.contrib.sessions.SessionStore";
const PINNED_SESSION =
  ".eJyrVopPLC3JiC8tTi2Kz0xRslIyVNJBFktKTM5OzQNJpGQl5qXn6yXn55UUZSbpgZToQWWL9XzzU1JznKBqUQzISCzOULJSSkxKVqoFAI5xJ3M:1v6mOm:9yjZIBZ0T62vW3pxOgYbGhJTZHC2-YpAwZ7ADMnnvkw";
const PINNED_PLAIN = "eyJhIjoiXHUwMGU5In0:1v6mOm:om-ThRcOaobLJgr4pmhZb7rnj9UZdtOr-zANnrcz0is";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

describe("django signing", () => {
  test("loads the pinned vectors", async () => {
    expect(await djangoSigningLoads(PINNED_SESSION, { secretKey: SECRET, salt: SALT })).toEqual({
      _auth_user_id: "1",
      _auth_user_backend: "django.contrib.auth.backends.ModelBackend",
      _auth_user_hash: "abc",
    });
    expect(await djangoSigningLoads(PINNED_PLAIN, { secretKey: SECRET })).toEqual({ a: "é" });
  });

  test("loads what the reference dumps, compressed or not", async () => {
    for (let n = 0; n < 10; n++) {
      const obj = { n, text: "x".repeat(n * 50), list: Array.from({ length: n }, (_, i) => i), uni: "日本" };
      expect(await djangoSigningLoads(refDumps(obj, SECRET, { salt: SALT, compress: true }), { secretKey: SECRET, salt: SALT })).toEqual(obj);
      expect(await djangoSigningLoads(refDumps(obj, SECRET), { secretKey: SECRET })).toEqual(obj);
    }
  });

  test("the reference loads what we dump", async () => {
    const obj = { _auth_user_id: "42", big: "y".repeat(500), uni: "é" };
    expect(refLoads(await djangoSigningDumps(obj, { secretKey: SECRET, salt: SALT, compress: true }), SECRET, SALT)).toEqual(obj);
    expect(refLoads(await djangoSigningDumps(obj, { secretKey: SECRET }), SECRET)).toEqual(obj);
    const fixed = await djangoSigningDumps({ a: "é" }, { secretKey: SECRET, timestamp: 1760000000 });
    expect(fixed).toBe(PINNED_PLAIN);
  });

  test("base62 timestamps", () => {
    expect(b62Encode(1760000000)).toBe("1v6mOm");
  });

  test("SECRET_KEY_FALLBACKS still verify", async () => {
    expect(await djangoSigningLoads(refDumps({ a: 1 }, OTHER), { secretKey: [SECRET, OTHER] })).toEqual({ a: 1 });
  });

  test("legacy sha1 signatures when asked", async () => {
    const s = refDumps({ a: 1 }, SECRET, { algorithm: "sha1" });
    expect(await code(djangoSigningLoads(s, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
    expect(await djangoSigningLoads(s, { secretKey: SECRET, algorithm: "sha1" })).toEqual({ a: 1 });
  });

  describe("rejects", () => {
    test("a wrong key or salt", async () => {
      expect(await code(djangoSigningLoads(PINNED_SESSION, { secretKey: OTHER, salt: SALT }))).toBe("MIU_E_MIGRATE_SIGNATURE");
      expect(await code(djangoSigningLoads(PINNED_SESSION, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
    });
    test("tampered data, timestamp or signature", async () => {
      const [data, ts, sig] = PINNED_PLAIN.split(":");
      expect(await code(djangoSigningLoads(`eyJhIjoiYiJ9:${ts}:${sig}`, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
      expect(await code(djangoSigningLoads(`${data}:1v6mOn:${sig}`, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
      expect(await code(djangoSigningLoads(`${data}:${ts}:${sig.slice(0, -1)}A`, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
    });
    test("garbage", async () => {
      for (const bad of ["", "abc", "a:b", ":::", "!!:1v6mOm:sig"]) expect(await code(djangoSigningLoads(bad, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
    });
    test("expired signatures with maxAge", async () => {
      const old = refDumps({ a: 1 }, SECRET, { timestamp: Math.floor(Date.now() / 1000) - 100 });
      expect(await djangoSigningLoads(old, { secretKey: SECRET, maxAge: 200 })).toEqual({ a: 1 });
      expect(await code(djangoSigningLoads(old, { secretKey: SECRET, maxAge: 50 }))).toBe("MIU_E_MIGRATE_SIGNATURE_EXPIRED");
    });
    test("a decompression bomb", async () => {
      const bomb = refDumps({ x: "a".repeat(3_000_000) }, SECRET, { compress: true });
      expect(bomb.length).toBeLessThan(10_000);
      expect(await code(djangoSigningLoads(bomb, { secretKey: SECRET }))).toBe("MIU_E_MIGRATE_SIGNATURE");
      expect(await djangoSigningLoads(bomb, { secretKey: SECRET, maxSize: 4_000_000 })).toEqual({ x: "a".repeat(3_000_000) });
    });
  });

  test("session auth hash matches Django's get_session_auth_hash", async () => {
    const pw = "pbkdf2_sha256$600000$salt$hash=";
    expect(await djangoSessionAuthHash(pw, SECRET)).toBe(refSessionAuthHash(pw, SECRET));
  });

  test("a short secret key is a config error", async () => {
    expect(() => djangoSession({ secretKey: "", store: djangoSignedCookieStore() })).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_SECRET_KEY" }));
  });
});

// --- sessions -------------------------------------------------------------------------------

const TABLE = `CREATE TABLE django_session (session_key varchar(40) NOT NULL PRIMARY KEY, session_data text NOT NULL, expire_date datetime NOT NULL)`;
const KEY = "abcdefghijklmnopqrstuvwxyz012345";
const PW = "pbkdf2_sha256$600000$s4lt$aGFzaA==";

function djangoDate(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "000");
}

describe("djangoSession", () => {
  let db: Database;
  beforeEach(async () => {
    db = sqlite(":memory:");
    await db.exec(TABLE);
  });

  async function seed(key: string, data: unknown, expires = new Date(Date.now() + 3600_000), secret = SECRET) {
    await db.prepare("INSERT INTO django_session VALUES (?, ?, ?)").bind(key, refDumps(data, secret, { salt: SALT, compress: true }), djangoDate(expires)).run();
  }

  function app(source: ReturnType<typeof djangoSession>) {
    return miu({
      logLevel: "silent",
      routes: [
        route.get("/who", { handler: async (ctx) => (await source.read(ctx)) ?? { none: true } }),
        route.post("/login", { handler: async (ctx) => source.login(ctx, 42, { passwordHash: PW }) }),
        route.post("/logout", { handler: async (ctx) => (await source.logout(ctx), "ok") }),
      ],
    });
  }
  const who = async (src: ReturnType<typeof djangoSession>, cookie: string) => (await app(src).request("/who", { headers: { cookie } })).json();

  test("reads _auth_user_id from django_session", async () => {
    await seed(KEY, { _auth_user_id: "7", _auth_user_backend: "django.contrib.auth.backends.ModelBackend", _auth_user_hash: refSessionAuthHash(PW, SECRET) });
    const src = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db) });
    const body = await who(src, `sessionid=${KEY}`);
    expect(body.userId).toBe("7");
    expect(body.id).toBe(KEY);
  });

  test("checks _auth_user_hash when given the user's password hash", async () => {
    await seed(KEY, { _auth_user_id: "7", _auth_user_hash: refSessionAuthHash(PW, SECRET) });
    const ok = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db), passwordHashFor: async (id) => (id === "7" ? PW : null) });
    expect((await who(ok, `sessionid=${KEY}`)).userId).toBe("7");
    // The password changed since login: Django would log the user out, so do we.
    const changed = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db), passwordHashFor: async () => "pbkdf2_sha256$600000$new$bmV3" });
    expect((await who(changed, `sessionid=${KEY}`)).userId).toBeNull();
  });

  describe("no session when", () => {
    test("expired, unknown, signed with another key or a bad key format", async () => {
      await seed(KEY, { _auth_user_id: "7" }, new Date(Date.now() - 1000));
      await seed("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", { _auth_user_id: "8" }, undefined, OTHER);
      const src = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db) });
      expect((await who(src, `sessionid=${KEY}`)).none).toBe(true);
      expect((await who(src, "sessionid=00000000000000000000000000000000")).none).toBe(true);
      expect((await who(src, "sessionid=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).none).toBe(true);
      expect((await who(src, "sessionid=' OR '1'='1")).none).toBe(true);
      expect((await who(src, "")).none).toBe(true);
    });
  });

  test("signed_cookies backend", async () => {
    const value = refDumps({ _auth_user_id: "5" }, SECRET, { salt: "django.contrib.sessions.backends.signed_cookies", compress: true });
    const src = djangoSession({ secretKey: SECRET, store: djangoSignedCookieStore() });
    expect((await who(src, `sessionid=${value}`)).userId).toBe("5");
    const tooOld = refDumps({ _auth_user_id: "5" }, SECRET, { salt: "django.contrib.sessions.backends.signed_cookies", timestamp: Math.floor(Date.now() / 1000) - 1209601 });
    expect((await who(src, `sessionid=${tooOld}`)).none).toBe(true);
  });

  test("signed_cookies login sets the signed value verbatim (Django does not URL-decode cookies)", async () => {
    const src = djangoSession({ secretKey: SECRET, store: djangoSignedCookieStore() });
    const a = miu({ logLevel: "silent", routes: [route.post("/login", { handler: async (ctx) => new Response((await src.login(ctx, 9, { passwordHash: PW })).userId) })] });
    const res = await a.request("/login", { method: "POST" });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("sessionid="))!;
    const value = cookie.split(";")[0].slice("sessionid=".length);
    expect(value).not.toContain("%");
    expect((refLoads(value, SECRET, "django.contrib.sessions.backends.signed_cookies") as Record<string, string>)._auth_user_id).toBe("9");
    expect(cookie).toContain("HttpOnly");
  });

  test("login writes a row Django accepts", async () => {
    const src = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db) });
    const res = await app(src).request("/login", { method: "POST" });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("sessionid="))!;
    expect(cookie).toContain("HttpOnly");
    const key = cookie.split(";")[0].slice("sessionid=".length);
    expect(key).toMatch(/^[a-z0-9]{32}$/);
    const row = await db.prepare("SELECT * FROM django_session WHERE session_key = ?").bind(key).first<Record<string, string>>();
    const data = refLoads(row!.session_data, SECRET, SALT) as Record<string, string>;
    expect(data._auth_user_id).toBe("42");
    expect(data._auth_user_backend).toBe("django.contrib.auth.backends.ModelBackend");
    expect(data._auth_user_hash).toBe(refSessionAuthHash(PW, SECRET));
    expect(row!.expire_date).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/);
    expect((await who(src, `sessionid=${key}`)).userId).toBe("42");
  });

  test("login without a password hash is refused", async () => {
    const src = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db) });
    const a = miu({ logLevel: "silent", routes: [route.post("/login", { handler: async (ctx) => src.login(ctx, 1) })] });
    const res = await a.request("/login", { method: "POST" });
    expect((await res.json()).error.code).toBe("MIU_E_MIGRATE_CONFIG");
  });

  test("logout deletes the row and expires the cookie", async () => {
    await seed(KEY, { _auth_user_id: "7" });
    const src = djangoSession({ secretKey: SECRET, store: djangoDatabaseStore(db) });
    const res = await app(src).request("/logout", { method: "POST", headers: { cookie: `sessionid=${KEY}` } });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("sessionid=;") && /Max-Age=0/.test(c))).toBe(true);
    expect(await db.prepare("SELECT 1 FROM django_session WHERE session_key = ?").bind(KEY).first()).toBeNull();
  });

  test("inspect never shows the secret", () => {
    const src = djangoSession({ secretKey: SECRET, secretKeyFallbacks: [OTHER], store: djangoDatabaseStore(db) });
    const shown = JSON.stringify(src.inspect());
    expect(shown).not.toContain(SECRET.slice(0, 12));
    expect(shown).not.toContain(OTHER.slice(0, 12));
  });
});
