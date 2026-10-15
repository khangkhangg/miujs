// Memory and exit health of sessions: many requests reading and writing sessions through
// `miu().fetch`, the memory store's expiry, and the HMAC key cache.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { miu, route } from "miujs";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { hmacSha256, memorySessionStore, session, type SessionStore } from "../src/index.ts";
import { SECRET } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");
const report = (r: { name: string }) => process.env.LEAK_REPORT && console.log(describeLeak(r as never));

function app(store?: SessionStore) {
  return miu({
    logLevel: "silent",
    dev: false,
    plugins: [session({ secret: SECRET, store })],
    routes: [
      route.get("/read", { handler: (ctx) => ({ n: ctx.session.get<number>("n") ?? 0 }) }),
      route.post("/write", {
        handler: (ctx) => {
          ctx.session.set("n", (ctx.session.get<number>("n") ?? 0) + 1);
          ctx.session.flash("notice", "saved");
          return "ok";
        },
      }),
    ],
  });
}

async function cookieFrom(a: ReturnType<typeof app>): Promise<string> {
  const res = await a.fetch(new Request("http://localhost/write", { method: "POST", headers: { origin: "http://localhost" } }));
  return res.headers.getSetCookie()[0].split(";")[0];
}

describe("session requests do not leak", () => {
  for (const [label, makeStore] of [
    ["cookie store", () => undefined],
    ["memory store", () => memorySessionStore()],
  ] as const) {
    test(`${label}: reads and writes on one session`, async () => {
      const a = app(makeStore());
      await a.ready();
      let cookie = await cookieFrom(a);
      const r = await leakCheck(
        label,
        async (i) => {
          if (i % 2) {
            await (await a.fetch(new Request("http://localhost/read", { headers: { cookie } }))).arrayBuffer();
          } else {
            const res = await a.fetch(new Request("http://localhost/write", { method: "POST", headers: { cookie, origin: "http://localhost" } }));
            const set = res.headers.getSetCookie()[0];
            if (set) cookie = set.split(";")[0];
            await res.arrayBuffer();
          }
        },
        { perRound: 2000, rounds: 5 },
      );
      report(r);
      expect(r.leaking, describeLeak(r)).toBe(false);
    }, 60_000);
  }

  test("cookie store: a new visitor on every request", async () => {
    const a = app();
    await a.ready();
    const r = await leakCheck(
      "new visitors",
      async () => void (await (await a.fetch(new Request("http://localhost/write", { method: "POST", headers: { origin: "http://localhost" } }))).arrayBuffer()),
      { perRound: 2000, rounds: 5 },
    );
    report(r);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 60_000);
});

describe("memorySessionStore", () => {
  test("purges expired sessions that are never read again", async () => {
    let now = 1_000_000;
    const store = memorySessionStore({ now: () => now });
    for (let i = 0; i < 10_000; i++) {
      now += 100;
      await store.set(`id${i}`, { d: { i }, e: now + 1000 }, 1, {});
    }
    // ~10 sessions are live (1 s lifetime, one new every 100 ms).
    expect(store.size).toBeLessThan(100);
  });

  test("still returns live sessions and drops expired ones on read", async () => {
    let now = 0;
    const store = memorySessionStore({ now: () => now });
    await store.set("a", { d: { x: 1 }, e: 5000 }, 5, {});
    await store.set("b", { d: { x: 2 }, e: 1000 }, 1, {});
    now = 2000;
    expect(await store.get("a", {})).toEqual({ d: { x: 1 }, e: 5000 });
    expect(await store.get("b", {})).toBeNull();
  });

  test("an expired session behind a longer-lived one is purged too", async () => {
    let now = 0;
    const store = memorySessionStore({ now: () => now });
    await store.set("long", { d: {}, e: 1_000_000 }, 1000, {});
    for (let i = 0; i < 5000; i++) {
      now += 10;
      await store.set(`s${i}`, { d: {}, e: now + 100 }, 0.1, {});
    }
    expect(store.size).toBeLessThan(100);
  });
});

test("the HMAC key cache stays bounded when many secrets are used", async () => {
  const r = await leakCheck("hmac keys", (i) => hmacSha256(`secret-number-${i}-that-is-long-enough`, "payload"), { perRound: 2000, rounds: 5 });
  report(r);
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 60_000);

test("hmacSha256 (fast Bun path) matches Web Crypto HMAC-SHA256", async () => {
  for (const [secret, data] of [["k".repeat(40), ""], ["secret-é-ü-✓-long-enough-0123456789", "payload ✓ 日本 " + "x".repeat(500)]]) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const want = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
    expect(await hmacSha256(secret, data)).toEqual(want);
  }
});

test("hmacSha256 still works right after a failed Web Crypto import (stale OpenSSL error)", async () => {
  const bad = { kty: "EC", crv: "P-256", x: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", y: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI" };
  await crypto.subtle.importKey("jwk", bad, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).catch(() => null);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("v")));
  expect(await hmacSha256(SECRET, "v")).toEqual(want);
});

test("an app with sessions (memory store) lets the process exit", async () => {
  const r = await exitCheck(
    `
    import { miu, route } from "miujs";
    import { memorySessionStore, session } from "../src/index.ts";
    const app = miu({ logLevel: "silent", plugins: [session({ secret: "${SECRET}", store: memorySessionStore() })],
      routes: [route.post("/w", { handler: (ctx) => { ctx.session.set("a", 1); return "ok"; } })] });
    await app.ready();
    for (let i = 0; i < 50; i++) await app.fetch(new Request("http://localhost/w", { method: "POST", headers: { origin: "http://localhost" } }));
    `,
    3000,
    PKG,
  );
  expect(r.exited, r.stderr).toBe(true);
});
