// List queries on large tables: sorted pages must be index range reads, not a sort of every row
// of the organization (at 100k contacts that was ~25 ms per page; with the index ~0.1 ms).

import { describe, expect, test } from "bun:test";
import { sqlite, type Database } from "@miujs/db";
import { adminMigrations, field, resource } from "../src/index.ts";
import { crmResources } from "../src/crm.ts";
import { setup } from "./helpers.ts";

const people = resource("people", {
  fields: {
    name: field.text({ required: true }),
    score: field.money({ currency: "USD" }),
    seen: field.date(),
  },
  tenant: "org",
  softDelete: true,
  views: { recent: { sort: "-seen" } },
});

/** Runs a list through the API while recording the SQL, then returns the main query's plan. */
async function planOf(path: string): Promise<string[]> {
  const h = await setup([people]);
  const seen: { sql: string; values: unknown[] }[] = [];
  const db = h.db as Database & { prepare: Database["prepare"] };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st = prepare(sql);
    const bind = st.bind.bind(st);
    (st as { bind: typeof st.bind }).bind = (...values: unknown[]) => {
      if (/FROM "people"/.test(sql) && /ORDER BY/.test(sql)) seen.push({ sql, values });
      return bind(...values);
    };
    return st;
  };
  expect((await h.req("GET", path)).status).toBe(200);
  db.prepare = prepare;
  expect(seen.length).toBeGreaterThan(0);
  const plans: string[] = [];
  for (const s of seen) plans.push(...(await h.db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.values).all<{ detail: string }>()).results.map((r) => r.detail));
  return plans;
}

describe("sorted lists use an index", () => {
  for (const path of ["/api/people?sort=name", "/api/people?sort=-name", "/api/people?sort=score", "/api/people?sort=-score", "/api/people?view=recent"]) {
    test(path, async () => {
      const plan = await planOf(path);
      expect(plan.join(" | ")).not.toContain("TEMP B-TREE");
    });
  }

  test("the CRM's title, money and view-sorted fields have sort indexes, also as a migration for existing databases", async () => {
    const db = sqlite();
    for (const m of adminMigrations(crmResources())) await db.exec(m.sql);
    const idx = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_sort_idx'").all<{ name: string }>()).results.map((r) => r.name).sort();
    expect(idx).toEqual(["activities_occurred_at_sort_idx", "activities_subject_sort_idx", "companies_name_sort_idx", "contacts_name_sort_idx", "contacts_value_sort_idx", "deals_amount_sort_idx", "deals_title_sort_idx", "tasks_title_sort_idx"].sort());
    expect(adminMigrations(crmResources()).map((m) => m.id)).toContain("admin_002_contacts_sort_indexes");
  });
});

describe("nullable sorts keep their order (values first, NULLs last, both directions) across pages", () => {
  test("cursor paging crosses from values into NULLs", async () => {
    const h = await setup([people]);
    const scores = [5, null, 1, 3, null, 3, 9, null, 2];
    for (const [i, s] of scores.entries()) await h.req("POST", "/api/people", { body: { name: `p${i}`, score: s } });
    const all = async (sort: string, limit: number) => {
      const out: (number | null)[] = [];
      let cursor: string | null = null;
      do {
        const r: { body: { items: { score: number | null }[]; nextCursor: string | null } } = await h.req("GET", `/api/people?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        out.push(...r.body.items.map((x) => x.score));
        cursor = r.body.nextCursor;
      } while (cursor);
      return out;
    };
    for (const limit of [1, 2, 4, 50]) {
      expect(await all("score", limit)).toEqual([1, 2, 3, 3, 5, 9, null, null, null]);
      expect(await all("-score", limit)).toEqual([9, 5, 3, 3, 2, 1, null, null, null]);
    }
  });
});

describe("lookups by id use the primary key", () => {
  test("bulk, read-back and include (id IN lists) never scan the organization's rows", async () => {
    const h = await setup([people]);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push((await h.req("POST", "/api/people", { body: { name: `p${i}` } })).body.id);
    const seen: { sql: string; values: unknown[] }[] = [];
    const db = h.db as Database & { prepare: Database["prepare"] };
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const st = prepare(sql);
      const bind = st.bind.bind(st);
      (st as { bind: typeof st.bind }).bind = (...values: unknown[]) => {
        if (/^SELECT \* FROM "people" WHERE "id" (IN|=)/.test(sql)) seen.push({ sql, values });
        return bind(...values);
      };
      return st;
    };
    expect((await h.req("POST", "/api/people/bulk", { body: { action: "update", ids, changes: { score: 5 } } })).status).toBe(200);
    expect((await h.req("GET", `/api/people/${ids[0]}`)).status).toBe(200);
    db.prepare = prepare;
    expect(seen.length).toBeGreaterThan(1);
    for (const s of seen) {
      const plan = (await h.db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.values).all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");
      expect([s.sql.slice(0, 60), plan]).toEqual([s.sql.slice(0, 60), expect.stringContaining("sqlite_autoindex_people_1") as unknown as string]);
    }
  });
});
