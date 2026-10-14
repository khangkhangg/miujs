import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import {
  DJANGO_SIGNED_COOKIE_SALT,
  decodeDjangoSessionData,
  djangoSessionBridge,
  djangoSign,
  djangoUnsign,
  signingDumps,
  signingLoads,
} from "../../src/migrate/django-session.ts";

// Generated with real Django 6.1.2 (django.core.signing, SessionStore.encode) at time.time() == NOW.
const SECRET = "django-insecure-test-key-0123456789abcdefghijklmnop";
const NOW = 1760000000;
const DATA = {
  _auth_user_id: "1",
  _auth_user_backend: "django.contrib.auth.backends.ModelBackend",
  _auth_user_hash: "abc",
  name: "Zoë",
};
const BIG = { items: Array(20).fill("x".repeat(50)), user: 1 };
const FX = {
  signedCookieSmall:
    ".eJyrVopPLC3JiC8tTi2Kz0xRslIyVNJBFktKTM5OzQNJpGQl5qXn6yXn55UUZSbpgZToQWWL9XzzU1JznKBqUQzISCzOAOpOTEoGiucl5qYCOVH5MaUGBqlJSrUAg00sww:1v6mOm:GsIvQbizVVr5hG2VFkHwQSaR9WsrxuNO8zon82UxYGo",
  signedCookieBig: ".eJyrVsosSc0tVrKKVqogGSjpjGoa1TSqaaRoitVRKi1OLVKyMqwFAJo45E4:1v6mOm:_rO264zFaIAvHMVki8cko1wv4-GteQqa5ApZy_6vL5k",
  dbSessionData:
    ".eJyrVopPLC3JiC8tTi2Kz0xRslIyVNJBFktKTM5OzQNJpGQl5qXn6yXn55UUZSbpgZToQWWL9XzzU1JznKBqUQzISCzOAOpOTEoGiucl5qYCOVH5MaUGBqlJSrUAg00sww:1v6mOm:3hUZvCuxQeK9YZfquU9i7Pv1yOacREBze8wvtRdtj7E",
  plainDumps: "eyJhIjpbMSwyXX0:1v6mOm:g0hAHNJPR-CDDD-ZwBcGL4MIYjVyrUzNbW-oFT1PZeg",
  otherKey: "eyJhIjoxfQ:1v6mOm:aeOBa7gOnnrLkts1M1dkDCzW-bs3NZW-H3S9ODBiSKA",
  signerSha256: "hello:seQdda0T_1H7JWaVG8EjLDqQCAfJDsn1j2WIH8leJMk",
  signerSha1: "hello:B--cS_XH9ZXUUsyQqDi-JQ9cXcM",
  legacyDb:
    "ODY4YjViY2M2NGUzZDYwZjVlY2JlZDFmYzFiZjUwZmEwNzViYmE2Mjp7Il9hdXRoX3VzZXJfaWQiOiIxIiwiX2F1dGhfdXNlcl9iYWNrZW5kIjoiZGphbmdvLmNvbnRyaWIuYXV0aC5iYWNrZW5kcy5Nb2RlbEJhY2tlbmQiLCJfYXV0aF91c2VyX2hhc2giOiJhYmMiLCJuYW1lIjoiWm9cdTAwZWIifQ==",
};

describe("Signer", () => {
  test("matches django.core.signing.Signer (sha256 and sha1)", async () => {
    expect(await djangoSign("hello", { key: SECRET, salt: "custom" })).toBe(FX.signerSha256);
    expect(await djangoSign("hello", { key: SECRET, salt: "custom", algorithm: "sha1" })).toBe(FX.signerSha1);
    expect(await djangoUnsign(FX.signerSha256, { key: SECRET, salt: "custom" })).toBe("hello");
    expect(await djangoUnsign(FX.signerSha1, { key: SECRET, salt: "custom", algorithm: "sha1" })).toBe("hello");
    expect(await djangoUnsign(FX.signerSha256, { key: SECRET, salt: "other" })).toBeUndefined();
    expect(await djangoUnsign("hello:tampered", { key: SECRET, salt: "custom" })).toBeUndefined();
    expect(await djangoUnsign("no-separator", { key: SECRET, salt: "custom" })).toBeUndefined();
  });
});

