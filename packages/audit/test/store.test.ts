import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { d1, sqlite, type Database } from "@miujs/db";
import { canonicalJson, dbAuditStore, GENESIS_HASH, memoryAuditStore, purgeOlderThan, verifyChain, chainHead, type AuditInput, type AuditStore } from "../src/index.ts";

const DAY = 86_400_000;

function entry(i: number, over: Partial<AuditInput> = {}): AuditInput {
  return {
    ts: 1_700_000_000_000 + i * 1000,
    action: "update",
    resource: i % 2 ? "contacts" : "deals",
    resourceId: `r${i % 3}`,
    actor: i % 2 ? "alice" : "bob",
    org: i % 2 ? "o1" : "o2",
    ip: "1.2.3.4",
    userAgent: "test",
    requestId: `req${i}`,
    changes: { n: { before: i - 1, after: i } },
    metadata: { i },
    ...over,
  };
}

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const stores: [string, () => Promise<{ store: AuditStore; database?: Database }>][] = [
  ["memory", async () => ({ store: memoryAuditStore() })],
  [
    "db (sqlite)",
    async () => {
      const database = sqlite();
      return { store: dbAuditStore(database), database };
    },
  ],
];

for (const [name, make] of stores) {
  describe(`${name} store`, () => {
    test("append assigns seq and chains hash = sha256(prevHash + canonical row)", async () => {
      const { store } = await make();
      const a = await store.append(entry(1));
      const b = await store.append(entry(2));
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(a.prevHash).toBe(GENESIS_HASH);
      expect(b.prevHash).toBe(a.hash);
      const { hash, prevHash, ...row } = a;
      expect(hash).toBe(await sha256Hex(prevHash + canonicalJson(row)));
    });

    test("query: newest first, filters, cursor pagination", async () => {
      const { store } = await make();
      for (let i = 1; i <= 7; i++) await store.append(entry(i));
      const all = await store.query({ limit: 3 });
      expect(all.items.map((r) => r.seq)).toEqual([7, 6, 5]);
      expect(all.nextCursor).toBeTruthy();
      const next = await store.query({ limit: 3, cursor: all.nextCursor! });
      expect(next.items.map((r) => r.seq)).toEqual([4, 3, 2]);
      const last = await store.query({ limit: 3, cursor: next.nextCursor! });
      expect(last.items.map((r) => r.seq)).toEqual([1]);
      expect(last.nextCursor).toBeNull();

      expect((await store.query({ resource: "contacts" })).items.map((r) => r.seq)).toEqual([7, 5, 3, 1]);
      expect((await store.query({ resource: "contacts", resourceId: "r1" })).items.map((r) => r.seq)).toEqual([7, 1]);
      expect((await store.query({ actor: "bob" })).items.map((r) => r.seq)).toEqual([6, 4, 2]);
      expect((await store.query({ org: "o1" })).items.every((r) => r.org === "o1")).toBe(true);
      const t3 = entry(3).ts;
      const t5 = entry(5).ts;
      expect((await store.query({ since: t3, until: t5 })).items.map((r) => r.seq)).toEqual([4, 3]);
      expect((await store.query({ since: new Date(t5).toISOString() })).items.map((r) => r.seq)).toEqual([7, 6, 5]);
    });

    test("query rejects a bad limit, date or cursor", async () => {
      const { store } = await make();
      for (const q of [{ limit: 0 }, { limit: 5000 }, { since: "not a date" }, { cursor: "abc" }]) {
        let err: unknown;
        try {
          await store.query(q as any);
        } catch (e) {
          err = e;
        }
        expect(isMiuError(err) && (err as any).code).toBe("MIU_E_AUDIT_QUERY_INVALID");
      }
    });

    test("records come back as stored (JSON round-trip) and cannot be mutated through the result", async () => {
      const { store } = await make();
      const r = await store.append(entry(1, { metadata: { at: new Date(0), list: [1, undefined] } as any }));
      expect(r.metadata).toEqual({ at: "1970-01-01T00:00:00.000Z", list: [1, null] });
      r.metadata!.at = "changed";
      const [back] = (await store.query({})).items;
      expect(back.metadata).toEqual({ at: "1970-01-01T00:00:00.000Z", list: [1, null] });
      expect(back.hash).toBe(r.hash);
      expect((await verifyChain(store)).ok).toBe(true);
    });

    test("concurrent appends form one unbroken chain", async () => {
      const { store } = await make();
      await Promise.all(Array.from({ length: 25 }, (_, i) => store.append(entry(i))));
      const v = await verifyChain(store);
      expect(v).toEqual({ ok: true, checked: 25 });
      expect((await chainHead(store))!.seq).toBe(25);
    });

    test("verifyChain on an empty store is ok", async () => {
      const { store } = await make();
      expect(await verifyChain(store)).toEqual({ ok: true, checked: 0 });
    });

    test("purgeOlderThan deletes old rows, records a checkpoint and keeps the chain verifiable", async () => {
      const { store } = await make();
      const now = Date.now();
      for (let i = 0; i < 5; i++) await store.append(entry(i, { ts: now - (100 - i) * DAY }));
      for (let i = 5; i < 8; i++) await store.append(entry(i, { ts: now - DAY }));
      const r = await purgeOlderThan(store, 30, { now });
      expect(r.purged).toBe(5);
      const rows = (await store.query({ limit: 100 })).items.reverse();
      expect(rows.map((x) => x.seq)).toEqual([6, 7, 8, 9]);
      const cp = rows[rows.length - 1];
      expect(cp.action).toBe("audit.checkpoint");
      expect(cp.metadata).toMatchObject({ purgedThroughSeq: 5, purgedCount: 5 });
      expect(await verifyChain(store)).toEqual({ ok: true, checked: 4 });
      // Purging again later, including the old checkpoint, still verifies.
      await store.append(entry(9, { ts: now }));
      const r2 = await purgeOlderThan(store, 0, { now: now + 1 });
      expect(r2.purged).toBe(5);
      expect((await verifyChain(store)).ok).toBe(true);
      expect(await purgeOlderThan(store, 0, { now: now + 2 })).toMatchObject({ purged: 1 });
    });

    test("purge with nothing old does nothing", async () => {
      const { store } = await make();
      await store.append(entry(1, { ts: Date.now() }));
      expect(await purgeOlderThan(store, 30)).toEqual({ purged: 0 });
      expect((await store.query({})).items.length).toBe(1);
    });

    test("purge rejects bad retention values", async () => {
      const { store } = await make();
      for (const d of [-1, Number.NaN, Infinity]) {
        await expect(purgeOlderThan(store, d)).rejects.toThrow();
      }
    });
  });
}

