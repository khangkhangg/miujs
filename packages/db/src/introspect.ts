// Schema descriptions: read a live SQLite/D1 database (`introspect`), render SQL DDL from a
// description, and generate a Drizzle `schema.ts` (`generateDrizzleSchema`). Plain JSON in and out,
// no drizzle-orm import, so it runs anywhere (the CLI's `miu db pull` calls it).

import type { Database } from "./index.ts";

export interface ColumnDescription {
  name: string;
  /** Declared type as written, upper-cased (`"TEXT"`, `"INTEGER"`, `""` when none). */
  type: string;
  notNull: boolean;
  /** Default as a SQL expression (`"0"`, `"'member'"`, `"CURRENT_TIMESTAMP"`), or `null`. */
  default: string | null;
  primaryKey: boolean;
  /** `INTEGER PRIMARY KEY AUTOINCREMENT`. Only present when true. */
  autoIncrement?: boolean;
  /** Allowed values (a `CHECK ("col" IN (...))`). Only set by `tableFromSchema`, not by `introspect`. */
  enum?: (string | number)[];
}

export interface IndexDescription {
  name: string;
  columns: string[];
  unique: boolean;
  /** `"c"` = CREATE INDEX, `"u"` = UNIQUE constraint, `"pk"` = PRIMARY KEY constraint. */
  origin: "c" | "u" | "pk";
  /** Partial index condition. Only present when set. */
  where?: string;
}

export interface ForeignKeyDescription {
  columns: string[];
  table: string;
  references: string[];
  /** SQLite action names: `"NO ACTION"`, `"CASCADE"`, `"SET NULL"`, `"SET DEFAULT"`, `"RESTRICT"`. */
  onUpdate: string;
  onDelete: string;
}

export interface TableDescription {
  name: string;
  columns: ColumnDescription[];
  primaryKey: string[];
  indexes: IndexDescription[];
  foreignKeys: ForeignKeyDescription[];
  /** Extra CHECK expressions (table level). */
  checks?: string[];
  /** The original `CREATE TABLE` statement, from `introspect`. */
  sql?: string;
}

export interface SchemaDescription {
  tables: TableDescription[];
}

const INTERNAL = /^(sqlite_|_cf_)|^(_miu_migrations|d1_migrations)$/i;

/** `"name"`, with embedded quotes doubled. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Reads tables, columns, primary keys, indexes and foreign keys from `sqlite_master` and
 * `PRAGMA table_info / index_list / index_info / foreign_key_list`. Works on D1 and `sqlite()`.
 * Skips internal tables (`sqlite_*`, `_cf_*`, `_miu_migrations`, `d1_migrations`) and views.
 */
