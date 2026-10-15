import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTableConfig, integer, real, sqliteTable, text, blob, numeric } from "drizzle-orm/sqlite-core";
import { miu, route, t, validate } from "miujs";
import { db, introspect, migrate, sqlite } from "../src/index.ts";
import { drizzleFor, schemaFromTable, tableFromSchema } from "../src/drizzle.ts";

const Contact = t.object({
  id: t.integer(),
  name: t.string({ maxLength: 100 }),
  email: t.string({ format: "email" }),
  score: t.number(),
  vip: t.boolean(),
  stage: t.enum(["lead", "customer", "churned"]),
  notes: t.optional(t.string()),
  phone: t.nullable(t.string()),
  createdAt: t.string({ format: "date-time" }),
  tags: t.default(t.array(t.string()), []),
  active: t.default(t.boolean(), true),
});

const contacts = tableFromSchema("contacts", Contact, { indexes: ["email", { columns: ["stage", "createdAt"] }, { columns: ["name"], unique: true }] });

describe("tableFromSchema(): SQL", () => {
  test("maps t types to SQLite column types, NOT NULL, defaults and CHECKs", () => {
    expect(contacts.sql[0]).toBe(
      [
        `CREATE TABLE "contacts" (`,
        `  "id" INTEGER PRIMARY KEY,`,
        `  "name" TEXT NOT NULL,`,
        `  "email" TEXT NOT NULL,`,
        `  "score" REAL NOT NULL,`,
        `  "vip" INTEGER NOT NULL CHECK ("vip" IN (0, 1)),`,
        `  "stage" TEXT NOT NULL CHECK ("stage" IN ('lead', 'customer', 'churned')),`,
        `  "notes" TEXT,`,
        `  "phone" TEXT,`,
        `  "createdAt" TEXT NOT NULL,`,
        `  "tags" TEXT NOT NULL DEFAULT '[]',`,
        `  "active" INTEGER NOT NULL DEFAULT 1 CHECK ("active" IN (0, 1))`,
        `)`,
      ].join("\n"),
    );
  });

  test("indexes become CREATE INDEX statements", () => {
    expect(contacts.sql.slice(1)).toEqual([
      `CREATE INDEX "contacts_email_idx" ON "contacts" ("email")`,
      `CREATE INDEX "contacts_stage_createdAt_idx" ON "contacts" ("stage", "createdAt")`,
      `CREATE UNIQUE INDEX "contacts_name_unique" ON "contacts" ("name")`,
    ]);
  });

  test("the SQL runs and introspects back to the same description", async () => {
    const database = sqlite();
    await migrate(database, [contacts.migration("0001_contacts")]);
    const [table] = (await introspect(database)).tables;
    expect(table.columns.map((c) => [c.name, c.type, c.notNull])).toEqual(contacts.description.columns.map((c) => [c.name, c.type, c.notNull]));
    expect(table.indexes.map((i) => i.name).sort()).toEqual(["contacts_email_idx", "contacts_name_unique", "contacts_stage_createdAt_idx"]);
  });

  test("composite and explicit primary keys", () => {
    const m = tableFromSchema("memberships", t.object({ userId: t.string(), orgId: t.string(), role: t.string() }), { primaryKey: ["userId", "orgId"] });
    expect(m.sql[0]).toContain(`PRIMARY KEY ("userId", "orgId")`);
    const k = tableFromSchema("kv", t.object({ key: t.string(), value: t.string() }), { primaryKey: "key" });
    expect(k.sql[0]).toContain(`"key" TEXT PRIMARY KEY NOT NULL`);
    expect(getTableConfig(k.table).columns.find((c) => c.name === "key")!.primary).toBe(true);
  });

  test("no id and no primaryKey means a rowid table", () => {
    const e = tableFromSchema("events", t.object({ name: t.string() }));
    expect(e.sql[0]).toBe(`CREATE TABLE "events" (\n  "name" TEXT NOT NULL\n)`);
  });

  test("numeric enums, literals, nullable+optional and json columns", () => {
    const x = tableFromSchema(
      "x",
      t.object({
        level: t.enum([1, 2, 3]),
        kind: t.literal("note"),
        maybe: t.optional(t.nullable(t.integer())),
        meta: t.record(t.string()),
        any: t.any(),
      }),
    );
    expect(x.sql[0]).toContain(`"level" INTEGER NOT NULL CHECK ("level" IN (1, 2, 3))`);
    expect(x.sql[0]).toContain(`"kind" TEXT NOT NULL CHECK ("kind" IN ('note'))`);
    expect(x.sql[0]).toContain(`"maybe" INTEGER,`);
    expect(x.sql[0]).toContain(`"meta" TEXT NOT NULL`);
    expect(x.sql[0]).toContain(`"any" TEXT\n`);
  });

  test("rejects unknown keys in options with a fix", () => {
    let err: any;
    try {
      tableFromSchema("bad", t.object({ a: t.string() }), { primaryKey: "nope" as any });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_DB_SCHEMA");
    expect(err.fix).toContain("a");
  });
});

describe("tableFromSchema(): Drizzle table", () => {
  test("real queries round-trip typed values", async () => {
    const database = sqlite();
    await migrate(database, [contacts.migration("0001")]);
    const orm = drizzleFor(database);
    const row = {
      name: "Ada",
      email: "ada@x.io",
      score: 9.5,
      vip: true,
      stage: "lead" as const,
      phone: null,
      createdAt: "2026-01-02T03:04:05Z",
    };
    const [inserted] = await orm.insert(contacts.table).values(row).returning();
    expect(inserted).toEqual({ id: 1, ...row, notes: null, tags: [], active: true });
    await orm.update(contacts.table).set({ tags: ["a", "b"], vip: false }).where(eq(contacts.table.id, 1));
    const found = await orm.select().from(contacts.table).where(eq(contacts.table.email, "ada@x.io")).get();
    expect(found?.tags).toEqual(["a", "b"]);
    expect(found?.vip).toBe(false);
    // Typed: these lines fail `tsc` if the column types are lost.
    const n: number = found!.id;
    const s: "lead" | "customer" | "churned" = found!.stage;
    const p: string | null = found!.phone;
    expect([n, s, p]).toEqual([1, "lead", null]);
  });

  test("the CHECK constraint rejects values outside the enum", async () => {
    const database = sqlite();
    await migrate(database, [contacts.migration("0001")]);
    await expect(
      database
        .prepare(`INSERT INTO contacts (name, email, score, vip, stage, phone, createdAt) VALUES ('a', 'b', 1, 1, 'zombie', NULL, 'c')`)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  test("works as the plugin's schema: one definition for the API and the DB", async () => {
    const app = miu({
      plugins: [db({ migrations: [contacts.migration("0001")], drizzle: { schema: { contacts: contacts.table } } })],
      routes: [
        route.post("/contacts", {
          body: schemaFromTable(contacts.table),
          handler: async (ctx) => (await ctx.orm.insert(contacts.table).values(ctx.body).returning())[0],
        }),
      ],
      logLevel: "silent",
    });
    const ok = await app.fetch(
      new Request("http://localhost/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bo", email: "bo@x.io", score: 1, vip: false, stage: "customer", phone: "1", createdAt: "2026-01-01T00:00:00Z" }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 1, name: "Bo", active: true, tags: [] });
    const bad = await app.fetch(
      new Request("http://localhost/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bo", stage: "zombie" }),
      }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("schemaFromTable()", () => {
  const items = sqliteTable("items", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title", { length: 20 }).notNull(),
    status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
    price: real("price"),
    qty: integer("qty").notNull(),
    flag: integer("flag", { mode: "boolean" }).notNull(),
    at: integer("at", { mode: "timestamp" }),
    data: text("data", { mode: "json" }),
    bin: blob("bin"),
    dec: numeric("dec"),
  });

  test("insert mode (default): defaults, nullable and integer primary keys are optional", () => {
    const s = schemaFromTable(items);
    expect(s.json).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string", maxLength: 20 },
        status: { type: "string", enum: ["open", "done"] },
        price: { anyOf: [{ type: "number" }, { type: "null" }] },
        qty: { type: "integer" },
        flag: { type: "boolean" },
        at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
        data: { anyOf: [{}, { type: "null" }] },
        bin: { anyOf: [{}, { type: "null" }] },
        dec: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["title", "qty", "flag"],
    });
    expect(validate(s, { title: "x", qty: 1, flag: true }).ok).toBe(true);
    expect(validate(s, { title: "x", qty: 1, flag: true, status: "nope" }).ok).toBe(false);
    expect(validate(s, { title: "x".repeat(21), qty: 1, flag: true }).ok).toBe(false);
    expect(validate(s, { title: "x", qty: 1.5, flag: true }).ok).toBe(false);
  });

  test("select mode: every column is required, nullable ones accept null", () => {
    const s = schemaFromTable(items, { mode: "select" });
    expect((s.json as any).required).toEqual(["id", "title", "status", "price", "qty", "flag", "at", "data", "bin", "dec"]);
    expect(validate(s, { id: 1, title: "x", status: "open", price: null, qty: 1, flag: false, at: null, data: null, bin: null, dec: null }).ok).toBe(true);
  });

  test("uses property keys, not SQL column names", () => {
    const tbl = sqliteTable("people", { firstName: text("first_name").notNull() });
    expect(Object.keys((schemaFromTable(tbl).json as any).properties)).toEqual(["firstName"]);
  });

  test("round trip: tableFromSchema then schemaFromTable keeps the validation rules", () => {
    const s = schemaFromTable(contacts.table);
    const good = { name: "A", email: "a@b.co", score: 1, vip: true, stage: "lead", phone: null, createdAt: "2026-01-01T00:00:00Z" };
    expect(validate(s, good).ok).toBe(true);
    expect(validate(s, { ...good, stage: "nope" }).ok).toBe(false);
    expect(validate(s, { ...good, name: "x".repeat(101) }).ok).toBe(false);
    expect(validate(s, { ...good, email: "not-an-email" }).ok).toBe(false);
    expect(validate(s, { ...good, createdAt: "yesterday" }).ok).toBe(false);
  });
});

describe("follow-up: inner schemas, t.date(), references, casing", () => {
  test("a default of null on a nullable field keeps both (read via .inner, not JSON sniffing)", () => {
    const x = tableFromSchema("x", t.object({ note: t.default(t.nullable(t.string()), null) }));
    expect(x.sql[0]).toContain(`"note" TEXT DEFAULT NULL`);
  });

  test("t.date() becomes an INTEGER millisecond timestamp column holding Dates", async () => {
    const ev = tableFromSchema("events", t.object({ id: t.integer(), at: t.date(), seen: t.optional(t.date()) }));
    expect(ev.sql[0]).toContain(`"at" INTEGER NOT NULL`);
    expect(ev.sql[0]).toContain(`"seen" INTEGER,`.slice(0, -1));
    const col = getTableConfig(ev.table).columns.find((c) => c.name === "at")!;
    expect([col.dataType, col.columnType]).toEqual(["date", "SQLiteTimestamp"]);
    const database = sqlite();
    await migrate(database, [ev.migration("1")]);
    const orm = drizzleFor(database);
    const when = new Date("2026-03-04T05:06:07.890Z");
    await orm.insert(ev.table).values({ at: when });
    const row = await orm.select().from(ev.table).get();
    const typed: Date = row!.at;
    expect(typed.toISOString()).toBe(when.toISOString());
    expect(await database.prepare("SELECT at FROM events").first("at")).toBe(when.getTime());
  });

  test("schemaFromTable maps timestamp columns to t.date()", () => {
    const tbl = sqliteTable("ts", {
      a: integer("a", { mode: "timestamp" }).notNull(),
      b: integer("b", { mode: "timestamp_ms" }),
    });
    const s = schemaFromTable(tbl);
    expect(s.shape.a.kind).toBe("date");
    const r = validate(s, { a: "2026-01-01T00:00:00Z", b: null });
    expect(r.ok).toBe(true);
    expect((r as any).value.a).toBeInstanceOf(Date);
    expect(schemaFromTable(tbl, { mode: "select" }).shape.b.kind).toBe("date");
  });

  const Company = t.object({ id: t.integer(), legalName: t.string() });
  const companies = tableFromSchema("companies", Company, { casing: "snake_case" });

  test("casing: snake_case renames SQL columns, keeps camelCase keys", async () => {
    expect(companies.sql[0]).toBe(`CREATE TABLE "companies" (\n  "id" INTEGER PRIMARY KEY,\n  "legal_name" TEXT NOT NULL\n)`);
    expect(getTableConfig(companies.table).columns.map((c) => c.name)).toEqual(["id", "legal_name"]);
    const p = tableFromSchema("people", t.object({ personID: t.string(), firstName: t.string(), createdAt: t.date() }), {
      casing: "snake_case",
      primaryKey: "personID",
      indexes: [["firstName", "createdAt"]],
    });
    expect(p.description.columns.map((c) => c.name)).toEqual(["person_id", "first_name", "created_at"]);
    expect(p.sql[1]).toBe(`CREATE INDEX "people_first_name_created_at_idx" ON "people" ("first_name", "created_at")`);
    const database = sqlite();
    await migrate(database, [companies.migration("1")]);
    const orm = drizzleFor(database);
    await orm.insert(companies.table).values({ legalName: "Acme" });
    expect(await orm.select().from(companies.table)).toEqual([{ id: 1, legalName: "Acme" }]);
    expect(Object.keys((schemaFromTable(companies.table).json as any).properties)).toEqual(["id", "legalName"]);
  });

  test("references: SQL FOREIGN KEY and Drizzle .references, with casing and onDelete", async () => {
    const contactsT = tableFromSchema(
      "contacts",
      t.object({ id: t.integer(), companyId: t.nullable(t.integer()), managerId: t.optional(t.integer()), name: t.string() }),
      {
        casing: "snake_case",
        references: {
          companyId: { table: companies.table, onDelete: "set null" },
          managerId: { table: "contacts", onDelete: "cascade" },
        },
      },
    );
    expect(contactsT.sql[0]).toContain(`FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE SET NULL`);
    expect(contactsT.sql[0]).toContain(`FOREIGN KEY ("manager_id") REFERENCES "contacts" ("id") ON DELETE CASCADE`);
    const fks = getTableConfig(contactsT.table).foreignKeys.map((fk) => {
      const r = fk.reference();
      return [r.columns[0].name, getTableConfig(r.foreignTable).name, r.foreignColumns[0].name, fk.onDelete];
    });
    expect(fks).toEqual([
      ["company_id", "companies", "id", "set null"],
      ["manager_id", "contacts", "id", "cascade"],
    ]);

    const database = sqlite();
    await migrate(database, [companies.migration("1"), contactsT.migration("2")]);
    const orm = drizzleFor(database);
    await orm.insert(companies.table).values({ legalName: "Acme" });
    await orm.insert(contactsT.table).values({ companyId: 1, name: "Boss" });
    await orm.insert(contactsT.table).values({ companyId: 1, managerId: 1, name: "Report" });
    // Drizzle wraps driver errors ("Failed query: ..."); the SQLite error is the cause.
    const fkErr: any = await orm.insert(contactsT.table).values({ companyId: 99, name: "Ghost" }).run().catch((e) => e);
    expect(String(fkErr?.cause?.message ?? fkErr)).toMatch(/FOREIGN KEY/);
    await orm.delete(companies.table);
    expect((await orm.select().from(contactsT.table)).map((c) => c.companyId)).toEqual([null, null]);
    await orm.delete(contactsT.table).where(eq(contactsT.table.id, 1));
    expect(await orm.select().from(contactsT.table)).toEqual([]);
  });

  test("references accept a tableFromSchema result and an explicit column", () => {
    const users = tableFromSchema("users", t.object({ id: t.integer(), handle: t.string() }), { indexes: [{ columns: ["handle"], unique: true }] });
    const posts = tableFromSchema("posts", t.object({ id: t.integer(), author: t.string() }), {
      references: { author: { table: users, column: "handle", onDelete: "restrict" } },
    });
    expect(posts.sql[0]).toContain(`FOREIGN KEY ("author") REFERENCES "users" ("handle") ON DELETE RESTRICT`);
  });

  test("bad references explain the fix", () => {
    const codeOf = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as any;
      }
    };
    const unknownField = codeOf(() => tableFromSchema("a", t.object({ x: t.integer() }), { references: { y: { table: companies.table } } as any }));
    expect(unknownField?.code).toBe("MIU_E_DB_SCHEMA");
    const unknownColumn = codeOf(() => tableFromSchema("a", t.object({ x: t.integer() }), { references: { x: { table: companies.table, column: "nope" } } }));
    expect(unknownColumn?.code).toBe("MIU_E_DB_SCHEMA");
    expect(unknownColumn.fix).toContain("legalName");
    const otherString = codeOf(() => tableFromSchema("a", t.object({ x: t.integer() }), { references: { x: { table: "companies" } } }));
    expect(otherString?.code).toBe("MIU_E_DB_SCHEMA");
    expect(otherString.fix).toContain("table object");
  });
});
