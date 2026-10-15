// Schema bridge: one `t.object` feeds the API (validation, OpenAPI, MCP) and the database.
// Part of the `@miujs/db/drizzle` entry (imports drizzle-orm).

import { getTableColumns, is, sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  getTableConfig,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
  type SQLiteColumn,
  SQLiteTable,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";
import { errors, t, type Infer, type ObjectSchema, type Schema } from "miujs";
import type { Migration } from "./index.ts";
import { tableSql, type ColumnDescription, type ForeignKeyDescription, type IndexDescription, type TableDescription } from "./introspect.ts";

type Shape = Record<string, Schema<any>>;
type Data<S> = Exclude<Infer<S>, null | undefined>;
type IsNullable<S> = S extends { __default: true }
  ? null extends Infer<S> ? true : false
  : S extends { isOptional: true }
    ? true
    : null extends Infer<S> ? true : false;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type DataTypeOf<D> = [D] extends [string]
  ? "string"
  : [D] extends [number]
    ? "number"
    : [D] extends [boolean]
      ? "boolean"
      : [D] extends [Date]
        ? "date"
        : "json";

/** The Drizzle column type `tableFromSchema` produces for one `t` field. */
export type BridgeColumn<TTable extends string, K extends string, S, PK extends string> = SQLiteColumn<{
  name: K;
  tableName: TTable;
  dataType: DataTypeOf<Data<S>>;
  columnType: string;
  data: Data<S>;
  driverParam: unknown;
  enumValues: undefined;
  notNull: IsNullable<S> extends true ? false : true;
  hasDefault: S extends { __default: true }
    ? true
    : K extends PK
      ? true extends IsUnion<PK> ? false : [Data<S>] extends [number] ? true : false
      : false;
  isPrimaryKey: K extends PK ? true : false;
  isAutoincrement: false;
  hasRuntimeDefault: false;
  // Drizzle only treats a column as insertable-optional when these are exactly undefined.
  generated: undefined;
  identity: undefined;
}>;

/** The Drizzle table type `tableFromSchema` produces. */
export type BridgeTable<TTable extends string, P extends Shape, PK extends string> = SQLiteTableWithColumns<{
  name: TTable;
  schema: undefined;
  dialect: "sqlite";
  columns: { [K in keyof P & string]: BridgeColumn<TTable, K, P[K], PK> };
}>;

export type IndexSpec<K extends string> = K | K[] | { columns: K[]; unique?: boolean; name?: string; where?: string };

export type ReferenceAction = "cascade" | "set null" | "restrict" | "no action" | "set default";

export interface ReferenceSpec {
  /**
   * The referenced table: a Drizzle table, a `tableFromSchema` result, or this table's own name
   * (self reference). Other tables must be passed as objects so Drizzle can link the columns.
   */
  table: SQLiteTable | { table: SQLiteTable } | string;
  /** Referenced field (property key or SQL name). Default `"id"`. */
  column?: string;
  onDelete?: ReferenceAction;
}

export interface TableFromSchemaOptions<K extends string, PK extends K> {
  /** Primary key field(s). Default: `"id"` when the schema has one, else none (a rowid table). */
  primaryKey?: PK | PK[];
  /** Plain or unique indexes over fields. Default names: `<table>_<cols>_idx` / `<table>_<cols>_unique`. */
  indexes?: IndexSpec<K>[];
  /** Foreign keys: `{ companyId: { table: companies.table, onDelete: "set null" } }`. */
  references?: { [F in K]?: ReferenceSpec };
  /** `"snake_case"`: SQL column names become snake_case (`createdAt` → `created_at`); keys stay as written. */
  casing?: "snake_case";
}

export interface TableFromSchemaResult<T> {
  /** A Drizzle `sqliteTable`, typed from the schema. */
  table: T;
  /** Plain description (same shape as `introspect()` output). */
  description: TableDescription;
  /** `CREATE TABLE` followed by its `CREATE INDEX` statements. */
  sql: string[];
  /** The statements as a migration for `migrate()` / `db({ migrations })`. */
  migration(id: string): Migration;
}

const sources = new WeakMap<object, Shape>();
const descriptions = new WeakMap<object, TableDescription>();

/** @internal The description `tableFromSchema` made for this table, if it made it. */
export function bridgeDescription(table: object): TableDescription | undefined {
  return descriptions.get(table);
}

interface FieldInfo {
  type: "TEXT" | "INTEGER" | "REAL";
  mode?: "boolean" | "json" | "timestamp";
  enum?: (string | number)[];
  nullable: boolean;
  hasDefault: boolean;
  default?: unknown;
}

/** Peels `t.optional` / `t.nullable` / `t.default` wrappers via `.inner`. */
function unwrap(s: Schema<any>): { base: Schema<any>; optional: boolean; nullable: boolean; hasDefault: boolean; default?: unknown } {
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let dflt: unknown;
  let cur = s;
  while (cur.inner) {
    const inner = cur.inner;
    const json = cur.json as Record<string, unknown>;
    if (Array.isArray(json.anyOf) && json.anyOf[0] === inner.json) nullable = true;
    else if ("default" in json && !("default" in (inner.json as object))) {
      if (!hasDefault) dflt = json.default;
      hasDefault = true;
    } else optional = true;
    cur = inner;
  }
  return { base: cur, optional, nullable, hasDefault, ...(hasDefault ? { default: dflt } : {}) };
}

function fieldInfo(s: Schema<any>): FieldInfo {
  const u = unwrap(s);
  const json = u.base.json as Record<string, any>;
  let nullable = u.nullable || (u.optional && !u.hasDefault);
  const info = (f: Pick<FieldInfo, "type" | "mode" | "enum">): FieldInfo => ({
    ...f,
    nullable,
    hasDefault: u.hasDefault,
    ...(u.hasDefault ? { default: u.default } : {}),
  });
  const enumOf = (values: unknown[]): FieldInfo => {
    if (values.every((v) => typeof v === "string")) return info({ type: "TEXT", enum: values as string[] });
    if (values.every((v) => typeof v === "boolean")) return info({ type: "INTEGER", mode: "boolean", enum: [...new Set(values.map((v) => (v ? 1 : 0)))] });
    if (values.every((v) => typeof v === "number")) {
      return info({ type: values.every((v) => Number.isInteger(v)) ? "INTEGER" : "REAL", enum: values as number[] });
    }
    return info({ type: "TEXT", mode: "json" });
  };
  switch (u.base.kind) {
    case "string":
      return info({ type: "TEXT" });
    case "integer":
      return info({ type: "INTEGER" });
    case "number":
      return info({ type: "REAL" });
    case "boolean":
      return info({ type: "INTEGER", mode: "boolean", enum: [0, 1] });
    case "date":
      return info({ type: "INTEGER", mode: "timestamp" });
    case "enum":
      return enumOf(json.enum);
    case "literal":
      return enumOf([json.const]);
    case "any":
    case "unknown":
      nullable = true;
      return info({ type: "TEXT", mode: "json" });
    default: // array, object, record, union
      return info({ type: "TEXT", mode: "json" });
  }
}

function sqlDefault(f: FieldInfo): string | null {
  if (!f.hasDefault) return null;
  const v = f.default;
  if (v === null) return "NULL";
  if (f.mode === "json") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  if (f.mode === "timestamp") return String(v instanceof Date ? v.getTime() : new Date(v as string).getTime());
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function schemaError(message: string, fix: string): never {
  throw errors.config("MIU_E_DB_SCHEMA", message, fix);
}

/** `createdAt` → `created_at`, `personID` → `person_id`, `URLPath` → `url_path`. */
function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Builds a Drizzle `sqliteTable` and its `CREATE TABLE` SQL from a MiuJS `t.object`, so one
 * definition validates the API and shapes the table. Mapping: string → TEXT, integer → INTEGER,
 * number → REAL, boolean → INTEGER 0/1, `t.date()` → INTEGER milliseconds (Drizzle
 * `timestamp_ms`, so rows hold `Date`s), enum/literal → TEXT (or INTEGER) with a CHECK,
 * arrays/objects/any → TEXT holding JSON, `t.optional`/`t.nullable` → nullable, `t.default` →
 * DEFAULT, date-time *strings* → TEXT (ISO 8601). Column names are the object keys, or their
 * snake_case form with `casing: "snake_case"`.
 */
export function tableFromSchema<
  const TTable extends string,
  P extends Shape,
  const PK extends keyof P & string = Extract<"id", keyof P & string>,
>(name: TTable, schema: ObjectSchema<P>, opts: TableFromSchemaOptions<keyof P & string, PK> = {}): TableFromSchemaResult<BridgeTable<TTable, P, PK>> {
  const shape = schema.shape;
  const keys = Object.keys(shape);
  const col = (k: string) => (opts.casing === "snake_case" ? snakeCase(k) : k);
  const check = (cols: string[], what: string) => {
    for (const c of cols) {
      if (!keys.includes(c)) schemaError(`tableFromSchema("${name}"): ${what} "${c}" is not a field of the schema`, `Use one of: ${keys.join(", ")}.`);
    }
  };
  const pk: string[] =
    opts.primaryKey === undefined ? (keys.includes("id") ? ["id"] : []) : Array.isArray(opts.primaryKey) ? opts.primaryKey : [opts.primaryKey];
  check(pk, "primary key");
  const infos: Record<string, FieldInfo> = {};
  for (const k of keys) infos[k] = fieldInfo(shape[k]);

  // Foreign keys: resolve each target to a SQL table/column now, and to a Drizzle column lazily.
  let table: any;
  const refs: { field: string; table: string; column: string; onDelete?: ReferenceAction; drizzle: () => AnySQLiteColumn }[] = [];
  for (const [field, spec] of Object.entries((opts.references ?? {}) as Record<string, ReferenceSpec | undefined>)) {
    if (!spec) continue;
    check([field], "reference");
    const column = spec.column ?? "id";
    if (typeof spec.table === "string") {
      if (spec.table !== name) {
        schemaError(
          `tableFromSchema("${name}"): reference ${field} → "${spec.table}" names another table by string`,
          `Pass the table object instead, e.g. references: { ${field}: { table: ${spec.table}.table } }; only this table's own name ("${name}") works as a string (self reference).`,
        );
      }
      check([column], "referenced field");
      refs.push({ field, table: name, column: col(column), onDelete: spec.onDelete, drizzle: () => table[column] });
      continue;
    }
    const target = is(spec.table, SQLiteTable) ? spec.table : (spec.table as { table?: unknown })?.table;
    if (!is(target, SQLiteTable)) {
      schemaError(`tableFromSchema("${name}"): reference ${field} has no table`, "Pass a Drizzle table or a tableFromSchema() result as table.");
    }
    const columns = getTableColumns(target) as Record<string, AnySQLiteColumn>;
    const refCol = columns[column] ?? Object.values(columns).find((c) => c.name === column);
    if (!refCol) {
      schemaError(
        `tableFromSchema("${name}"): reference ${field} → ${getTableConfig(target).name}.${column} does not exist`,
        `Use one of: ${Object.keys(columns).join(", ")}.`,
      );
    }
    refs.push({ field, table: getTableConfig(target).name, column: refCol.name, onDelete: spec.onDelete, drizzle: () => refCol });
  }

  const columns: ColumnDescription[] = keys.map((k) => {
    const f = infos[k];
    const isPk = pk.includes(k);
    const c: ColumnDescription = {
      name: col(k),
      type: f.type,
      // INTEGER PRIMARY KEY is the rowid and never NULL; other primary keys need NOT NULL in SQLite.
      notNull: isPk ? !(pk.length === 1 && f.type === "INTEGER" && !f.mode) : !f.nullable,
      default: sqlDefault(f),
      primaryKey: isPk,
    };
    if (f.enum) c.enum = f.enum;
    return c;
  });

  const indexes: IndexDescription[] = (opts.indexes ?? []).map((spec) => {
    const s: { columns: string[]; unique?: boolean; name?: string; where?: string } =
      typeof spec === "string" ? { columns: [spec] } : Array.isArray(spec) ? { columns: spec } : spec;
    check(s.columns, "index column");
    const sqlCols = s.columns.map(col);
    const idx: IndexDescription = {
      name: s.name || `${name}_${sqlCols.join("_")}_${s.unique ? "unique" : "idx"}`,
      columns: sqlCols,
      unique: !!s.unique,
      origin: "c",
    };
    if (s.where) idx.where = s.where;
    return idx;
  });

  const foreignKeys: ForeignKeyDescription[] = refs.map((r) => ({
    columns: [col(r.field)],
    table: r.table,
    references: [r.column],
    onUpdate: "NO ACTION",
    onDelete: r.onDelete ? r.onDelete.toUpperCase() : "NO ACTION",
  }));

  const description: TableDescription = { name, columns, primaryKey: pk.map(col), indexes, foreignKeys };

  const builders: Record<string, any> = {};
  for (const k of keys) {
    const f = infos[k];
    const n = col(k);
    let b: any =
      f.type === "REAL"
        ? real(n)
        : f.type === "INTEGER"
          ? f.mode === "boolean"
            ? integer(n, { mode: "boolean" })
            : f.mode === "timestamp"
              ? integer(n, { mode: "timestamp_ms" })
              : integer(n)
          : f.mode === "json"
            ? text(n, { mode: "json" })
            : f.enum
              ? text(n, { enum: f.enum as [string, ...string[]] })
              : text(n);
    if (pk.length === 1 && pk[0] === k) b = b.primaryKey();
    else if (!f.nullable) b = b.notNull();
    if (f.hasDefault) b = b.default(f.mode === "timestamp" && f.default !== null ? new Date(f.default as string | number | Date) : f.default);
    const ref = refs.find((r) => r.field === k);
    if (ref) b = b.references(ref.drizzle, ref.onDelete ? { onDelete: ref.onDelete } : undefined);
    builders[k] = b;
  }
  table = sqliteTable(name, builders, (cols: any) => [
    ...(pk.length > 1 ? [primaryKey({ columns: pk.map((c) => cols[c]) as [any, ...any[]] })] : []),
    ...indexes.map((i, n) => {
      const fields = (opts.indexes![n] as IndexSpec<string>);
      const keysOf = typeof fields === "string" ? [fields] : Array.isArray(fields) ? fields : fields.columns;
      const built = (i.unique ? uniqueIndex(i.name) : index(i.name)).on(...(keysOf.map((c) => cols[c]) as [any, ...any[]]));
      return i.where ? built.where(sql.raw(i.where)) : built;
    }),
  ]);
  sources.set(table, shape);
  descriptions.set(table, description);

  const statements = tableSql(description);
  return {
    table: table as BridgeTable<TTable, P, PK>,
    description,
    sql: statements,
    migration: (id) => ({ id, sql: statements.map((s) => `${s};`).join("\n") }),
  };
}

export interface SchemaFromTableOptions<M extends "insert" | "select"> {
  /**
   * `"insert"` (default): columns with a default, nullable columns and an INTEGER primary key are
   * optional. `"select"`: every column is required; nullable ones accept `null`.
   */
  mode?: M;
}

function columnSchema(col: AnySQLiteColumn): Schema<any> {
  const enumValues = col.enumValues as string[] | undefined;
  switch (col.dataType) {
    case "string": {
      if (enumValues?.length) return t.enum(enumValues);
      const length = (col as { length?: number }).length;
      return t.string(length ? { maxLength: length } : {});
    }
    case "number":
      return col.getSQLType() === "integer" ? t.integer() : t.number();
    case "boolean":
      return t.boolean();
    case "date":
      return t.date();
    case "bigint":
      return t.string();
    default: // json, buffer, custom
      return t.any();
  }
}

/**
 * A `t.object` for validating API input (or describing output) from a Drizzle table. Keys are the
 * table's property names. For tables made by `tableFromSchema`, insert mode reuses the original
 * field schemas, so formats, lengths and defaults survive the round trip. Timestamp columns map
 * to `t.date()` (ISO string or Date in, Date out), which is what Drizzle expects to insert.
 */
export function schemaFromTable<T extends SQLiteTable, M extends "insert" | "select" = "insert">(
  table: T,
  opts: SchemaFromTableOptions<M> = {},
): ObjectSchema<Record<string, Schema<any>>> & Schema<M extends "select" ? InferSelectModel<T> : InferInsertModel<T>> {
  const mode = opts.mode ?? "insert";
  const source = mode === "insert" ? sources.get(table) : undefined;
  const shape: Record<string, Schema<any>> = {};
  for (const [key, col] of Object.entries(getTableColumns(table)) as [string, AnySQLiteColumn][]) {
    const autoKey = col.primary && col.getSQLType() === "integer";
    const own = source?.[key];
    if (own) {
      shape[key] = autoKey && !own.isOptional ? t.optional(own) : own;
      continue;
    }
    const base = columnSchema(col);
    if (mode === "select") shape[key] = col.notNull ? base : t.nullable(base);
    else if (!col.notNull) shape[key] = t.optional(t.nullable(base));
    else if (col.hasDefault || autoKey) shape[key] = t.optional(base);
    else shape[key] = base;
  }
  return t.object(shape) as any;
}