export async function introspect(database: Database): Promise<SchemaDescription> {
  const { results: masters } = await database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY rowid")
    .all<{ name: string; sql: string | null }>();
  const { results: indexSqls } = await database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'")
    .all<{ name: string; sql: string | null }>();
  const indexSql = new Map(indexSqls.map((r) => [r.name, r.sql]));
  const tables: TableDescription[] = [];
  for (const { name, sql } of masters) {
    if (INTERNAL.test(name)) continue;
    const q = quoteIdent(name);
    const { results: cols } = await database
      .prepare(`PRAGMA table_info(${q})`)
      .all<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>();
    const autoInc = /\bAUTOINCREMENT\b/i.test(sql ?? "");
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const columns: ColumnDescription[] = cols.map((c) => {
      const col: ColumnDescription = {
        name: c.name,
        type: (c.type ?? "").toUpperCase(),
        notNull: c.notnull === 1,
        default: c.dflt_value,
        primaryKey: c.pk > 0,
      };
      if (autoInc && pkCols.length === 1 && c.pk === 1) col.autoIncrement = true;
      return col;
    });

    const { results: idxList } = await database
      .prepare(`PRAGMA index_list(${q})`)
      .all<{ name: string; unique: number; origin: "c" | "u" | "pk"; partial: number }>();
    const indexes: IndexDescription[] = [];
    for (const idx of idxList) {
      const { results: info } = await database
        .prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`)
        .all<{ seqno: number; name: string | null }>();
      const index: IndexDescription = {
        name: idx.name,
        columns: info.sort((a, b) => a.seqno - b.seqno).map((i) => i.name ?? "<expr>"),
        unique: idx.unique === 1,
        origin: idx.origin,
      };
      if (idx.partial) {
        const m = /\bWHERE\b([\s\S]*)$/i.exec(indexSql.get(idx.name) ?? "");
        if (m) index.where = m[1].trim().replace(/;$/, "").trim();
      }
      indexes.push(index);
    }

    const { results: fkRows } = await database
      .prepare(`PRAGMA foreign_key_list(${q})`)
      .all<{ id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string }>();
    const byId = new Map<number, typeof fkRows>();
    for (const r of fkRows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    const foreignKeys: ForeignKeyDescription[] = [...byId.keys()]
      .sort((a, b) => b - a) // PRAGMA lists the last declared key first
      .map((id) => {
        const rows = byId.get(id)!.sort((a, b) => a.seq - b.seq);
        return {
          columns: rows.map((r) => r.from),
          table: rows[0].table,
          // `REFERENCES t` without columns means t's primary key; leave it to readers to resolve.
          references: rows.map((r) => r.to ?? ""),
          onUpdate: rows[0].on_update,
          onDelete: rows[0].on_delete,
        };
      });

    tables.push({ name, columns, primaryKey: pkCols.map((c) => c.name), indexes, foreignKeys, sql: sql ?? undefined });
  }
  return { tables };
}

// ---------------------------------------------------------------------------------------------
// DDL

function sqlLiteral(v: string | number): string {
  return typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;
}

function columnDdl(table: TableDescription, c: ColumnDescription): string {
  let s = quoteIdent(c.name);
  if (c.type) s += ` ${c.type}`;
  if (table.primaryKey.length === 1 && table.primaryKey[0] === c.name) {
    s += " PRIMARY KEY";
    if (c.autoIncrement) s += " AUTOINCREMENT";
  }
  if (c.notNull) s += " NOT NULL";
  if (c.default !== null) s += ` DEFAULT ${/^[\w.+-]+$|^'.*'$/s.test(c.default) ? c.default : `(${c.default.replace(/^\((.*)\)$/s, "$1")})`}`;
  if (c.enum) s += ` CHECK (${quoteIdent(c.name)} IN (${c.enum.map(sqlLiteral).join(", ")}))`;
  return s;
}

/** `CREATE TABLE` for one table (no indexes). */
export function createTableSql(table: TableDescription, opts: { ifNotExists?: boolean } = {}): string {
  const parts = table.columns.map((c) => columnDdl(table, c));
  if (table.primaryKey.length > 1) parts.push(`PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  for (const idx of table.indexes) if (idx.origin === "u") parts.push(`UNIQUE (${idx.columns.map(quoteIdent).join(", ")})`);
  for (const fk of table.foreignKeys) {
    let s = `FOREIGN KEY (${fk.columns.map(quoteIdent).join(", ")}) REFERENCES ${quoteIdent(fk.table)}`;
    if (fk.references.some(Boolean)) s += ` (${fk.references.map(quoteIdent).join(", ")})`;
    if (fk.onUpdate && fk.onUpdate !== "NO ACTION") s += ` ON UPDATE ${fk.onUpdate}`;
    if (fk.onDelete && fk.onDelete !== "NO ACTION") s += ` ON DELETE ${fk.onDelete}`;
    parts.push(s);
  }
  for (const check of table.checks ?? []) parts.push(`CHECK (${check})`);
  return `CREATE TABLE ${opts.ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdent(table.name)} (\n  ${parts.join(",\n  ")}\n)`;
}

/** `CREATE [UNIQUE] INDEX` for one index created with CREATE INDEX (`origin: "c"`). */
export function createIndexSql(table: string, index: IndexDescription, opts: { ifNotExists?: boolean } = {}): string {
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${opts.ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdent(index.name)} ON ${quoteIdent(table)} (${index.columns.map(quoteIdent).join(", ")})${index.where ? ` WHERE ${index.where}` : ""}`;
}

/** Statements that create a table and its indexes. */
export function tableSql(table: TableDescription, opts: { ifNotExists?: boolean } = {}): string[] {
  return [createTableSql(table, opts), ...table.indexes.filter((i) => i.origin === "c").map((i) => createIndexSql(table.name, i, opts))];
}

// ---------------------------------------------------------------------------------------------
// Drizzle schema generation

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
    "instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface " +
    "package private protected public await arguments eval undefined NaN Infinity " +
    // names the generated module imports
    "sql sqliteTable text integer real blob numeric index uniqueIndex unique primaryKey foreignKey AnySQLiteColumn"
  ).split(" "),
);

function camel(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let out = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join("");
  // An all-caps first word ("ID", "URL") reads better fully lower-cased.
  if (words[0] && words[0] === words[0].toUpperCase()) out = words[0].toLowerCase() + out.slice(words[0].length);
  if (!out) out = "_";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return out;
}

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

type Builder = "integer" | "text" | "real" | "blob" | "numeric";

/** SQLite type affinity rules (https://sqlite.org/datatype3.html#determination_of_column_affinity). */
function builderFor(type: string): { fn: Builder; boolean?: boolean } {
  const t = type.toUpperCase();
  if (t.includes("INT")) return { fn: "integer" };
  if (t.includes("BOOL")) return { fn: "integer", boolean: true };
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return { fn: "text" };
  if (t === "" || t.includes("BLOB")) return { fn: "blob" };
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return { fn: "real" };
  if (t.includes("DATE") || t.includes("TIME")) return { fn: "text" };
  return { fn: "numeric" };
}

/** SQLite column affinity of a declared type: `"VARCHAR(20)"` → `"TEXT"`, `""` → `"BLOB"`. */
export function affinity(type: string): "INTEGER" | "TEXT" | "BLOB" | "REAL" | "NUMERIC" {
  const t = type.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t === "" || t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

const FK_ACTION: Record<string, string> = {
  CASCADE: "cascade",
  RESTRICT: "restrict",
  "SET NULL": "set null",
  "SET DEFAULT": "set default",
};

function tsDefault(expr: string, boolean: boolean, uses: Set<string>): string {
  if (/^-?\d+(\.\d+)?$/.test(expr)) {
    if (boolean && (expr === "0" || expr === "1")) return expr === "1" ? "true" : "false";
    return expr;
  }
  const quoted = /^'(.*)'$/s.exec(expr);
  if (quoted) return JSON.stringify(quoted[1].replace(/''/g, "'"));
  uses.add("sql");
  return `sql\`${expr.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

/**
 * TypeScript source for a Drizzle `schema.ts` describing `desc` (from `introspect`). Exports one
 * `sqliteTable` per table under a camelCase name; column keys are camelCase, SQL names unchanged.
 */
export function generateDrizzleSchema(desc: SchemaDescription): string {
  const uses = new Set<string>(["sqliteTable"]);
  const takenExports = new Set<string>();
  const exportName = new Map<string, string>();
  const columnKeys = new Map<string, Map<string, string>>();
  for (const table of desc.tables) {
    let base = camel(table.name);
    if (RESERVED.has(base)) base = `${base}Table`;
    exportName.set(table.name, unique(base, takenExports));
    const taken = new Set<string>();
    columnKeys.set(table.name, new Map(table.columns.map((c) => [c.name, unique(camel(c.name), taken)])));
  }
  const pkOf = (name: string) => desc.tables.find((t) => t.name === name)?.primaryKey ?? [];
  const ref = (tableName: string, column: string) => `${exportName.get(tableName)}.${columnKeys.get(tableName)!.get(column)}`;
  const known = (tableName: string, cols: string[]) => exportName.has(tableName) && cols.every((c) => columnKeys.get(tableName)!.has(c));

  const blocks: string[] = [];
  for (const table of desc.tables) {
    const keys = columnKeys.get(table.name)!;
    const single = table.primaryKey.length === 1 ? table.primaryKey[0] : null;
    const uniqueCols = new Set(table.indexes.filter((i) => i.origin === "u" && i.columns.length === 1).map((i) => i.columns[0]));
    const singleFks = new Map<string, ForeignKeyDescription>();
    const extra: string[] = [];
    const comments: string[] = [];
    for (const fk of table.foreignKeys) {
      const refs = fk.references.some(Boolean) ? fk.references : pkOf(fk.table);
      if (!known(fk.table, refs) || refs.length !== fk.columns.length) {
        comments.push(`  // TODO: foreign key (${fk.columns.join(", ")}) -> ${fk.table}(${refs.join(", ")}) references a table not in this schema.`);
        continue;
      }
      const resolved = { ...fk, references: refs };
      if (fk.columns.length === 1 && !singleFks.has(fk.columns[0])) singleFks.set(fk.columns[0], resolved);
      else {
        uses.add("foreignKey");
        let s = `foreignKey({ columns: [${fk.columns.map((c) => `t.${keys.get(c)}`).join(", ")}], foreignColumns: [${refs.map((c) => ref(fk.table, c)).join(", ")}] })`;
        if (FK_ACTION[fk.onUpdate]) s += `.onUpdate("${FK_ACTION[fk.onUpdate]}")`;
        if (FK_ACTION[fk.onDelete]) s += `.onDelete("${FK_ACTION[fk.onDelete]}")`;
        extra.push(s);
      }
    }

    const lines = table.columns.map((c) => {
      const { fn, boolean } = builderFor(c.type);
      uses.add(fn);
      let s = `${keys.get(c.name)}: ${fn}(${JSON.stringify(c.name)}${boolean ? ', { mode: "boolean" }' : ""})`;
      if (single === c.name) s += c.autoIncrement ? ".primaryKey({ autoIncrement: true })" : ".primaryKey()";
      else if (c.notNull) s += ".notNull()";
      if (uniqueCols.has(c.name)) s += ".unique()";
      if (c.default !== null) s += `.default(${tsDefault(c.default, !!boolean, uses)})`;
      const fk = singleFks.get(c.name);
      if (fk) {
        uses.add("AnySQLiteColumn");
        const actions: string[] = [];
        if (FK_ACTION[fk.onUpdate]) actions.push(`onUpdate: "${FK_ACTION[fk.onUpdate]}"`);
        if (FK_ACTION[fk.onDelete]) actions.push(`onDelete: "${FK_ACTION[fk.onDelete]}"`);
        s += `.references((): AnySQLiteColumn => ${ref(fk.table, fk.references[0])}${actions.length ? `, { ${actions.join(", ")} }` : ""})`;
      }
      return `  ${s},`;
    });

    if (table.primaryKey.length > 1) {
      uses.add("primaryKey");
      extra.unshift(`primaryKey({ columns: [${table.primaryKey.map((c) => `t.${keys.get(c)}`).join(", ")}] })`);
    }
    for (const idx of table.indexes) {
      if (idx.columns.some((c) => !keys.has(c))) {
        comments.push(`  // TODO: index ${idx.name} uses expressions; recreate it with sql\`\` by hand.`);
        continue;
      }
      const on = idx.columns.map((c) => `t.${keys.get(c)}`).join(", ");
      if (idx.origin === "u" && idx.columns.length > 1) {
        uses.add("unique");
        extra.push(`unique().on(${on})`);
      } else if (idx.origin === "c") {
        const fn = idx.unique ? "uniqueIndex" : "index";
        uses.add(fn);
        let s = `${fn}(${JSON.stringify(idx.name)}).on(${on})`;
        if (idx.where) {
          uses.add("sql");
          s += `.where(sql\`${idx.where.replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`)`;
        }
        extra.push(s);
      }
    }

    const body = [...comments, ...lines].join("\n");
    const tail = extra.length ? `, (t) => [\n  ${extra.join(",\n  ")},\n]` : "";
    blocks.push(`export const ${exportName.get(table.name)} = sqliteTable(${JSON.stringify(table.name)}, {\n${body}\n}${tail});`);
  }

  const core = [...uses].filter((u) => u !== "sql" && u !== "AnySQLiteColumn").sort();
  if (uses.has("AnySQLiteColumn")) core.push("type AnySQLiteColumn");
  const header = [
    "// Generated by `miu db pull` (generateDrizzleSchema from @miujs/db). Edit freely; re-run to refresh.",
    ...(uses.has("sql") ? ['import { sql } from "drizzle-orm";'] : []),
    `import { ${core.join(", ")} } from "drizzle-orm/sqlite-core";`,
  ];
  return `${header.join("\n")}\n${blocks.length ? `\n${blocks.join("\n\n")}\n` : ""}`;
}
