import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { sqlite } from "@miujs/db";
import { canonicalJson, dbAuditStore, memoryAuditStore, purgeOlderThan, verifyChain, type AuditInput, type AuditStore } from "../src/index.ts";

const K1 = "k1-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const K2 = "k2-secret-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210";

function entry(i: number, over: Partial<AuditInput> = {}): AuditInput {
  return { ts: 1_700_000_000_000 + i * 1000, action: "update", resource: "contacts", resourceId: `r${i}`, actor: "alice", metadata: { i }, ...over };
}

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return isMiuError(e) ? e.code : String(e);
  }
  return undefined;
}

describe("keyed (HMAC) chain", () => {
  test("rows carry a keyId and the hash is not plain sha256", async () => {
    const store = memoryAuditStore({ key: K1 });
    const a = await store.append(entry(1));
    expect(typeof a.keyId).toBe("string");
    expect(a.keyId!.length).toBeGreaterThan(0);
    const { hash, prevHash, keyId: _k, ...row } = a;
    expect(hash).not.toBe(await sha256Hex(prevHash + canonicalJson(row)));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the keyId does not reveal the key", async () => {
    const a = await memoryAuditStore({ key: K1 }).append(entry(1));
    expect(K1).not.toContain(a.keyId!);
    expect(a.keyId).not.toBe(await sha256Hex(K1));
  });

  test("verifyChain needs the key; with it, ok; with a wrong key, broken", async () => {
    const store = memoryAuditStore();
    for (let i = 1; i <= 3; i++) await store.append(entry(i), {}, { key: K1 });
    expect(await verifyChain(store, { keys: K1 })).toEqual({ ok: true, checked: 3 });
    expect(await verifyChain(store)).toMatchObject({ ok: false, brokenAt: 1 });
    expect(await verifyChain(store, { keys: K2 })).toMatchObject({ ok: false, brokenAt: 1 });
  });

  test("an attacker with DB write access who recomputes plain hashes is caught", async () => {
    const database = sqlite();
    const store = dbAuditStore(database, { key: K1 });
    for (let i = 1; i <= 4; i++) await store.append(entry(i));
    await database.exec("DROP TRIGGER audit_log_no_update");
    // Rewrite row 2 and recompute every later hash with plain SHA-256, dropping the key id.
    const rows = await store.scan(0, 10);
    let prev = rows[0].hash;
    for (const r of rows.slice(1)) {
      const forged = { ...r, actor: r.seq === 2 ? "mallory" : r.actor };
      const { hash: _h, prevHash: _p, keyId: _k, ...body } = forged;
      const h = await sha256Hex(prev + canonicalJson(body));
      await database.prepare("UPDATE audit_log SET actor = ?, prev_hash = ?, hash = ?, key_id = NULL WHERE seq = ?").bind(forged.actor, prev, h, r.seq).run();
      prev = h;
    }
    expect(await verifyChain(store, { keys: K1 })).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test("an attacker who keeps the keyId but cannot compute the HMAC is caught", async () => {
    const database = sqlite();
    const store = dbAuditStore(database, { key: K1 });
    for (let i = 1; i <= 3; i++) await store.append(entry(i));
    await database.exec("DROP TRIGGER audit_log_no_update");
    await database.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 3").run();
    expect(await verifyChain(store, { keys: K1 })).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test("the keyId is bound into the MAC: relabelling a row to another key id fails", async () => {
    const database = sqlite();
    const ring = [{ id: "a", secret: K1 }, { id: "b", secret: K1 }];
    const store = dbAuditStore(database, { key: ring });
    await store.append(entry(1));
    await database.exec("DROP TRIGGER audit_log_no_update");
    await database.prepare("UPDATE audit_log SET key_id = 'b' WHERE seq = 1").run();
    expect(await verifyChain(store, { keys: ring })).toMatchObject({ ok: false, brokenAt: 1 });
  });

  test("keyed rows round-trip through the db store", async () => {
    const store = dbAuditStore(sqlite(), { key: K1 });
    const a = await store.append(entry(1));
    const [back] = (await store.query({})).items;
    expect(back.keyId).toBe(a.keyId);
    expect(await verifyChain(store, { keys: K1 })).toEqual({ ok: true, checked: 1 });
  });

  test("rotation: the first key signs, every listed key verifies", async () => {
    const store1 = memoryAuditStore({ key: K1 });
    await store1.append(entry(1));
    await store1.append(entry(2));
    // Same rows, now rotating to K2 (re-open the same rows: use one store and pass keys per append).
    const store = memoryAuditStore();
    await store.append(entry(1), {}, { key: K1 });
    await store.append(entry(2), {}, { key: K1 });
    const c = await store.append(entry(3), {}, { key: [K2, K1] });
    const [a] = await store.scan(0, 1);
    expect(c.keyId).not.toBe(a.keyId);
    expect(await verifyChain(store, { keys: [K2, K1] })).toEqual({ ok: true, checked: 3 });
    expect(await verifyChain(store, { keys: [K2] })).toMatchObject({ ok: false, brokenAt: 1 });
  });

  test("keys with explicit ids", async () => {
    const store = memoryAuditStore({ key: [{ id: "2026-10", secret: K2 }, { id: "2026-01", secret: K1 }] });
    const a = await store.append(entry(1));
    expect(a.keyId).toBe("2026-10");
    expect(await verifyChain(store, { keys: [{ id: "2026-10", secret: K2 }] })).toEqual({ ok: true, checked: 1 });
    // Same id, different secret: refused.
    expect((await verifyChain(store, { keys: [{ id: "2026-10", secret: K1 }] })).ok).toBe(false);
  });

  test("env.AUDIT_HMAC_KEY signs and verifies; comma-separated rotates", async () => {
    const store = memoryAuditStore();
    const a = await store.append(entry(1), { AUDIT_HMAC_KEY: K1 });
    expect(a.keyId).toBeTruthy();
    const b = await store.append(entry(2), { AUDIT_HMAC_KEY: `${K2},${K1}` });
    expect(b.keyId).not.toBe(a.keyId);
    expect(await verifyChain(store, { env: { AUDIT_HMAC_KEY: `${K2},${K1}` } })).toEqual({ ok: true, checked: 2 });
    expect((await verifyChain(store, { env: { AUDIT_HMAC_KEY: K2 } })).ok).toBe(false);
  });

  test("keys shorter than 32 characters are refused", async () => {
    expect(await codeOf(() => memoryAuditStore({ key: "short" }))).toBe("MIU_E_AUDIT_KEY_WEAK");
    expect(await codeOf(memoryAuditStore().append(entry(1), { AUDIT_HMAC_KEY: "short" }))).toBe("MIU_E_AUDIT_KEY_WEAK");
    expect(await codeOf(verifyChain(memoryAuditStore(), { keys: ["x".repeat(31)] }))).toBe("MIU_E_AUDIT_KEY_WEAK");
    expect(await codeOf(() => memoryAuditStore({ key: [] }))).toBe("MIU_E_AUDIT_KEY_WEAK");
  });

  test("once the chain is keyed, appending without a key is refused (no silent downgrade)", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1), { AUDIT_HMAC_KEY: K1 });
    expect(await codeOf(store.append(entry(2)))).toBe("MIU_E_AUDIT_KEY_MISSING");
  });

  test("with keys, unkeyed rows fail verification unless allowed as a legacy prefix", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1));
    await store.append(entry(2));
    await store.append(entry(3), {}, { key: K1 });
    expect(await verifyChain(store, { keys: K1 })).toMatchObject({ ok: false, brokenAt: 1 });
    expect(await verifyChain(store, { keys: K1, unkeyedThrough: 2 })).toEqual({ ok: true, checked: 3 });
    expect(await verifyChain(store, { keys: K1, unkeyedThrough: 1 })).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test("a failure reports a reason", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1), {}, { key: K1 });
    const r = await verifyChain(store);
    expect(r.reason).toMatch(/key/i);
  });

  test("purgeOlderThan with a keyed store keeps the chain verifiable", async () => {
    const store = memoryAuditStore({ key: K1 });
    const now = Date.now();
    for (let i = 0; i < 4; i++) await store.append(entry(i, { ts: now - 100 * 86_400_000 }));
    await store.append(entry(9, { ts: now }));
    const r = await purgeOlderThan(store, 30, { now, keys: K1 });
    expect(r.purged).toBe(4);
    expect(await verifyChain(store, { keys: K1 })).toEqual({ ok: true, checked: 2 });
  });

  test("a store-level key is used by verifyChain and purge when none is passed", async () => {
    const store = memoryAuditStore({ key: K1 });
    await store.append(entry(1));
    expect(await verifyChain(store)).toEqual({ ok: true, checked: 1 });
    // ...but explicit keys win, so an auditor can check with their own copy.
    expect((await verifyChain(store, { keys: K2 })).ok).toBe(false);
  });

  test("purgeOlderThan refuses on a keyed chain without the key", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1, { ts: 0 }), {}, { key: K1 });
    expect(await codeOf(purgeOlderThan(store, 1))).toBe("MIU_E_AUDIT_CHAIN_BROKEN");
  });
});

export type _Unused = AuditStore;