describe("signing.loads", () => {
  test("decodes plain and compressed payloads", async () => {
    expect(await signingLoads(FX.plainDumps, { key: SECRET })).toEqual({ a: [1, 2] });
    expect(await signingLoads(FX.signedCookieSmall, { key: SECRET, salt: DJANGO_SIGNED_COOKIE_SALT })).toEqual(DATA);
    expect(await signingLoads(FX.signedCookieBig, { key: SECRET, salt: DJANGO_SIGNED_COOKIE_SALT })).toEqual(BIG);
  });

  test("wrong salt, key or tampering fails", async () => {
    expect(await signingLoads(FX.signedCookieSmall, { key: SECRET })).toBeUndefined();
    expect(await signingLoads(FX.plainDumps, { key: "nope" })).toBeUndefined();
    expect(await signingLoads(FX.plainDumps.replace("eyJhIjpb", "eyJhIjpc"), { key: SECRET })).toBeUndefined();
  });

  test("fallback keys (SECRET_KEY_FALLBACKS)", async () => {
    expect(await signingLoads(FX.otherKey, { key: [SECRET, "another-secret"] })).toEqual({ a: 1 });
  });

  test("max_age uses the base62 timestamp", async () => {
    expect(await signingLoads(FX.plainDumps, { key: SECRET, maxAge: 60, now: NOW + 30 })).toEqual({ a: [1, 2] });
    expect(await signingLoads(FX.plainDumps, { key: SECRET, maxAge: 60, now: NOW + 61 })).toBeUndefined();
  });

  test("dumps round-trips and matches Django output for a fixed time", async () => {
    expect(await signingDumps({ a: [1, 2] }, { key: SECRET, now: NOW })).toBe(FX.plainDumps);
    const s = await signingDumps(BIG, { key: SECRET, salt: DJANGO_SIGNED_COOKIE_SALT, compress: true });
    expect(s.startsWith(".")).toBe(true);
    expect(await signingLoads(s, { key: SECRET, salt: DJANGO_SIGNED_COOKIE_SALT })).toEqual(BIG);
  });
});

describe("decodeDjangoSessionData", () => {
  test("database session_data (Django >= 3.1)", async () => {
    expect(await decodeDjangoSessionData(FX.dbSessionData, { secretKey: SECRET })).toEqual(DATA);
  });

  test("legacy database format (base64 of hash:json)", async () => {
    expect(await decodeDjangoSessionData(FX.legacyDb, { secretKey: SECRET })).toEqual(DATA);
    expect(await decodeDjangoSessionData(FX.legacyDb, { secretKey: "wrong" })).toBeUndefined();
  });

  test("garbage returns undefined", async () => {
    expect(await decodeDjangoSessionData("!!!", { secretKey: SECRET })).toBeUndefined();
  });
});

describe("djangoSessionBridge", () => {
  test("signed_cookies backend", async () => {
    const app = new Miu({ logger: false });
    app.use(djangoSessionBridge({ secretKey: SECRET, maxAge: Number.MAX_SAFE_INTEGER }));
    app.get("/", (c) => ({ s: c.get("legacySession") ?? null }));
    const ok = await app.request("/", { headers: { cookie: `sessionid=${FX.signedCookieSmall}` } });
    expect(await ok.json()).toEqual({ s: DATA });
    const bad = await app.request("/", { headers: { cookie: `sessionid=${FX.signedCookieSmall}x` } });
    expect(await bad.json()).toEqual({ s: null });
  });

  test("signed cookies older than maxAge (default 2 weeks) are rejected", async () => {
    const app = new Miu({ logger: false });
    app.use(djangoSessionBridge({ secretKey: SECRET }));
    app.get("/", (c) => ({ s: c.get("legacySession") ?? null }));
    const fresh = await signingDumps(DATA, { key: SECRET, salt: DJANGO_SIGNED_COOKIE_SALT, compress: true });
    expect(await (await app.request("/", { headers: { cookie: `sessionid=${fresh}` } })).json()).toEqual({ s: DATA });
    // FX was signed at NOW (2025-10); today is far beyond 14 days later.
    expect(await (await app.request("/", { headers: { cookie: `sessionid=${FX.signedCookieSmall}` } })).json()).toEqual({ s: null });
  });

  test("database backend via read()", async () => {
    const rows: Record<string, string> = { k1: FX.dbSessionData };
    const app = new Miu({ logger: false });
    app.use(djangoSessionBridge({ secretKey: SECRET, cookieName: "sid", read: async (key) => rows[key] }));
    app.get("/", (c) => ({ s: c.get("legacySession") ?? null }));
    expect(await (await app.request("/", { headers: { cookie: "sid=k1" } })).json()).toEqual({ s: DATA });
    expect(await (await app.request("/", { headers: { cookie: "sid=k2" } })).json()).toEqual({ s: null });
  });
});
