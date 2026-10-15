// Laravel encryption and sessions.
//
// Test vectors: every ciphertext the WebCrypto code reads is produced by test/reference/laravel.ts,
// an independent node:crypto (OpenSSL) port of Laravel's Encrypter written from the PHP source,
// and every ciphertext the WebCrypto code writes is opened by that reference. The pinned vector
// below was printed once by the reference with:
//   APP_KEY = "base64:" + base64(bytes 0x00..0x1f), iv = bytes 0x10..0x1f, encrypt("hello") (serialize = true)
// so a change to either implementation that drifts from Laravel's format shows up as a mismatch.
// "login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d" is the widely published value of
// 'login_web_'.sha1(Illuminate\Auth\SessionGuard::class) and matches the reference's sha1.

import { describe, expect, test, beforeEach } from "bun:test";
import { miu, route } from "miujs";
import { sqlite, type Database } from "@miujs/db";
import { randomBytes } from "node:crypto";
import {
  laravelCookieDecode,
  laravelCookieEncode,
  laravelDatabaseStore,
  laravelDecrypt,
  laravelEncrypt,
  laravelLoginKey,
  laravelSession,
  parseAppKey,
} from "../src/laravel.ts";
import { phpSerialize, phpUnserialize } from "../src/php.ts";
import { keyBytes, refCookiePrefix, refDecrypt, refEncrypt, refLoginKey } from "./reference/laravel.ts";

const KEY = "base64:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const OTHER_KEY = "base64:" + Buffer.from(randomBytes(32)).toString("base64");
const PINNED =
  "eyJpdiI6IkVCRVNFeFFWRmhjWUdSb2JIQjBlSHc9PSIsInZhbHVlIjoiKzNUVW5TbXpvMWdBV3RrTTFMeVdZZz09IiwibWFjIjoiNzgyYzljYjhkMjNlNWY2ODNkY2VhYTcyYTM2MTUzZDY3Y2M5Y2YxZjdiODVhMWQ2YmU3NGY5OGEzM2JhNzY5OSIsInRhZyI6IiJ9";
const LOGIN_KEY = "login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

describe("parseAppKey", () => {
  test("base64: keys and raw 32-byte keys", () => {
    expect([...parseAppKey(KEY)]).toEqual([...keyBytes(KEY)]);
    expect(parseAppKey("a".repeat(32)).length).toBe(32);
  });
  test("rejects keys of the wrong size or format", () => {
    for (const bad of ["", "base64:", "base64:!!!", "base64:" + Buffer.alloc(10).toString("base64"), "short"]) {
      expect(() => parseAppKey(bad)).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_APP_KEY" }));
    }
  });
  test("the error never echoes the key", () => {
    try {
      parseAppKey("base64:c2VjcmV0LWtleS10aGF0LWlzLXRvby1zaG9ydA==");
    } catch (e) {
      expect(JSON.stringify((e as { toJSON(): unknown }).toJSON())).not.toContain("c2VjcmV0");
    }
  });
});

