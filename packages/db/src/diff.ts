// describeTable / diffSchema: compare a live database (from `introspect`) with the tables an app
// declares (Drizzle tables, `tableFromSchema` results or plain descriptions) and suggest the
// additive SQL to close the gap. Destructive changes are reported, never generated.
// Part of the `@miujs/db/drizzle` entry (imports drizzle-orm).

import { is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { bridgeDescription } from "./bridge.ts";
import {
  affinity,
  createIndexSql,
  quoteIdent,
  tableSql,
  type ColumnDescription,
  type ForeignKeyDescription,
  type IndexDescription,
  type SchemaDescription,
  type TableDescription,
} from "./introspect.ts";

const dialect = new SQLiteSyncDialect();
const render = (s: SQL) => dialect.sqlToQuery(s.inlineParams()).sql;

function literal(v: unknown): string {
  if (v === null) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array) return `X'${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function actionName(a: string | undefined): string {
  return a ? a.toUpperCase() : "NO ACTION";
}

/** A Drizzle `sqliteTable` as a plain description (the `introspect()` shape). */
export function describeTable(table: SQLiteTable): TableDescription {
  const made = bridgeDescription(table);
  if (made) return made;
  const config = getTableConfig(table);
  const pk = config.primaryKeys[0]?.columns.map((c) => c.name) ?? config.columns.filter((c) => c.primary).map((c) => c.name);
  const columns: ColumnDescription[] = config.columns.map((c: AnySQLiteColumn) => {
    const type = c.getSQLType().toUpperCase();
    const isIntegerKey = pk.length === 1 && pk[0] === c.name && affinity(type) === "INTEGER";
    let dflt: string | null = null;
    if (c.default !== undefined) dflt = is(c.default, SQL) ? `(${render(c.default)})` : literal(c.mapToDriverValue(c.default));
    const col: ColumnDescription = { name: c.name, type, notNull: c.notNull && !isIntegerKey, default: dflt, primaryKey: pk.includes(c.name) };
    if ((c as { autoIncrement?: boolean }).autoIncrement) col.autoIncrement = true;
    if (c.enumValues?.length) col.enum = [...c.enumValues];
    return col;
  });
  const indexes: IndexDescription[] = [];
  for (const i of config.indexes) {
    const idx: IndexDescription = {
      name: i.config.name,
      columns: i.config.columns.map((c) => (is(c, SQL) ? "<expr>" : (c as AnySQLiteColumn).name)),
      unique: !!i.config.unique,
      origin: "c",
    };
    if (i.config.where) idx.where = render(i.config.where);
    indexes.push(idx);
  }
  for (const c of config.columns) {
    if (c.isUnique) indexes.push({ name: c.uniqueName ?? `${config.name}_${c.name}_unique`, columns: [c.name], unique: true, origin: "u" });
  }
  for (const u of config.uniqueConstraints) {
    const cols = u.columns.map((c) => c.name);
    indexes.push({ name: u.getName() ?? `${config.name}_${cols.join("_")}_unique`, columns: cols, unique: true, origin: "u" });
  }
  const foreignKeys: ForeignKeyDescription[] = config.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      columns: ref.columns.map((c) => c.name),
      table: getTableConfig(ref.foreignTable).name,
      references: ref.foreignColumns.map((c) => c.name),
      onUpdate: actionName(fk.onUpdate),
      onDelete: actionName(fk.onDelete),
    };
  });
  const checks = config.checks.map((c) => render(c.value));
  return { name: config.name, columns, primaryKey: pk, indexes, foreignKeys, checks };
}

export interface SchemaWarning {
  /** What would be needed: never generated automatically. */
  kind: "drop-table" | "drop-column" | "drop-index" | "change-column" | "unsupported";
  table: string;
  column?: string;
  index?: string;
  message: string;
  /** Suggested SQL to run by hand after reviewing it (destructive or partial). */
  sql?: string;
}

export interface SchemaDiff {
  /** Additive statements (CREATE TABLE / ADD COLUMN / CREATE INDEX), safe to apply in order. */
  statements: string[];
  /** The statements as one migration script (`"…;\n…;"`), or `""` when up to date. */
  sql: string;
  /** Changes that would drop or rewrite data, or that SQLite cannot do with ALTER. Report only. */
  warnings: SchemaWarning[];
}

export interface DiffOptions {
  /** Database tables to leave alone (e.g. ones owned by @miujs/auth or other batteries). */
  ignore?: string[];
}

const CONSTANT_DEFAULT = /^(NULL|TRUE|FALSE|-?\d+(\.\d+)?|'(?:[^']|'')*'|X'[0-9A-F]*')$/i;
const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * Compares `current` (from `introspect`) with the declared `tables` and suggests SQL for added
 * tables, columns and indexes. Drops, type changes and things SQLite's ALTER TABLE cannot do come
 * back as `warnings` with suggested SQL; nothing destructive is ever put in `statements`.
 */
export function diffSchema(current: SchemaDescription, tables: (SQLiteTable | TableDescription)[], opts: DiffOptions = {}): SchemaDiff {
  const statements: string[] = [];
  const warnings: SchemaWarning[] = [];
  const targets = tables.map((t) => (is(t, SQLiteTable) ? describeTable(t) : (t as TableDescription)));
  const live = new Map(current.tables.map((t) => [t.name, t]));
  const ignore = new Set(opts.ignore ?? []);

  for (const target of targets) {
    const existing = live.get(target.name);
    if (!existing) {
      statements.push(...tableSql(target));
      continue;
    }
    const have = new Map(existing.columns.map((c) => [c.name, c]));
    const want = new Set(target.columns.map((c) => c.name));
    const q = quoteIdent(target.name);

    for (const col of target.columns) {
      const now = have.get(col.name);
      if (now) {
        const typeChanged = affinity(now.type) !== affinity(col.type);
        const nullChanged = !col.primaryKey && now.notNull !== col.notNull;
        if (typeChanged || nullChanged) {
          const what = [
            typeChanged ? `type ${now.type || "(none)"} → ${col.type || "(none)"}` : "",
            nullChanged ? (col.notNull ? "NULL → NOT NULL" : "NOT NULL → NULL") : "",
          ]
            .filter(Boolean)
            .join(", ");
          warnings.push({
            kind: "change-column",
            table: target.name,
            column: col.name,
            message: `${target.name}.${col.name} differs (${what}). SQLite cannot alter a column in place; rebuild the table (create new, copy rows, drop old, rename).`,
          });
        }
        continue;
      }
      const unique = target.indexes.some((i) => i.origin === "u" && sameCols(i.columns, [col.name]));
      const problem = col.primaryKey
        ? "a PRIMARY KEY column"
        : unique
          ? "a UNIQUE column (add it without UNIQUE, backfill, then CREATE UNIQUE INDEX)"
          : col.notNull && col.default === null
            ? "NOT NULL without a DEFAULT (give it a default, or add it nullable and backfill)"
            : col.default !== null && !CONSTANT_DEFAULT.test(col.default)
              ? `a non-constant DEFAULT ${col.default} (use a constant default, or backfill with UPDATE)`
              : null;
      if (problem) {
        warnings.push({ kind: "unsupported", table: target.name, column: col.name, message: `Cannot ADD COLUMN ${target.name}.${col.name}: SQLite does not allow ${problem}.` });
        continue;
      }
      // Reuse CREATE TABLE's column rendering, without table-level primary key handling.
      const single = { ...target, primaryKey: [], columns: [col], indexes: [], foreignKeys: [], checks: [] };
      let def = tableSql(single)[0].split("\n")[1].trim();
      const fk = target.foreignKeys.find((f) => sameCols(f.columns, [col.name]));
      if (fk) {
        def += ` REFERENCES ${quoteIdent(fk.table)}`;
        if (fk.references.some(Boolean)) def += ` (${fk.references.map(quoteIdent).join(", ")})`;
        if (fk.onUpdate !== "NO ACTION") def += ` ON UPDATE ${fk.onUpdate}`;
        if (fk.onDelete !== "NO ACTION") def += ` ON DELETE ${fk.onDelete}`;
      }
      statements.push(`ALTER TABLE ${q} ADD COLUMN ${def}`);
    }
    for (const col of existing.columns) {
      if (!want.has(col.name)) {
        warnings.push({
          kind: "drop-column",
          table: target.name,
          column: col.name,
          message: `${target.name}.${col.name} is in the database but not in the schema. Drop it by hand if it is really unused.`,
          sql: `ALTER TABLE ${q} DROP COLUMN ${quoteIdent(col.name)}`,
        });
      }
    }

    const liveIdx = existing.indexes;
    for (const idx of target.indexes) {
      if (idx.columns.some((c) => !want.has(c) || !have.has(c))) continue; // a new column that could not be added
      if (idx.origin === "c") {
        if (!liveIdx.some((i) => i.name === idx.name)) statements.push(createIndexSql(target.name, idx));
      } else if (idx.unique && !liveIdx.some((i) => i.unique && sameCols(i.columns, idx.columns))) {
        statements.push(createIndexSql(target.name, { ...idx, origin: "c" }));
      }
    }
    for (const idx of liveIdx) {
      if (idx.origin !== "c") continue;
      const declared = target.indexes.some((i) => i.name === idx.name || (i.origin === "u" && idx.unique && sameCols(i.columns, idx.columns)));
      if (!declared) {
        warnings.push({
          kind: "drop-index",
          table: target.name,
          index: idx.name,
          message: `Index ${idx.name} on ${target.name} is not in the schema.`,
          sql: `DROP INDEX ${quoteIdent(idx.name)}`,
        });
      }
    }
  }

  const declared = new Set(targets.map((t) => t.name));
  for (const table of current.tables) {
    if (declared.has(table.name) || ignore.has(table.name)) continue;
    warnings.push({
      kind: "drop-table",
      table: table.name,
      message: `Table ${table.name} is in the database but not in the schema. Drop it by hand if it is really unused, or pass it in ignore.`,
      sql: `DROP TABLE ${quoteIdent(table.name)}`,
    });
  }

  return { statements, sql: statements.map((s) => `${s};`).join("\n"), warnings };
}
