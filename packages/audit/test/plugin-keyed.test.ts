import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isMiuError, miu, route } from "miujs";
import { audit, hashAuditEmail, memoryAuditStore, verifyChain, type AuditStore } from "../src/index.ts";
import { auth, memoryUserStore } from "../../auth/src/index.ts";
import { session } from "../../session/src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";

const BASE = "http://localhost";
const K1 = "k1-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const SALT = "email-salt-0123456789abcdefghijklmnopqrstuvw";

const logRoute = route.post("/log", { handler: async (c) => ({ keyId: (await c.audit.log({ action: "export", resource: "patients" })).keyId ?? null }) });

describe("audit({ key })", () => {
  test("signs entries with the plugin key", async () => {
    const store = memoryAuditStore();
    const app = miu({ logLevel: "silent", plugins: [audit({ store, key: K1 })], routes: [logRoute] });
    const res = await app.fetch(new Request(`${BASE}/log`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect((await res.json()).keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(await verifyChain(store, { keys: K1 })).toEqual({ ok: true, checked: 1 });
    expect((await verifyChain(store)).ok).toBe(false);
  });

  test("signs with env.AUDIT_HMAC_KEY when no key is passed", async () => {
    const store = memoryAuditStore();
    const app = miu({ logLevel: "silent", plugins: [audit({ store })], routes: [logRoute] });
    const res = await app.dispatch(new Request(`${BASE}/log`, { method: "POST" }), { AUDIT_HMAC_KEY: K1 }, { runtime: "workerd" });
    expect((await res.json()).keyId).toMatch(/^k_/);
    expect(await verifyChain(store, { env: { AUDIT_HMAC_KEY: K1 } })).toEqual({ ok: true, checked: 1 });
  });

  test("a weak key is refused at startup", () => {
    let err: unknown;
    try {
      audit({ store: memoryAuditStore(), key: "too-short" });
    } catch (e) {
      err = e;
    }
    expect(isMiuError(err) && err.code).toBe("MIU_E_AUDIT_KEY_WEAK");
    expect((err as any).fix).toContain("32");
  });

  test("inspect says whether the chain is keyed, never the key", () => {
    const info = JSON.stringify(audit({ store: memoryAuditStore(), key: K1 }).inspect!());
    expect(info).toContain('"keyed":true');
    expect(info).not.toContain(K1);
  });

  describe("production warning", () => {
    let warned: string[] = [];
    const orig = console.warn;
    beforeEach(() => {
      warned = [];
      console.warn = (m: unknown) => void warned.push(String(m));
    });
    afterEach(() => {
      console.warn = orig;
    });

    test("warns in production without a key", async () => {
      const app = miu({ dev: false, logLevel: "warn", plugins: [audit({ store: { ...memoryAuditStore(), kind: "db" } })] });
      await app.ready();
      expect(warned.some((w) => w.includes("AUDIT_HMAC_KEY"))).toBe(true);
    });

    test("does not warn with a key, or in dev", async () => {
      const a = miu({ dev: false, logLevel: "warn", plugins: [audit({ store: { ...memoryAuditStore(), kind: "db" }, key: K1 })] });
      await a.ready();
      const b = miu({ dev: true, logLevel: "warn", plugins: [audit({ store: memoryAuditStore() })] });
      await b.ready();
      expect(warned.filter((w) => w.includes("AUDIT_HMAC_KEY"))).toEqual([]);
    });
  });
});

describe("redactFailedLoginEmail", () => {
  const FAST = { algorithm: "pbkdf2" as const, iterations: 1000 };
  function authApp(store: AuditStore, extra: Record<string, unknown>) {
    return miu({
      logLevel: "silent",
      plugins: [session({ secret: SECRET }), auth({ users: memoryUserStore(), password: FAST, rateLimit: false }), audit({ store, auth: true, ...extra })],
    });
  }
  const login = (app: any, email: string) =>
    app.fetch(new Request(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong password!!" }) }));

  test("stores a salted hash instead of the attempted email", async () => {
    const store = memoryAuditStore();
    const app = authApp(store, { redactFailedLoginEmail: true, emailSalt: SALT });
    expect((await login(app, "Ann@Example.com")).status).toBe(401);
    const [row] = (await store.query({})).items;
    expect(row.metadata).not.toHaveProperty("email");
    expect((row.metadata as any).emailHash).toBe(await hashAuditEmail("ann@example.com", SALT));
    expect((row.metadata as any).emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row).toLowerCase()).not.toContain("ann@example.com");
  });

  test("the same email hashes the same (brute force stays visible); others differ", async () => {
    const store = memoryAuditStore();
    const app = authApp(store, { redactFailedLoginEmail: true, emailSalt: SALT });
    await login(app, "ann@example.com");
    await login(app, "ANN@Example.COM");
    await login(app, "bob@example.com");
    const hashes = (await store.query({})).items.reverse().map((r) => (r.metadata as any).emailHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  test("the hash depends on the salt (no rainbow tables)", async () => {
    expect(await hashAuditEmail("ann@example.com", SALT)).not.toBe(await hashAuditEmail("ann@example.com", K1));
    const plain = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ann@example.com")));
    const plainHex = [...plain].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await hashAuditEmail("ann@example.com", SALT)).not.toBe(plainHex);
  });

  test("falls back to the audit key as salt", async () => {
    const store = memoryAuditStore();
    const app = authApp(store, { redactFailedLoginEmail: true, key: K1 });
    await login(app, "ann@example.com");
    const [row] = (await store.query({})).items;
    expect((row.metadata as any).emailHash).toBe(await hashAuditEmail("ann@example.com", K1));
  });

  test("with no salt or key at all, the email is dropped rather than stored", async () => {
    const store = memoryAuditStore();
    const app = authApp(store, { redactFailedLoginEmail: true });
    await login(app, "ann@example.com");
    const [row] = (await store.query({})).items;
    expect(row.metadata).not.toHaveProperty("email");
    expect(row.metadata).not.toHaveProperty("emailHash");
    expect(row.metadata).toMatchObject({ outcome: "failure", status: 401 });
  });

  test("a weak salt is refused", () => {
    expect(() => audit({ store: memoryAuditStore(), redactFailedLoginEmail: true, emailSalt: "short" })).toThrow(/too short/);
  });
});
