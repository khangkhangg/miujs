// Tables, indexes, FTS5 and migrations for a set of resources.

import { quoteIdent, tableSql, type ColumnDescription, type IndexDescription, type Migration, type TableDescription } from "@miujs/db";
import { adminErrors } from "./errors.ts";
import { sqlType } from "./fields.ts";
import type { Resource } from "./resource.ts";
import { systemMigration } from "./system-settings.ts";

/** Checks names are unique and every relation points at a resource in the set. */
export function checkResources(resources: readonly Resource[]): Map<string, Resource> {
  const byName = new Map<string, Resource>();
  const tables = new Set<string>();
  for (const r of resources) {
    if (byName.has(r.name)) throw adminErrors.resourceDuplicate(r.name);
    if (tables.has(r.table)) throw adminErrors.resourceInvalid(`Two resources use the table "${r.table}"`, "Give one of them a different `table`.");
    byName.set(r.name, r);
    tables.add(r.table);
  }
  for (const r of resources) {
    for (const f of Object.values(r.fields)) {
      if (f.type === "relation" && !byName.has(f.options.target!)) throw adminErrors.relationUnknown(r.name, f.name, f.options.target!, [...byName.keys()]);
    }
  }
  return byName;
}

/** Relation targets before the resources that point at them (cycles keep their given order). */
export function orderByDependencies(resources: readonly Resource[]): Resource[] {
  const byName = new Map(resources.map((r) => [r.name, r]));
  const out: Resource[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (r: Resource) => {
    if (state.get(r.name)) return;
    state.set(r.name, "visiting");
    for (const f of Object.values(r.fields)) {
      const target = f.type === "relation" ? byName.get(f.options.target!) : undefined;
      if (target && target !== r) visit(target);
    }
    state.set(r.name, "done");
    out.push(r);
  };
  for (const r of resources) visit(r);
  return out;
}

/** Plain table description (the `introspect()` shape) for one resource. */
export function tableDescription(r: Resource, byName: Map<string, Resource>): TableDescription {
  const columns: ColumnDescription[] = [{ name: "id", type: "TEXT", notNull: true, default: null, primaryKey: true }];
  const tenant = r.tenant === "org";
  if (tenant) columns.push({ name: "org_id", type: "TEXT", notNull: true, default: null, primaryKey: false });
  for (const f of Object.values(r.fields)) {
    columns.push({ name: f.column, type: sqlType(f), notNull: !!f.options.required, default: null, primaryKey: false });
  }
  if (r.timestamps) {
    columns.push(
      { name: "created_at", type: "INTEGER", notNull: true, default: null, primaryKey: false },
      { name: "updated_at", type: "INTEGER", notNull: true, default: null, primaryKey: false },
      { name: "created_by", type: "TEXT", notNull: false, default: null, primaryKey: false },
      { name: "updated_by", type: "TEXT", notNull: false, default: null, primaryKey: false },
    );
  }
  if (r.softDelete) columns.push({ name: "deleted_at", type: "INTEGER", notNull: false, default: null, primaryKey: false });

  const scope = tenant ? ["org_id"] : [];
  const live = r.softDelete ? `${quoteIdent("deleted_at")} IS NULL` : undefined;
  const indexes: IndexDescription[] = [];
  if (tenant) indexes.push({ name: `${r.table}_org_${r.timestamps ? "created_" : ""}idx`, columns: r.timestamps ? ["org_id", "created_at"] : ["org_id"], unique: false, origin: "c" });
  for (const f of Object.values(r.fields)) {
    if (f.options.unique) {
      const idx: IndexDescription = { name: `${r.table}_${f.column}_unique`, columns: [...scope, f.column], unique: true, origin: "c" };
      if (live) idx.where = live;
      indexes.push(idx);
    } else if (f.type === "relation") {
      indexes.push({ name: `${r.table}_${f.column}_idx`, columns: [f.column], unique: false, origin: "c" });
    } else if (f.options.index) {
      indexes.push({ name: `${r.table}_${f.column}_idx`, columns: [...scope, f.column], unique: false, origin: "c" });
    }
  }
  const foreignKeys = Object.values(r.fields)
    .filter((f) => f.type === "relation")
    .map((f) => ({
      columns: [f.column],
      table: byName.get(f.options.target!)!.table,
      references: ["id"],
      onUpdate: "NO ACTION",
      onDelete: (f.options.onDelete ?? "no action").toUpperCase(),
    }));
  return { name: r.table, columns, primaryKey: ["id"], indexes, foreignKeys };
}

/** Table descriptions for every resource (feed them to `diffSchema` from `@miujs/db/drizzle`). */
export function adminTables(resources: readonly Resource[]): TableDescription[] {
  const byName = checkResources(resources);
  return orderByDependencies(resources).map((r) => tableDescription(r, byName));
}

export function ftsTable(r: Resource): string {
  return `${r.table}_fts`;
}

export function searchColumns(r: Resource): string[] {
  return Object.values(r.fields)
    .filter((f) => f.options.searchable)
    .map((f) => f.column);
}

/** FTS5 table keyed by the record id, plus triggers that keep it in sync with the table. */
export function ftsSql(r: Resource): string[] {
  const fts = quoteIdent(ftsTable(r));
  const table = quoteIdent(r.table);
  const cols = searchColumns(r);
  const list = ["id", ...cols].map(quoteIdent).join(", ");
  const values = (row: "new" | "old") => ["id", ...cols].map((c) => `${row}.${quoteIdent(c)}`).join(", ");
  const trig = (suffix: string) => quoteIdent(`${ftsTable(r)}_${suffix}`);
  return [
    `CREATE VIRTUAL TABLE ${fts} USING fts5(${quoteIdent("id")} UNINDEXED, ${cols.map(quoteIdent).join(", ")}, tokenize = 'unicode61 remove_diacritics 2')`,
    `CREATE TRIGGER ${trig("ai")} AFTER INSERT ON ${table} BEGIN INSERT INTO ${fts} (${list}) VALUES (${values("new")}); END`,
    `CREATE TRIGGER ${trig("ad")} AFTER DELETE ON ${table} BEGIN DELETE FROM ${fts} WHERE ${quoteIdent("id")} = old.${quoteIdent("id")}; END`,
    `CREATE TRIGGER ${trig("au")} AFTER UPDATE OF ${cols.map(quoteIdent).join(", ")} ON ${table} BEGIN DELETE FROM ${fts} WHERE ${quoteIdent("id")} = old.${quoteIdent("id")}; INSERT INTO ${fts} (${list}) VALUES (${values("new")}); END`,
  ];
}

/**
 * Migrations creating every resource's table, indexes and (with `search: true`) FTS5 index and
 * triggers. One migration per resource, ids `admin_001_<table>`; relation targets come first.
 * Later schema changes need new migrations of your own (see `adminTables` + `diffSchema`).
 * The last migration, `admin_system_001_settings`, creates `admin_system_settings` (System settings).
 */
export function adminMigrations(resources: readonly Resource[]): Migration[] {
  const byName = checkResources(resources);
  const own = orderByDependencies(resources).map((r) => {
    const statements = [...tableSql(tableDescription(r, byName)), ...(r.search ? ftsSql(r) : [])];
    return { id: `admin_001_${r.table}`, sql: statements.map((s) => `${s};`).join("\n") };
  });
  return [...own, systemMigration];
}
