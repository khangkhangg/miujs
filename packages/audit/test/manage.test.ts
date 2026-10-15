// The admin management section: a filtered, paged audit log, entries in the last 24 h, and a
// bounded export. Read only: the audit log is append-only, so there is nothing to delete.
import { describe, expect, test } from "bun:test";
import { miu, validate, type Context, type ManageList, type ManageSection } from "miujs";
import { sqlite } from "@miujs/db";
import { audit, dbAuditStore, memoryAuditStore, type AuditStore } from "../src/index.ts";

const KEY = "k".repeat(40);
const HOUR = 3_600_000;
const ctx = (org?: string) => ({ env: {}, ...(org ? { org: { id: org } } : {}) }) as unknown as Context;
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);

const STORES: [string, () => AuditStore][] = [
  ["memory", () => memoryAuditStore({ key: KEY })],
  ["db", () => dbAuditStore(sqlite(), { key: KEY })],
];

for (const [name, makeStore] of STORES) {
  describe(`audit manage (${name})`, () => {
    async function make() {
      const store = makeStore();
      const now = Date.now();
      const rows = [
        { ts: now - 48 * HOUR, action: "create", resource: "contacts", resourceId: "c1", actor: "alice", org: "o1", ip: "=1+1" },
        { ts: now - 3 * HOUR, action: "update", resource: "contacts", resourceId: "c1", actor: "bob", org: "o1", changes: { name: { before: "A", after: "B" }, email: { after: "=cmd()" } } },
        { ts: now - 2 * HOUR, action: "delete", resource: "deals", resourceId: "d1", actor: "alice", org: "o2", metadata: { password: "[REDACTED]" } },
        { ts: now - 1 * HOUR, action: "update", resource: "deals", resourceId: "d2", actor: "alice", org: "o1" },
      ];
      for (const r of rows) await store.append(r);
      const plugin = audit({ store, key: KEY });
      await miu({ logLevel: "silent", plugins: [plugin] }).ready();
      const sections = plugin.manage!();
      expect(sections.map((s) => s.id)).toEqual(["audit"]);
      return { store, now, s: sections[0] };
    }
    const log = (s: ManageSection): ManageList => s.lists!.find((l) => l.name === "log")!;

    test("status: entries in the last 24 h, the newest entry and signing; no delete anywhere", async () => {
      const { s } = await make();
      const st = await s.status!(ctx());
      const by = Object.fromEntries(st.stats!.map((x) => [x.label, x.value]));
      expect(by).toMatchObject({ "Last 24 h": 3, Entries: 4, Signed: true, Store: name });
      expect(typeof by["Latest entry"]).toBe("string");
      expect(s.description).toMatch(/append-only/i);
      const names = [...(s.actions ?? []), ...(s.lists ?? []).flatMap((l) => l.rowActions ?? [])].map((a) => a.name);
      expect(names).toEqual(["export"]);
      expect(names.some((n) => /delete|purge/i.test(n))).toBe(false);
      expect(s.settings).toBeUndefined();
      expect(JSON.stringify(st)).not.toContain(KEY);
    });

    test("an empty, unsigned log", async () => {
      const plugin = audit({ store: name === "db" ? dbAuditStore(sqlite()) : memoryAuditStore() });
      const st = await plugin.manage!()[0].status!(ctx());
      expect(Object.fromEntries(st.stats!.map((x) => [x.label, x.value]))).toMatchObject({ "Last 24 h": 0, Entries: 0, "Latest entry": null, Signed: false });
      expect(st.stats!.find((x) => x.label === "Signed")!.tone).toBe("warning");
    });

    test("log: newest first, paged, with changed field names and no hashes", async () => {
      const { s } = await make();
      const l = log(s);
      expect(l.idKey).toBe("seq");
      expect(l.searchable).toBe(true);
      const p1 = await l.list({ limit: 3 }, ctx());
      expect(p1.rows.map((r) => r.seq)).toEqual([4, 3, 2]);
      expect(p1.rows[2]).toMatchObject({ actor: "bob", action: "update", resource: "contacts", resourceId: "c1", org: "o1", changed: "email, name" });
      expect(typeof p1.rows[0].ts).toBe("string");
      expect(JSON.stringify(p1)).not.toMatch(/"hash"|prevHash/);
      const p2 = await l.list({ limit: 3, cursor: p1.next }, ctx());
      expect(p2.rows.map((r) => r.seq)).toEqual([1]);
      expect(p2.next).toBeUndefined();
    });

    test("log: search filters by actor, action, resource, id and dates; range filter", async () => {
      const { s, now } = await make();
      const l = log(s);
      const seqs = async (search: string, filters?: Record<string, string>) => (await l.list({ limit: 50, search, filters }, ctx())).rows.map((r) => r.seq);
      expect(await seqs("actor:alice")).toEqual([4, 3, 1]);
      expect(await seqs("action:update")).toEqual([4, 2]);
      expect(await seqs("resource:deals action:update")).toEqual([4]);
      expect(await seqs("contacts")).toEqual([2, 1]);
      expect(await seqs("resource:contacts id:c1 actor:bob")).toEqual([2]);
      expect(await seqs(`since:${new Date(now - 2.5 * HOUR).toISOString()}`)).toEqual([4, 3]);
      expect(await seqs(`until:${now - 2.5 * HOUR}`)).toEqual([2, 1]);
      expect(await seqs("org:o2")).toEqual([3]);
      expect(await seqs("", { range: "24h" })).toEqual([4, 3, 2]);
      // With both, the later start wins.
      expect(await seqs(`since:${now - 1.5 * HOUR}`, { range: "24h" })).toEqual([4]);
      expect(await seqs(`since:${new Date(now - 72 * HOUR).toISOString()}`, { range: "24h" })).toEqual([4, 3, 2]);
      expect(l.filters).toEqual([{ key: "range", label: "Time", options: ["1h", "24h", "7d", "30d"] }]);
      await expect(attempt(() => l.list({ limit: 5, search: "colour:red" }, ctx()))).rejects.toThrow(/colour/);
      await expect(attempt(() => l.list({ limit: 5, filters: { range: "1y" } }, ctx()))).rejects.toThrow(/range/);
      await expect(attempt(() => l.list({ limit: 5, search: "since:yesterday-ish" }, ctx()))).rejects.toMatchObject({ code: "MIU_E_AUDIT_QUERY_INVALID" });
      await expect(attempt(() => l.list({ limit: 5, cursor: "abc" }, ctx()))).rejects.toMatchObject({ code: "MIU_E_AUDIT_QUERY_INVALID" });
    });

    test("an active organization limits the log and export to it", async () => {
      const { s } = await make();
      expect((await log(s).list({ limit: 50 }, ctx("o2"))).rows.map((r) => r.seq)).toEqual([3]);
      await expect(attempt(() => log(s).list({ limit: 50, search: "org:o1" }, ctx("o2")))).rejects.toMatchObject({ code: "MIU_E_AUDIT_ORG_MISMATCH" });
      const ex = (await s.actions![0].run({ format: "json" }, ctx("o2"))) as { count: number };
      expect(ex.count).toBe(1);
    });

    test("export: bounded JSON or CSV with formula-safe cells, validated input", async () => {
      const { s } = await make();
      const ex = s.actions!.find((a) => a.name === "export")!;
      expect(ex.danger).toBeFalsy();
      expect(validate(ex.input!, { format: "xml" }).ok).toBe(false);
      expect(validate(ex.input!, { limit: 0 }).ok).toBe(false);
      expect(validate(ex.input!, { limit: 1001 }).ok).toBe(false);
      expect(validate(ex.input!, {}).ok).toBe(true);

      const json = (await ex.run({ action: "update" }, ctx())) as { format: string; count: number; truncated: boolean; data: any[]; message: string };
      expect(json).toMatchObject({ format: "json", count: 2, truncated: false });
      expect(json.data.map((r) => r.seq)).toEqual([4, 2]);
      expect(json.data[1]).toMatchObject({ actor: "bob", changes: { name: { before: "A", after: "B" } } });
      expect(json.data[1].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(json.message).toMatch(/2 entries/);

      const two = (await ex.run({ limit: 2 }, ctx())) as { count: number; truncated: boolean; message: string };
      expect(two).toMatchObject({ count: 2, truncated: true });
      expect(two.message).toMatch(/more/i);

      const csv = (await ex.run({ format: "csv", resource: "contacts" }, ctx())) as { data: string };
      const lines = csv.data.trim().split("\n");
      expect(lines[0]).toBe("seq,ts,actor,action,resource,resourceId,org,ip,userAgent,requestId,changes,metadata,keyId,hash");
      expect(lines).toHaveLength(3);
      expect(csv.data).toContain(",'=1+1,");
      expect(csv.data).not.toMatch(/(^|,)=1\+1/m);
      expect(csv.data).toContain('"{""email"":{""after"":""=cmd()""}');
    });
  });
}
