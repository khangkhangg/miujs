import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, t, type AuthUser } from "miujs";
import { sqlite } from "@miujs/db";
import { audit, dbAuditStore, memoryAuditStore, verifyChain, type AuditService, type AuditStore } from "../src/index.ts";

const KEY = "k".repeat(40);

for (const [name, make] of [
  ["memory", () => memoryAuditStore()],
  ["db", () => dbAuditStore(sqlite())],
  ["db keyed", () => dbAuditStore(sqlite(), { key: KEY })],
] as [string, () => AuditStore][]) {
  describe(`appendMany (${name})`, () => {
    test("appends consecutive rows that verify", async () => {
      const store = make();
      await store.append({ ts: 1, action: "a", resource: "r" });
      const recs = await store.appendMany!([
        { ts: 2, action: "b", resource: "r", resourceId: "1" },
        { ts: 3, action: "c", resource: "r", resourceId: "2" },
      ]);
      expect(recs.map((r) => [r.seq, r.action])).toEqual([
        [2, "b"],
        [3, "c"],
      ]);
      expect(recs[1].prevHash).toBe(recs[0].hash);
      expect((await verifyChain(store)).ok).toBe(true);
      expect(await store.appendMany!([])).toEqual([]);
    });

    test("an invalid entry writes nothing", async () => {
      const store = make();
      await expect(store.appendMany!([{ ts: 1, action: "ok", resource: "r" }, { ts: 2, action: "", resource: "r" }])).rejects.toThrow(/action/);
      expect(await store.head()).toBeNull();
    });
  });
}

test("db appendMany is one transaction", async () => {
  const db = sqlite();
  const store = dbAuditStore(db);
  await store.append({ ts: 1, action: "a", resource: "r" });
  // Every insert of "c" fails like a lost race. A non-atomic batch would leave a "b" row behind
  // on each of its retries; an atomic one rolls each attempt back completely.
  await db.exec("CREATE TRIGGER fail_c BEFORE INSERT ON audit_log WHEN NEW.action = 'c' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: audit_log.seq'); END");
  await expect(store.appendMany!([{ ts: 2, action: "b", resource: "r" }, { ts: 3, action: "c", resource: "r" }])).rejects.toThrow(/concurrent/);
  const bs = await db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'b'").first<{ n: number }>();
  expect(bs!.n).toBe(0);
  expect((await verifyChain(store)).ok).toBe(true);
});

const USERS: Record<string, AuthUser> = { alice: { id: "alice", roles: [] } };
const testAuth = definePlugin({
  name: "test-auth",
  onRequest(ctx) {
    const id = ctx.headers.get("x-user");
    if (id && USERS[id]) ctx.user = USERS[id];
    (ctx as { org?: unknown }).org = { id: "org1", role: "owner" };
  },
});

describe("ctx.audit.logMany and the audit service", () => {
  test("logMany stamps every entry with the request's actor and org", async () => {
    const store = memoryAuditStore();
    const app = miu({
      logLevel: "silent",
      plugins: [testAuth, audit({ store, routes: false })],
      routes: [
        route.post("/bulk", {
          body: t.object({ ids: t.array(t.string()) }),
          handler: async (ctx) => {
            const recs = await ctx.audit.logMany(ctx.body.ids.map((id) => ({ action: "update", resource: "contacts", resourceId: id, before: { a: 1 }, after: { a: 2 } })));
            return { seqs: recs.map((r) => r.seq) };
          },
        }),
      ],
    });
    const res = await app.request("/bulk", { method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({ ids: ["1", "2"] }) });
    expect(await res.json()).toEqual({ seqs: [1, 2] });
    const page = await store.query({});
    expect(page.items.map((r) => [r.resourceId, r.actor, r.org, r.changes])).toEqual([
      ["2", "alice", "org1", { a: { before: 1, after: 2 } }],
      ["1", "alice", "org1", { a: { before: 1, after: 2 } }],
    ]);
    expect((await verifyChain(store)).ok).toBe(true);
  });

  test("app.service('audit') logs outside requests as a system actor", async () => {
    const store = memoryAuditStore();
    const app = miu({ logLevel: "silent", plugins: [audit({ store, routes: false, redact: ["secretNote"] })] });
    await app.ready();
    const svc = app.service<AuditService>("audit");
    const rec = await svc.log({ action: "create", resource: "tasks", resourceId: "t1", after: { title: "x", secretNote: "hide" } }, { org: "org1" });
    expect(rec).toMatchObject({ actor: "system", org: "org1", ip: null, requestId: null });
    expect(rec.changes!.secretNote).toBe("[REDACTED]");
    const many = await svc.logMany([{ action: "a", resource: "r" }, { action: "b", resource: "r" }], { actor: "job:nightly" });
    expect(many.map((r) => [r.seq, r.actor, r.org])).toEqual([
      [2, "job:nightly", null],
      [3, "job:nightly", null],
    ]);
    expect((await svc.query({ actor: "system" })).items).toHaveLength(1);
  });
});