describe("tamper evidence (db store)", () => {
  async function filled(n = 5) {
    const database = sqlite();
    const store = dbAuditStore(database);
    for (let i = 1; i <= n; i++) await store.append(entry(i));
    // The table refuses UPDATEs; an attacker with raw DB access would drop the trigger first.
    await database.exec("DROP TRIGGER audit_log_no_update");
    return { database, store };
  }

  test("the table rejects UPDATE (append-only)", async () => {
    const database = sqlite();
    const store = dbAuditStore(database);
    await store.append(entry(1));
    await expect(database.prepare("UPDATE audit_log SET actor = 'mallory'").run()).rejects.toThrow(/append-only/);
  });

  test("editing a row is detected at that row", async () => {
    const { database, store } = await filled();
    await database.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 3").run();
    expect(await verifyChain(store)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test("editing a JSON column is detected", async () => {
    const { database, store } = await filled();
    await database.prepare(`UPDATE audit_log SET changes = '{"n":{"after":0,"before":1}}' WHERE seq = 2`).run();
    expect(await verifyChain(store)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test("editing a row and recomputing its hash breaks the next link", async () => {
    const { database, store } = await filled();
    const row: any = await database.prepare("SELECT * FROM audit_log WHERE seq = 3").first();
    const rec = (await store.scan(2, 1))[0];
    const forged = { ...rec, actor: "mallory" };
    const { hash: _h, prevHash, ...body } = forged;
    const newHash = await sha256Hex(prevHash + canonicalJson(body));
    await database.prepare("UPDATE audit_log SET actor = 'mallory', hash = ? WHERE seq = 3").bind(newHash).run();
    expect(row.seq).toBe(3);
    expect(await verifyChain(store)).toMatchObject({ ok: false, brokenAt: 4 });
  });

  test("deleting a middle row is detected", async () => {
    const { database, store } = await filled();
    await database.prepare("DELETE FROM audit_log WHERE seq = 3").run();
    expect(await verifyChain(store)).toMatchObject({ ok: false, brokenAt: 4 });
  });

  test("deleting the first rows without a checkpoint is detected", async () => {
    const { database, store } = await filled();
    await database.prepare("DELETE FROM audit_log WHERE seq <= 2").run();
    expect(await verifyChain(store)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test("deleting the last row is caught when you check against a saved head", async () => {
    const { database, store } = await filled();
    const head = await chainHead(store);
    await database.prepare("DELETE FROM audit_log WHERE seq = 5").run();
    expect((await verifyChain(store)).ok).toBe(true); // a bare chain cannot see truncation...
    expect(await verifyChain(store, { head: head! })).toMatchObject({ ok: false, brokenAt: 5 }); // ...an anchored one can
  });

  test("swapping two rows' contents is detected", async () => {
    const { database, store } = await filled();
    await database.prepare("UPDATE audit_log SET seq = 100 WHERE seq = 2").run();
    await database.prepare("UPDATE audit_log SET seq = 2 WHERE seq = 3").run();
    await database.prepare("UPDATE audit_log SET seq = 3 WHERE seq = 100").run();
    expect((await verifyChain(store)).ok).toBe(false);
  });

  test("a forged checkpoint cannot launder deleted rows", async () => {
    const { database, store } = await filled();
    await database.prepare("DELETE FROM audit_log WHERE seq <= 2").run();
    await store.append(entry(6, { action: "audit.checkpoint", resource: "audit", metadata: { purgedThroughSeq: 1, anchorHash: "x" } }));
    expect((await verifyChain(store)).ok).toBe(false);
  });

  test("purge refuses to run on a broken chain (it would hide tampering)", async () => {
    const { database, store } = await filled();
    await database.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 2").run();
    let err: unknown;
    try {
      await purgeOlderThan(store, 0);
    } catch (e) {
      err = e;
    }
    expect((err as any)?.code).toBe("MIU_E_AUDIT_CHAIN_BROKEN");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n")).toBe(5);
  });
});

describe("dbAuditStore config", () => {
  test("d1 binding name resolves from env; cloudflare() asks for it", async () => {
    const store = dbAuditStore(d1("AUDIT"));
    expect(store.cloudflare?.()).toEqual({ d1: ["AUDIT"] });
    const database = sqlite();
    await store.append(entry(1), { AUDIT: database });
    expect(await database.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n")).toBe(1);
  });
  test("the append-only trigger is created by a recorded migration", async () => {
    const database = sqlite();
    await dbAuditStore(database, { table: "phi_audit" }).append(entry(1));
    const ids = (await database.prepare("SELECT id FROM _miu_migrations").all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toContain("audit_003_phi_audit_no_update");
    const trig = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'phi_audit'").all<{ name: string }>();
    expect(trig.results.map((r) => r.name)).toEqual(["phi_audit_no_update"]);
  });
  test("custom table names are validated", () => {
    expect(() => dbAuditStore(sqlite(), { table: "audit; DROP TABLE x" })).toThrow();
    expect(() => dbAuditStore(sqlite(), { table: "phi_audit" })).not.toThrow();
  });
});
