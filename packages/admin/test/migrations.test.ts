import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { introspect, migrate, sqlite } from "@miujs/db";
import { adminMigrations, adminTables, field, resource } from "../src/index.ts";

const companies = resource("companies", {
  fields: { name: field.text({ required: true, searchable: true }), domain: field.url({ unique: true }) },
  tenant: "org",
  search: true,
});
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true, max: 200, searchable: true }),
    email: field.email({ unique: true, searchable: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    stage: field.select(["lead", "customer"], { default: "lead" }),
    value: field.money(),
    vip: field.boolean(),
    tags: field.tags(),
    nextFollowUp: field.date({ index: true }),
    lastSeen: field.datetime(),
    rating: field.number(),
  },
  tenant: "org",
  softDelete: true,
  search: true,
});
const notes = resource("notes", { fields: { body: field.longText() }, timestamps: false });

describe("adminTables", () => {
  test("columns, keys and indexes", () => {
    const [c] = adminTables([contacts, companies]).filter((t) => t.name === "contacts");
    const col = (n: string) => c.columns.find((x) => x.name === n)!;
    expect(c.columns.map((x) => x.name)).toEqual([
      "id", "org_id", "name", "email", "company", "stage", "value", "vip", "tags", "next_follow_up", "last_seen", "rating",
      "created_at", "updated_at", "created_by", "updated_by", "deleted_at",
    ]);
    expect(col("id")).toMatchObject({ type: "TEXT", primaryKey: true, notNull: true });
    expect(col("org_id")).toMatchObject({ type: "TEXT", notNull: true });
    expect(col("name")).toMatchObject({ type: "TEXT", notNull: true });
    expect(col("email")).toMatchObject({ type: "TEXT", notNull: false });
    expect(col("value").type).toBe("INTEGER");
    expect(col("vip").type).toBe("INTEGER");
    expect(col("last_seen").type).toBe("INTEGER");
    expect(col("rating").type).toBe("REAL");
    expect(col("deleted_at")).toMatchObject({ type: "INTEGER", notNull: false });
    expect(c.foreignKeys).toEqual([{ columns: ["company"], table: "companies", references: ["id"], onUpdate: "NO ACTION", onDelete: "SET NULL" }]);
    const idx = Object.fromEntries(c.indexes.map((i) => [i.name, i]));
    expect(idx.contacts_email_unique).toMatchObject({ columns: ["org_id", "email"], unique: true, where: '"deleted_at" IS NULL' });
    expect(idx.contacts_org_created_idx.columns).toEqual(["org_id", "created_at"]);
    expect(idx.contacts_company_idx.columns).toEqual(["company"]);
    expect(idx.contacts_next_follow_up_idx.columns).toEqual(["org_id", "next_follow_up"]);
  });

  test("no tenant, no timestamps", () => {
    const [n] = adminTables([notes]);
    expect(n.columns.map((x) => x.name)).toEqual(["id", "body"]);
  });

  test("unknown relation targets are refused", () => {
    try {
      adminTables([contacts]);
      throw new Error("expected error");
    } catch (e) {
      expect(isMiuError(e) && e.code).toBe("MIU_E_ADMIN_RELATION_UNKNOWN");
    }
  });

  test("duplicate resources are refused", () => {
    expect(() => adminTables([companies, companies])).toThrow(/Two resources/);
  });
});

describe("adminMigrations", () => {
  test("apply to SQLite: tables, FTS and triggers; targets first", async () => {
    const ms = adminMigrations([contacts, companies, notes]);
    expect(ms.map((m) => m.id)).toEqual(["admin_001_companies", "admin_001_contacts", "admin_001_notes"]);
    const db = sqlite();
    await migrate(db, ms);
    const schema = await introspect(db);
    const names = schema.tables.map((t) => t.name);
    expect(names).toContain("contacts");
    expect(names).toContain("contacts_fts");
    const triggers = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string }>();
    expect(triggers.results.map((r) => r.name)).toEqual(["companies_fts_ad", "companies_fts_ai", "companies_fts_au", "contacts_fts_ad", "contacts_fts_ai", "contacts_fts_au"]);

    // Triggers keep the index in sync.
    await db.prepare("INSERT INTO companies (id, org_id, name, created_at, updated_at) VALUES ('c1', 'o1', 'Acme', 1, 1)").run();
    await db.prepare("INSERT INTO contacts (id, org_id, name, email, company, created_at, updated_at) VALUES ('p1', 'o1', 'Ann Lee', 'ann@acme.io', 'c1', 1, 1)").run();
    const hit = () => db.prepare("SELECT id FROM contacts_fts WHERE contacts_fts MATCH ?").bind('"lee"*').all<{ id: string }>();
    expect((await hit()).results).toEqual([{ id: "p1" }]);
    await db.prepare("UPDATE contacts SET name = 'Ann Smith' WHERE id = 'p1'").run();
    expect((await hit()).results).toEqual([]);
    await db.prepare("DELETE FROM contacts WHERE id = 'p1'").run();
    expect((await db.prepare("SELECT count(*) AS n FROM contacts_fts").first<{ n: number }>())!.n).toBe(0);

    // The partial unique index ignores soft-deleted rows and is per org.
    const ins = (id: string, org: string, deleted: number | null) =>
      db.prepare("INSERT INTO contacts (id, org_id, name, email, created_at, updated_at, deleted_at) VALUES (?, ?, 'x', 'dup@x.io', 1, 1, ?)").bind(id, org, deleted).run();
    await ins("a", "o1", 5);
    await ins("b", "o1", null);
    await ins("c", "o2", null);
    await expect(ins("d", "o1", null)).rejects.toThrow(/UNIQUE/);

    // Re-running applies nothing.
    expect(await migrate(db, adminMigrations([contacts, companies, notes]))).toEqual([]);
  });
});
