// Concurrent appends share one head read and one transaction (group commit). One serialized
// round trip per append (head read, async hashing, insert) capped audited writes under load: in a
// 50-user CRM soak, every write waited 0.5–1 s behind the audit queue and the queue kept growing.

import { expect, test } from "bun:test";
import { sqlite, type Database } from "@miujs/db";
import { dbAuditStore, verifyChain, type AuditInput } from "../src/index.ts";

const entry = (i: number): AuditInput => ({ ts: 1_700_000_000_000 + i, action: "update", resource: "contacts", resourceId: `r${i}`, actor: "a", org: "o" });

test("100 concurrent appends: a few transactions, one valid chain, each caller gets its own record", async () => {
  const database = sqlite();
  const store = dbAuditStore(database);
  await store.append(entry(0), { AUDIT_HMAC_KEY: "k".repeat(32) }); // creates the table
  const env = { AUDIT_HMAC_KEY: "k".repeat(32) };
  let heads = 0;
  const db = database as Database & { prepare: Database["prepare"] };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (/ORDER BY seq DESC LIMIT 1/i.test(sql)) heads++;
    return prepare(sql);
  };
  const out = await Promise.all([
    ...Array.from({ length: 80 }, (_, i) => store.append(entry(i + 1), env)),
    ...Array.from({ length: 10 }, (_, i) => store.appendMany!([entry(100 + i * 2), entry(101 + i * 2)], env)),
  ]);
  db.prepare = prepare;
  expect(heads).toBeLessThanOrEqual(5);
  const singles = out.slice(0, 80) as { resourceId: string | null; seq: number }[];
  expect(singles.map((r) => r.resourceId)).toEqual(Array.from({ length: 80 }, (_, i) => `r${i + 1}`));
  const pairs = out.slice(80) as { resourceId: string | null }[][];
  expect(pairs.map((p) => p.map((r) => r.resourceId))).toEqual(Array.from({ length: 10 }, (_, i) => [`r${100 + i * 2}`, `r${101 + i * 2}`]));
  const seqs = [...singles.map((r) => r.seq), ...pairs.flat().map((r) => (r as unknown as { seq: number }).seq)].sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 2));
  expect((await verifyChain(store, { env })).ok).toBe(true);
});

test("a failing append in a group does not fail the others", async () => {
  const store = dbAuditStore(sqlite());
  await store.append(entry(0));
  const bad = { ...entry(1), action: "" } as AuditInput; // rejected by validation
  const results = await Promise.allSettled([store.append(entry(2)), store.append(bad), store.append(entry(3))]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect((await verifyChain(store)).ok).toBe(true);
});

test("hashing does not wait for the event loop (a busy server would stretch every audited write)", async () => {
  for (const env of [{}, { AUDIT_HMAC_KEY: "k".repeat(32) }]) {
    const store = dbAuditStore(sqlite());
    await store.append(entry(0), env);
    let ticked = false;
    const timer = setTimeout(() => (ticked = true), 0);
    await store.appendMany!(Array.from({ length: 200 }, (_, i) => entry(i + 1)), env);
    clearTimeout(timer);
    expect(ticked).toBe(false);
    expect((await verifyChain(store, { env })).ok).toBe(true);
  }
});

test("the fast hash is the same SHA-256 / HMAC-SHA-256 as WebCrypto, and the key's secret stays hidden", async () => {
  const { hashRow, canonicalJson } = await import("../src/index.ts");
  const { resolveKeys } = await import("../src/keys.ts");
  const row = { seq: 7, ts: 1, action: "update", resource: "contacts", resourceId: "r1", actor: "a", org: "o", ip: null, userAgent: null, requestId: null, changes: { a: { before: 1, after: "é" } }, metadata: null };
  const prev = "ab".repeat(32);
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const body = canonicalJson(row);
  expect(await hashRow(prev, row as never)).toBe(hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prev + body))));
  const [key] = await resolveKeys("s".repeat(40));
  const wk = await crypto.subtle.importKey("raw", new TextEncoder().encode("s".repeat(40)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  expect(await hashRow(prev, row as never, key)).toBe(hex(await crypto.subtle.sign("HMAC", wk, new TextEncoder().encode(`miujs-audit-v2\n${key.id}\n${prev}${body}`))));
  expect(Object.keys(key)).not.toContain("secret");
  expect(JSON.stringify(key)).not.toContain("s".repeat(40));
});
