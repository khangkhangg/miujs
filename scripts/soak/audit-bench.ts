// Audit log write cost per mutation: dbAuditStore on bun:sqlite with the HMAC hash chain.
//   bun scripts/soak/audit-bench.ts [iterations]
// Prints microseconds per append() (= ctx.audit.log) and per appendMany() of 1 and 10 entries,
// keyed and unkeyed, on an in-memory and an on-disk database (default rollback journal, and WAL).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "../../packages/db/src/index.ts";
import { dbAuditStore, type AuditInput } from "../../packages/audit/src/index.ts";

const N = Number(process.argv[2] ?? 3000);
const KEY = "k".repeat(48);

const entry = (i: number): AuditInput => ({
  ts: Date.now(),
  action: "update",
  resource: "contacts",
  resourceId: String(i),
  actor: "u_123",
  org: "org_1",
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0 (bench)",
  requestId: "req_" + i,
  changes: { name: { before: "Ada", after: "Ada L." }, stage: { before: "lead", after: "customer" } },
  metadata: { source: "bench" },
});

async function bench(label: string, path: string, keyed: boolean, wal = false): Promise<void> {
  const db = sqlite(path);
  if (wal) await db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  const store = dbAuditStore(db, keyed ? { key: KEY } : {});
  await store.append(entry(0)); // migrate + warm caches
  for (let i = 0; i < 200; i++) await store.append(entry(i));

  let t = performance.now();
  for (let i = 0; i < N; i++) await store.append(entry(i));
  const one = ((performance.now() - t) * 1000) / N;

  t = performance.now();
  for (let i = 0; i < N; i++) await store.appendMany!([entry(i)]);
  const many1 = ((performance.now() - t) * 1000) / N;

  const M = Math.max(1, Math.floor(N / 10));
  const batch = Array.from({ length: 10 }, (_, i) => entry(i));
  t = performance.now();
  for (let i = 0; i < M; i++) await store.appendMany!(batch);
  const many10 = ((performance.now() - t) * 1000) / M;

  console.log(
    `${label.padEnd(26)} log(): ${one.toFixed(1).padStart(6)} us   logMany(1): ${many1.toFixed(1).padStart(6)} us   logMany(10): ${many10.toFixed(1).padStart(7)} us (${(many10 / 10).toFixed(1)} us/entry)`,
  );
  db.close?.();
}

const dir = mkdtempSync(join(tmpdir(), "audit-bench-"));
try {
  console.log(`audit write cost, ${N} iterations, Bun ${Bun.version}`);
  await bench("memory db, HMAC", ":memory:", true);
  await bench("memory db, SHA-256", ":memory:", false);
  await bench("file db, HMAC", join(dir, "a.db"), true);
  await bench("file db WAL+NORMAL, HMAC", join(dir, "b.db"), true, true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