describe("laravelDecrypt / laravelEncrypt", () => {
  test("decrypts the pinned vector", async () => {
    expect(await laravelDecrypt(PINNED, KEY)).toBe("hello");
    expect(await laravelDecrypt(PINNED, KEY, { unserialize: false })).toBe('s:5:"hello";');
  });

  test("decrypts what the reference encrypts (CBC-256, CBC-128, GCM, escaped slashes)", async () => {
    for (let n = 0; n < 20; n++) {
      const text = `value-${n}-${"é".repeat(n)}-${"x".repeat(n * 7)}`;
      expect(await laravelDecrypt(refEncrypt(text, KEY, randomBytes(16)), KEY)).toBe(text);
      expect(await laravelDecrypt(refEncrypt(text, KEY, randomBytes(16), { serialize: false, escapeSlashes: true }), KEY, { unserialize: false })).toBe(text);
    }
    const k128 = "base64:" + Buffer.from(randomBytes(16)).toString("base64");
    expect(await laravelDecrypt(refEncrypt("short key", k128, randomBytes(16), { cipher: "aes-128-cbc" }), k128, { cipher: "aes-128-cbc" })).toBe("short key");
    expect(await laravelDecrypt(refEncrypt("gcm", KEY, randomBytes(12), { cipher: "aes-256-gcm" }), KEY, { cipher: "aes-256-gcm" })).toBe("gcm");
  });

  test("the reference decrypts what we encrypt", async () => {
    for (const text of ["", "hello", "héllo wörld", "x".repeat(1000)]) {
      expect(refDecrypt(await laravelEncrypt(text, KEY), KEY)).toBe(`s:${Buffer.byteLength(text)}:"${text}";`);
      expect(refDecrypt(await laravelEncrypt(text, KEY, { serialize: false }), KEY)).toBe(text);
    }
    expect(refDecrypt(await laravelEncrypt("g", KEY, { serialize: false, cipher: "aes-256-gcm" }), KEY, "aes-256-gcm")).toBe("g");
  });

  test("uses a fresh IV each time", async () => {
    expect(await laravelEncrypt("same", KEY)).not.toBe(await laravelEncrypt("same", KEY));
  });

  test("previous keys still decrypt (APP_PREVIOUS_KEYS)", async () => {
    const old = refEncrypt("rotated", OTHER_KEY, randomBytes(16));
    expect(await laravelDecrypt(old, [KEY, OTHER_KEY])).toBe("rotated");
  });

  describe("rejects", () => {
    const decodeJson = (p: string) => JSON.parse(Buffer.from(p, "base64").toString());
    const encodeJson = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

    test("a wrong key", async () => {
      expect(await code(laravelDecrypt(PINNED, OTHER_KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
    });
    test("a tampered MAC, value or IV", async () => {
      const p = decodeJson(PINNED);
      const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
      expect(await code(laravelDecrypt(encodeJson({ ...p, mac: flip(p.mac) }), KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
      expect(await code(laravelDecrypt(encodeJson({ ...p, value: flip(p.value) }), KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
      expect(await code(laravelDecrypt(encodeJson({ ...p, iv: flip(p.iv) }), KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
    });
    test("a missing MAC (no downgrade to unauthenticated CBC)", async () => {
      const p = decodeJson(PINNED);
      expect(await code(laravelDecrypt(encodeJson({ ...p, mac: "" }), KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
      expect(await code(laravelDecrypt(encodeJson({ iv: p.iv, value: p.value }), KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
    });
    test("a tampered GCM tag", async () => {
      const p = decodeJson(refEncrypt("gcm", KEY, randomBytes(12), { cipher: "aes-256-gcm" }));
      const bad = encodeJson({ ...p, tag: Buffer.alloc(16).toString("base64") });
      expect(await code(laravelDecrypt(bad, KEY, { cipher: "aes-256-gcm" }))).toBe("MIU_E_MIGRATE_DECRYPT");
    });
    test("garbage, wrong IV length and non-objects", async () => {
      const p = decodeJson(PINNED);
      for (const bad of ["", "%%%", Buffer.from("[1,2]").toString("base64"), Buffer.from("null").toString("base64"), encodeJson({ ...p, iv: Buffer.alloc(8).toString("base64") })]) {
        expect(await code(laravelDecrypt(bad, KEY))).toBe("MIU_E_MIGRATE_DECRYPT");
      }
    });
    test("a serialized class object in the plaintext", async () => {
      const payload = refEncrypt("x", KEY, randomBytes(16), { serialize: false }).toString();
      expect(await laravelDecrypt(payload, KEY, { unserialize: false })).toBe("x");
      const evil = Buffer.from(JSON.stringify(decodeJson(payload))).toString("base64");
      expect(await laravelDecrypt(evil, KEY, { unserialize: false })).toBe("x");
      const gadget = await laravelEncrypt('O:3:"Foo":0:{}', KEY, { serialize: false });
      expect(await code(laravelDecrypt(gadget, KEY))).toBe("MIU_E_MIGRATE_PHP_CLASS");
    });
  });
});

describe("cookie value prefix (Laravel 8+)", () => {
  test("matches the reference", async () => {
    const id = "A".repeat(40);
    const cookie = await laravelCookieEncode("laravel_session", id, KEY);
    expect(refDecrypt(cookie, KEY)).toBe(refCookiePrefix("laravel_session", KEY) + id);
    expect(refCookiePrefix("laravel_session", KEY)).toBe("7198b0a1a7564e003b468667d6241918ce65aafa|");
    const theirs = refEncrypt(refCookiePrefix("laravel_session", KEY) + id, KEY, randomBytes(16), { serialize: false });
    expect(await laravelCookieDecode("laravel_session", theirs, KEY)).toBe(id);
  });
  test("a value encrypted for another cookie name is refused (cookie swapping)", async () => {
    const other = refEncrypt(refCookiePrefix("XSRF-TOKEN", KEY) + "A".repeat(40), KEY, randomBytes(16), { serialize: false });
    expect(await laravelCookieDecode("laravel_session", other, KEY)).toBeNull();
  });
  test("an unprefixed value is refused unless prefix: false (Laravel < 8)", async () => {
    const legacy = refEncrypt("A".repeat(40), KEY, randomBytes(16), { serialize: false });
    expect(await laravelCookieDecode("laravel_session", legacy, KEY)).toBeNull();
    expect(await laravelCookieDecode("laravel_session", legacy, KEY, { prefix: false })).toBe("A".repeat(40));
  });
  test("garbage returns null instead of throwing", async () => {
    expect(await laravelCookieDecode("laravel_session", "nope", KEY)).toBeNull();
  });
});

test("laravelLoginKey", async () => {
  expect(await laravelLoginKey()).toBe(LOGIN_KEY);
  expect(await laravelLoginKey()).toBe(refLoginKey());
  expect(await laravelLoginKey("admin")).toBe(refLoginKey("admin"));
});

// --- sessions -------------------------------------------------------------------------------

const SESSIONS_TABLE = `CREATE TABLE sessions (
  id varchar(255) NOT NULL PRIMARY KEY,
  user_id integer NULL,
  ip_address varchar(45) NULL,
  user_agent text NULL,
  payload text NOT NULL,
  last_activity integer NOT NULL
)`;

const SID = "Abcdefghij0123456789Abcdefghij0123456789";

async function seed(db: Database, id: string, data: unknown, lastActivity = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(typeof data === "string" ? data : phpSerialize(data)).toString("base64");
  await db.prepare("INSERT INTO sessions (id, user_id, ip_address, user_agent, payload, last_activity) VALUES (?, ?, ?, ?, ?, ?)").bind(id, null, "127.0.0.1", "test", payload, lastActivity).run();
}

/** The cookie header the old Laravel app would have set. */
function laravelCookie(id: string, key = KEY, name = "laravel_session") {
  return `${name}=${encodeURIComponent(refEncrypt(refCookiePrefix(name, key) + id, key, randomBytes(16), { serialize: false }))}`;
}

describe("laravelSession", () => {
  let db: Database;
  beforeEach(async () => {
    db = sqlite(":memory:");
    await db.exec(SESSIONS_TABLE);
  });

  function app(source: ReturnType<typeof laravelSession>) {
    return miu({
      logLevel: "silent",
      routes: [
        route.get("/who", { handler: async (ctx) => (await source.read(ctx)) ?? { none: true } }),
        route.post("/login", { handler: async (ctx) => source.login(ctx, 42) }),
        route.post("/logout", { handler: async (ctx) => (await source.logout(ctx), "ok") }),
      ],
    });
  }

  test("reads the old app's session and its logged-in user", async () => {
    await seed(db, SID, { _token: "t".repeat(40), [LOGIN_KEY]: 7, _flash: { old: [], new: [] } });
    const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
    const res = await app(src).request("/who", { headers: { cookie: laravelCookie(SID) } });
    const body = await res.json();
    expect(body.id).toBe(SID);
    expect(body.userId).toBe("7");
    expect(body.data._token).toBe("t".repeat(40));
  });

  test("custom guard names", async () => {
    await seed(db, SID, { [refLoginKey("admin")]: 3 });
    const src = laravelSession({ appKey: KEY, guard: "admin", store: laravelDatabaseStore(db) });
    expect((await (await app(src).request("/who", { headers: { cookie: laravelCookie(SID) } })).json()).userId).toBe("3");
  });

  test("JSON-serialized sessions (session.serialization = json)", async () => {
    await seed(db, SID, JSON.stringify({ [LOGIN_KEY]: 9 }));
    const src = laravelSession({ appKey: KEY, serialization: "json", store: laravelDatabaseStore(db) });
    expect((await (await app(src).request("/who", { headers: { cookie: laravelCookie(SID) } })).json()).userId).toBe("9");
  });

  test("encrypted session payloads (session.encrypt = true)", async () => {
    const inner = phpSerialize({ [LOGIN_KEY]: 5 });
    await seed(db, SID, refEncrypt(inner, KEY, randomBytes(16)));
    const src = laravelSession({ appKey: KEY, encrypt: true, store: laravelDatabaseStore(db) });
    expect((await (await app(src).request("/who", { headers: { cookie: laravelCookie(SID) } })).json()).userId).toBe("5");
  });

  describe("no session when", () => {
    const none = async (src: ReturnType<typeof laravelSession>, cookie: string) => (await (await app(src).request("/who", { headers: { cookie } })).json()).none;
    test("there is no cookie or it is not encrypted with our key", async () => {
      await seed(db, SID, { [LOGIN_KEY]: 7 });
      const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
      expect(await none(src, "")).toBe(true);
      expect(await none(src, `laravel_session=${SID}`)).toBe(true);
      expect(await none(src, laravelCookie(SID, OTHER_KEY))).toBe(true);
    });
    test("the session expired (last_activity older than lifetime)", async () => {
      await seed(db, SID, { [LOGIN_KEY]: 7 }, Math.floor(Date.now() / 1000) - 121 * 60);
      const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
      expect(await none(src, laravelCookie(SID))).toBe(true);
      const longer = laravelSession({ appKey: KEY, lifetime: 180, store: laravelDatabaseStore(db) });
      expect(await none(longer, laravelCookie(SID))).toBeUndefined();
    });
    test("the decrypted id is not a Laravel id (never reaches the store)", async () => {
      const seen: string[] = [];
      const store = { kind: "spy", async read(id: string) { seen.push(id); return null; }, async write() {}, async destroy() {} };
      const src = laravelSession({ appKey: KEY, store });
      await none(src, laravelCookie("' OR 1=1 --"));
      await none(src, laravelCookie("short"));
      expect(seen).toEqual([]);
    });
    test("the payload holds a class object", async () => {
      await seed(db, SID, `a:2:{s:${LOGIN_KEY.length}:"${LOGIN_KEY}";i:7;s:6:"errors";O:31:"Illuminate\\Support\\ViewErrorBag":0:{}}`);
      const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
      expect(await none(src, laravelCookie(SID))).toBe(true);
      const inert = laravelSession({ appKey: KEY, phpClasses: "inert", store: laravelDatabaseStore(db) });
      expect(await none(inert, laravelCookie(SID))).toBeUndefined();
    });
  });

  test("login writes a session both apps accept", async () => {
    const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
    const res = await app(src).request("/login", { method: "POST" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("laravel_session="))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    const value = decodeURIComponent(setCookie.split(";")[0].slice("laravel_session=".length));
    // The old app's EncryptCookies middleware can open it...
    const plain = refDecrypt(value, KEY);
    expect(plain.startsWith(refCookiePrefix("laravel_session", KEY))).toBe(true);
    const id = plain.split("|")[1];
    expect(id).toMatch(/^[A-Za-z0-9]{40}$/);
    // ...and the row is what Laravel's DatabaseSessionHandler reads.
    const row = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row!.user_id).toBe(42);
    const data = phpUnserialize(Buffer.from(String(row!.payload), "base64")) as Record<string, unknown>;
    expect(data[LOGIN_KEY]).toBe(42);
    expect(String(data._token)).toMatch(/^[A-Za-z0-9]{40}$/);
    // And MiuJS reads it back.
    const who = await (await app(src).request("/who", { headers: { cookie: `laravel_session=${encodeURIComponent(value)}` } })).json();
    expect(who.userId).toBe("42");
  });

  test("login replaces an existing session id (no fixation) and keeps its data", async () => {
    await seed(db, SID, { cart: [1, 2] });
    const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
    const res = await app(src).request("/login", { method: "POST", headers: { cookie: laravelCookie(SID) } });
    const body = await res.json();
    expect(body.id).not.toBe(SID);
    expect(body.data.cart).toEqual([1, 2]);
    expect(await db.prepare("SELECT id FROM sessions WHERE id = ?").bind(SID).first()).toBeNull();
  });

  test("logout destroys the row and expires the cookie", async () => {
    await seed(db, SID, { [LOGIN_KEY]: 7 });
    const src = laravelSession({ appKey: KEY, store: laravelDatabaseStore(db) });
    const res = await app(src).request("/logout", { method: "POST", headers: { cookie: laravelCookie(SID) } });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("laravel_session=;") && /Max-Age=0/.test(c))).toBe(true);
    expect(await db.prepare("SELECT id FROM sessions WHERE id = ?").bind(SID).first()).toBeNull();
  });

  test("inspect never shows the key", () => {
    const src = laravelSession({ appKey: KEY, previousKeys: [OTHER_KEY], store: laravelDatabaseStore(db) });
    const shown = JSON.stringify(src.inspect());
    expect(shown).not.toContain(KEY.slice(7, 20));
    expect(shown).not.toContain(OTHER_KEY.slice(7, 20));
    expect(shown).toContain("laravel_session");
  });

  test("a bad table name is a config error, not SQL", () => {
    expect(() => laravelDatabaseStore(db, { table: "sessions; DROP TABLE users" })).toThrow(expect.objectContaining({ code: "MIU_E_MIGRATE_CONFIG" }));
  });
});
