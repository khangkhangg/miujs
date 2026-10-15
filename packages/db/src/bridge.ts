// Schema bridge: one `t.object` feeds the API (validation, OpenAPI, MCP) and the database.
// Part of the `@miujs/db/drizzle` entry (imports drizzle-orm).

import { getTableColumns, sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
  type SQLiteColumn,
  type SQLiteTable,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";
import { errors, t, type Infer, type ObjectSchema, type Schema } from "miujs";
import type { Migration } from "./index.ts";
import { tableSql, type ColumnDescription, type IndexDescription, type TableDescription } from "./introspect.ts";

type Shape = Record<string, Schema<any>>;
type Data<S> = Exclude<Infer<S>, null | undefined>;
type IsNullable<S> = S extends { __default: true }
  ? null extends Infer<S> ? true : false
  : S extends { isOptional: true }
    ? true
    : null extends Infer<S> ? true : false;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type DataTypeOf<D> = [D] extends [string] ? "string" : [D] extends [number] ? "number" : [D] extends [boolean] ? "boolean" : "json";

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

export interface TableFromSchemaOptions<K extends string, PK extends K> {
  /** Primary key column(s). Default: `"id"` when the schema has one, else none (a rowid table). */
  primaryKey?: PK | PK[];
  /** Plain or unique indexes. Default names: `<table>_<cols>_idx` / `<table>_<cols>_unique`. */
  indexes?: IndexSpec<K>[];
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
  mode?: "boolean" | "json";
  enum?: (string | number)[];
  nullable: boolean;
  hasDefault: boolean;
  default?: unknown;
}

function fieldInfo(s: Schema<any>): FieldInfo {
  let json = s.json as Record<string, any>;
  let nullable = false;
  if (Array.isArray(json.anyOf) && json.anyOf.length === 2 && json.anyOf.some((j: any) => j?.type === "null")) {
    nullable = true;
    json = json.anyOf.find((j: any) => j?.type !== "null");
  }
  const hasDefault = "default" in json;
  if (s.isOptional && !hasDefault) nullable = true;
  const info = (f: Pick<FieldInfo, "type" | "mode" | "enum">): FieldInfo => ({
    ...f,
    nullable,
    hasDefault,
    ...(hasDefault ? { default: json.default } : {}),
  });
  const enumOf = (values: unknown[]): FieldInfo => {
    if (values.every((v) => typeof v === "string")) return info({ type: "TEXT", enum: values as string[] });
    if (values.every((v) => typeof v === "boolean")) return info({ type: "INTEGER", mode: "boolean", enum: [...new Set(values.map((v) => (v ? 1 : 0)))] });
    if (values.every((v) => typeof v === "number")) {
      return info({ type: values.every((v) => Number.isInteger(v)) ? "INTEGER" : "REAL", enum: values as number[] });
    }
    return info({ type: "TEXT", mode: "json" });
  };
  switch (s.kind) {
    case "string":
      return info({ type: "TEXT" });
    case "integer":
      return info({ type: "INTEGER" });
    case "number":
      return info({ type: "REAL" });
    case "boolean":
      return info({ type: "INTEGER", mode: "boolean", enum: [0, 1] });
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
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function schemaError(message: string, fix: string): never {
  throw errors.config("MIU_E_DB_SCHEMA", message, fix);
}

/**
 * Builds a Drizzle `sqliteTable` and its `CREATE TABLE` SQL from a MiuJS `t.object`, so one
 * definition validates the API and shapes the table. Mapping: string → TEXT, integer → INTEGER,
 * number → REAL, boolean → INTEGER 0/1, enum/literal → TEXT (or INTEGER) with a CHECK,
 * arrays/objects/any → TEXT holding JSON, `t.optional`/`t.nullable` → nullable, `t.default` →
 * DEFAULT, date/date-time strings → TEXT (ISO 8601). Column names are the object keys.
 */
export function tableFromSchema<
  const TTable extends string,
  P extends Shape,
  const PK extends keyof P & string = Extract<"id", keyof P & string>,
>(name: TTable, schema: ObjectSchema<P>, opts: TableFromSchemaOptions<keyof P & string, PK> = {}): TableFromSchemaResult<BridgeTable<TTable, P, PK>> {
  const shape = schema.shape;
  const keys = Object.keys(shape);
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

  const columns: ColumnDescription[] = keys.map((k) => {
    const f = infos[k];
    const isPk = pk.includes(k);
    const col: ColumnDescription = {
      name: k,
      type: f.type,
      // INTEGER PRIMARY KEY is the rowid and never NULL; other primary keys need NOT NULL in SQLite.
      notNull: isPk ? !(pk.length === 1 && f.type === "INTEGER") : !f.nullable,
      default: sqlDefault(f),
      primaryKey: isPk,
    };
    if (f.enum) col.enum = f.enum;
    return col;
  });

  const indexes: IndexDescription[] = (opts.indexes ?? []).map((spec) => {
    const s: { columns: string[]; unique?: boolean; name?: string; where?: string } =
      typeof spec === "string" ? { columns: [spec] } : Array.isArray(spec) ? { columns: spec } : spec;
    check(s.columns, "index column");
    const idx: IndexDescription = {
      name: s.name || `${name}_${s.columns.join("_")}_${s.unique ? "unique" : "idx"}`,
      columns: s.columns,
      unique: !!s.unique,
      origin: "c",
    };
    if (s.where) idx.where = s.where;
    return idx;
  });

  const description: TableDescription = { name, columns, primaryKey: pk, indexes, foreignKeys: [] };

  const builders: Record<string, any> = {};
  for (const k of keys) {
    const f = infos[k];
    let b: any =
      f.type === "REAL"
        ? real(k)
        : f.type === "INTEGER"
          ? f.mode === "boolean"
            ? integer(k, { mode: "boolean" })
            : integer(k)
          : f.mode === "json"
            ? text(k, { mode: "json" })
            : f.enum
              ? text(k, { enum: f.enum as [string, ...string[]] })
              : text(k);
    if (pk.length === 1 && pk[0] === k) b = b.primaryKey();
    else if (!f.nullable) b = b.notNull();
    if (f.hasDefault) b = b.default(f.default);
    builders[k] = b;
  }
  const table = sqliteTable(name, builders, (cols: any) => [
    ...(pk.length > 1 ? [primaryKey({ columns: pk.map((c) => cols[c]) as [any, ...any[]] })] : []),
    ...indexes.map((i) => {
      const built = (i.unique ? uniqueIndex(i.name) : index(i.name)).on(...(i.columns.map((c) => cols[c]) as [any, ...any[]]));
      return i.where ? built.where(sql.raw(i.where)) : built;
    }),
  ]);
  sources.set(table, shape);
  descriptions.set(table, description);

  const statements = tableSql(description);
  return {
    table: table as unknown as BridgeTable<TTable, P, PK>,
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
      return t.string({ format: "date-time" });
    case "bigint":
      return t.string();
    default: // json, buffer, custom
      return t.any();
  }
}

/**
 * A `t.object` for validating API input (or describing output) from a Drizzle table. Keys are the
 * table's property names. For tables made by `tableFromSchema`, insert mode reuses the original
 * field schemas, so formats, lengths and defaults survive the round trip. Timestamp-mode columns
 * become ISO date-time strings; convert to `Date` before inserting.
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
