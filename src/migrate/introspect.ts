/**
 * Read an existing database's schema and generate Miu code from it: `t`
 * schemas and a CRUD sub-app per table. Drivers are injected as a `query`
 * function, so this works with any client (bun:sqlite, better-sqlite3, mysql2,
 * pg, postgres.js, D1, …) and needs no dependency.
 */

export type Dialect = "sqlite" | "mysql" | "postgres";
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface Column {
  name: string;
  /** Type as the database reports it, e.g. `VARCHAR(255)`, `bigint unsigned`, `timestamp with time zone`. */
  type: string;
  nullable: boolean;
  /** Default expression as SQL text, or null. */
  default: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  maxLength: number | null;
  /** Allowed values for MySQL `enum(...)` and Postgres enum types. */
  enumValues?: string[];
  /** MongoDB: missing from some sampled documents. */
  optional?: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
}

export interface IntrospectOptions {
  dialect: Dialect;
  query: QueryFn;
  /** Postgres schema, default `public`. MySQL always uses `DATABASE()`. */
  schema?: string;
}

/** List tables (not views) and their columns, sorted by table name. */
export async function introspect(opts: IntrospectOptions): Promise<{ tables: Table[] }> {
  const tables =
    opts.dialect === "sqlite" ? await sqlite(opts.query) : opts.dialect === "mysql" ? await mysql(opts.query) : await postgres(opts.query, opts.schema ?? "public");
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tables };
}

async function sqlite(query: QueryFn): Promise<Table[]> {
  const names = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  const tables: Table[] = [];
  for (const { name } of names) {
    const rows = await query(`PRAGMA table_info("${String(name).replace(/"/g, '""')}")`);
    const pkCount = rows.filter((r) => Number(r.pk) > 0).length;
    tables.push({
      name: String(name),
      columns: rows.map((r) => {
        const type = String(r.type ?? "");
        const pk = Number(r.pk) > 0;
        return {
          name: String(r.name),
          type,
          // A single INTEGER PRIMARY KEY is the rowid: NOT NULL in practice and auto-assigned.
          nullable: !Number(r.notnull) && !pk,
          default: r.dflt_value == null ? null : String(r.dflt_value),
          primaryKey: pk,
          autoIncrement: pk && pkCount === 1 && type.toUpperCase() === "INTEGER",
          maxLength: /char/i.test(type) ? lengthOf(type) : null,
        };
      }),
    });
  }
  return tables;
}

async function mysql(query: QueryFn): Promise<Table[]> {
  const rows = await query(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type, c.DATA_TYPE AS data_type,
       c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.COLUMN_KEY AS column_key, c.EXTRA AS extra,
       c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length
     FROM information_schema.COLUMNS c
     JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
     WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  );
  return group(rows, (r) => {
    const type = String(r.column_type ?? r.data_type);
    const col: Column = {
      name: String(r.column_name),
      type,
      nullable: r.is_nullable === "YES",
      default: r.column_default == null ? null : String(r.column_default),
      primaryKey: r.column_key === "PRI",
      autoIncrement: /auto_increment/i.test(String(r.extra ?? "")),
      maxLength: r.character_maximum_length == null ? null : Number(r.character_maximum_length),
    };
    const values = parseEnum(type);
    if (values) col.enumValues = values;
    return col;
  });
}

async function postgres(query: QueryFn, schema: string): Promise<Table[]> {
  const rows = await query(
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
       c.character_maximum_length, c.is_identity
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  );
  const pks = await query(
    `SELECT kcu.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`,
    [schema],
  );
  const enums = await query(
    `SELECT t.typname AS type_name, e.enumlabel AS label
     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1 ORDER BY t.typname, e.enumsortorder`,
    [schema],
  );
  const pkSet = new Set(pks.map((r) => `${r.table_name}\0${r.column_name}`));
  const enumMap = new Map<string, string[]>();
  for (const e of enums) {
    const k = String(e.type_name);
    if (!enumMap.has(k)) enumMap.set(k, []);
    enumMap.get(k)!.push(String(e.label));
  }
  return group(rows, (r) => {
    const def = r.column_default == null ? null : String(r.column_default);
    const dataType = String(r.data_type);
    const type = dataType === "USER-DEFINED" || dataType === "ARRAY" ? String(r.udt_name) : dataType;
    const col: Column = {
      name: String(r.column_name),
      type,
      nullable: r.is_nullable === "YES",
      default: def,
      primaryKey: pkSet.has(`${r.table_name}\0${r.column_name}`),
      autoIncrement: r.is_identity === "YES" || (def?.startsWith("nextval(") ?? false),
      maxLength: r.character_maximum_length == null ? null : Number(r.character_maximum_length),
    };
    const values = enumMap.get(type);
    if (values) col.enumValues = values;
    return col;
  });
}

function group(rows: Record<string, unknown>[], toColumn: (r: Record<string, unknown>) => Column): Table[] {
  const byName = new Map<string, Table>();
  for (const r of rows) {
    const name = String(r.table_name);
    let t = byName.get(name);
    if (!t) byName.set(name, (t = { name, columns: [] }));
    t.columns.push(toColumn(r));
  }
  return [...byName.values()];
}

function lengthOf(type: string): number | null {
  const m = /\(\s*(\d+)\s*\)/.exec(type);
  return m ? Number(m[1]) : null;
}

/** `enum('a','it''s')` → ["a", "it's"]. */
function parseEnum(type: string): string[] | undefined {
  const m = /^enum\((.*)\)$/i.exec(type.trim());
  if (!m) return undefined;
  return [...m[1]!.matchAll(/'((?:[^'\\]|''|\\.)*)'/g)].map((x) => x[1]!.replace(/''/g, "'").replace(/\\(.)/g, "$1"));
}

// ---------- MongoDB ----------

export interface IntrospectMongoOptions {
  collections: string[];
  /** Return up to `n` documents, e.g. `(c, n) => db.collection(c).aggregate([{ $sample: { size: n } }]).toArray()`. */
  sample: (collection: string, n: number) => Promise<Record<string, unknown>[]>;
  /** Documents sampled per collection. Default 100. */
  sampleSize?: number;
}

/**
 * Infer top-level fields from sampled documents. Fields missing from some
 * documents are `optional`; mixed types become `mixed` (→ `t.any()`).
 */
export async function introspectMongo(opts: IntrospectMongoOptions): Promise<{ tables: Table[] }> {
  const tables: Table[] = [];
  for (const name of opts.collections) {
    const docs = await opts.sample(name, opts.sampleSize ?? 100);
    const seen = new Map<string, { types: Set<string>; count: number; nulls: boolean }>();
    for (const doc of docs) {
      for (const [k, v] of Object.entries(doc)) {
        let f = seen.get(k);
        if (!f) seen.set(k, (f = { types: new Set(), count: 0, nulls: false }));
        f.count++;
        if (v === null || v === undefined) f.nulls = true;
        else f.types.add(bsonType(v));
      }
    }
    const columns: Column[] = [...seen].map(([field, f]) => {
      const types = f.types;
      if (types.has("integer") && types.has("double") && types.size === 2) types.delete("integer");
      return {
        name: field,
        type: types.size === 1 ? [...types][0]! : "mixed",
        nullable: f.nulls,
        default: null,
        primaryKey: field === "_id",
        autoIncrement: field === "_id",
        maxLength: null,
        optional: f.count < docs.length,
      };
    });
    tables.push({ name, columns });
  }
  return { tables };
}

function bsonType(v: unknown): string {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "bigint") return "integer";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "double";
  if (v instanceof Date) return "datetime";
  if (Array.isArray(v)) return "array";
  const bson = (v as { _bsontype?: string })._bsontype;
  if (bson === "ObjectId" || bson === "ObjectID") return "objectid";
  if (bson === "Decimal128" || bson === "Double") return bson === "Double" ? "double" : "decimal";
  if (bson === "Long" || bson === "Int32") return "integer";
  if (bson === "Binary") return "binary";
  return "object";
}

// ---------- code generation ----------

/** The `t.*` expression for a column's type, ignoring nullability. */
export function mapColumnType(col: Column): string {
  const ty = col.type.toLowerCase().trim();
  const values = col.enumValues ?? parseEnum(col.type);
  if (values?.length) return `t.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
  if (/^(bool|boolean)$/.test(ty) || /^tinyint\s*\(\s*1\s*\)/.test(ty) || /^bit(\s*\(\s*1\s*\))?$/.test(ty)) return "t.boolean()";
  if (/timestamp|datetime/.test(ty)) return 't.string({ format: "date-time" })';
  if (ty === "date") return 't.string({ format: "date" })';
  if (/interval/.test(ty)) return "t.string()";
  if (/\b(tiny|small|medium|big)?int(eger|[248])?\b|serial/.test(ty)) return "t.integer()";
  if (/decimal|numeric|float|double|real|money/.test(ty)) return "t.number()";
  if (ty === "uuid") return 't.string({ format: "uuid" })';
  if (/json|^array$|^object$|^mixed$/.test(ty)) return "t.any()";
  if (/char/.test(ty)) {
    const max = col.maxLength ?? lengthOf(col.type);
    return max ? `t.string({ max: ${max} })` : "t.string()";
  }
  if (/text|clob|string|objectid|^time\b|enum|set|inet|cidr|macaddr|xml/.test(ty)) return "t.string()";
  return "t.any()";
}

export interface SchemaSourceOptions {
  /** Module that exports `t` (and `Infer`). Default `miujs`. */
  importFrom?: string;
  /** Emit the import line. Default true. */
  imports?: boolean;
}

/**
 * TypeScript source declaring `<Name>Schema` (a row), `<Name>CreateSchema`
 * (defaulted, nullable and auto-increment columns optional) and, for tables
 * with a single primary key, `<Name>UpdateSchema` (every non-key column optional).
 */
export function toSchemaSource(table: Table, opts: SchemaSourceOptions = {}): string {
  const name = pascal(table.name);
  const field = (c: Column, expr: string) => `  ${propKey(c.name)}: ${expr},`;
  const base = (c: Column) => (c.nullable ? `t.nullable(${mapColumnType(c)})` : mapColumnType(c));
  const row = table.columns.map((c) => field(c, c.optional ? `t.optional(${base(c)})` : base(c)));
  const create = table.columns.map((c) =>
    field(c, c.autoIncrement || c.default !== null || c.nullable || c.optional ? `t.optional(${base(c)})` : base(c)),
  );
  const out: string[] = [];
  if (opts.imports !== false) {
    const from = JSON.stringify(opts.importFrom ?? "miujs");
    out.push(`import { t } from ${from};`, `import type { Infer } from ${from};`, "");
  }
  out.push(`/** Row of ${JSON.stringify(table.name)}. */`, `export const ${name}Schema = t.object({`, ...row, "});", "");
  out.push(`export const ${name}CreateSchema = t.object({`, ...create, "});", "");
  if (singlePk(table)) {
    const update = table.columns.filter((c) => !c.primaryKey).map((c) => field(c, `t.optional(${base(c)})`));
    out.push(`export const ${name}UpdateSchema = t.object({`, ...update, "});", "");
  }
  out.push(`export type ${name} = Infer<typeof ${name}Schema>;`, "");
  return out.join("\n");
}

export interface CrudSourceOptions {
  /** Path of the collection route. Default `/<table-name-slug>`. */
  routePrefix?: string;
  /** SQL flavor for placeholders, quoting and inserts. Default `sqlite`. */
  dialect?: Dialect;
  /** Module that exports `Miu`, `HttpError`, `t` and `Infer`. Default `miujs`. */
  importFrom?: string;
}

/**
 * TypeScript source for a Miu sub-app exposing list/get/create/update/delete
 * for a table, as `create<Name>Routes(db)`. The `db` adapter is any
 * `{ all, get, run }` object (sync or async). Tables without a single-column
 * primary key only get list and create. Review the output before shipping:
 * it has no auth and exposes every column.
 */
export function toCrudSource(table: Table, opts: CrudSourceOptions = {}): string {
  const dialect = opts.dialect ?? "sqlite";
  const name = pascal(table.name);
  const from = JSON.stringify(opts.importFrom ?? "miujs");
  const prefix = opts.routePrefix ?? `/${slug(table.name)}`;
  const qi = (id: string) => (dialect === "mysql" ? "`" + id.replace(/`/g, "``") + "`" : `"${id.replace(/"/g, '""')}"`);
  const ph = (i: number) => (dialect === "postgres" ? `$${i}` : "?");
  const T = qi(table.name);
  const pk = singlePk(table);
  const label = JSON.stringify(table.name).slice(1, -1);

  const L: string[] = [
    `// Generated by miujs migrate from table ${JSON.stringify(table.name)} (${dialect}). Review before use.`,
    `import { HttpError, Miu, t } from ${from};`,
    `import type { Infer } from ${from};`,
    "",
    toSchemaSource(table, { imports: false }),
    "type MaybePromise<T> = T | Promise<T>;",
    "export type Row = Record<string, unknown>;",
    "",
    "/** Adapter over your driver; sync or async. `run` may return `{ lastInsertId }` (needed for MySQL inserts). */",
    "export interface Db {",
    "  all(sql: string, params?: unknown[]): MaybePromise<Row[]>;",
    "  get(sql: string, params?: unknown[]): MaybePromise<Row | null | undefined>;",
    "  run(sql: string, params?: unknown[]): MaybePromise<unknown>;",
    "}",
    "",
    `const q = (id: string) => ${dialect === "mysql" ? "\"`\" + id.replace(/`/g, \"``\") + \"`\"" : "'\"' + id.replace(/\"/g, '\"\"') + '\"'"};`,
    dialect === "postgres" ? 'const ph = (i: number) => "$" + i;' : 'const ph = (_i: number) => "?";',
    "const toDb = (v: unknown) => (v !== null && typeof v === \"object\" ? JSON.stringify(v) : v);",
    "const defined = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);",
    "",
    `export function create${name}Routes(db: Db): Miu {`,
    "  const app = new Miu();",
    "",
    `  app.get(${lit(prefix)}, {`,
    `    summary: ${lit(`List ${label}`)},`,
    "    query: t.object({ limit: t.optional(t.integer({ min: 1, max: 500 })), offset: t.optional(t.integer({ min: 0 })) }),",
    `  }, async (c) => db.all(${lit(`SELECT * FROM ${T} LIMIT ${ph(1)} OFFSET ${ph(2)}`)}, [c.query.limit ?? 50, c.query.offset ?? 0]));`,
    "",
  ];

  const selectOne = pk ? lit(`SELECT * FROM ${T} WHERE ${qi(pk.name)} = ${ph(1)}`) : "";
  const insertHead = lit(`INSERT INTO ${T} (`);
  const returning = dialect === "mysql" ? "" : " RETURNING *";
  const emptyInsert = dialect === "mysql" ? `INSERT INTO ${T} () VALUES ()` : `INSERT INTO ${T} DEFAULT VALUES${returning}`;
  L.push(
    `  app.post(${lit(prefix)}, { summary: ${lit(`Create ${label}`)}, body: ${name}CreateSchema }, async (c) => {`,
    "    const entries = defined(c.body);",
    "    const sql = entries.length",
    `      ? ${insertHead} + entries.map(([k]) => q(k)).join(", ") + ") VALUES (" + entries.map((_, i) => ph(i + 1)).join(", ") + ${lit(")" + returning)}`,
    `      : ${lit(emptyInsert)};`,
    "    const values = entries.map(([, v]) => toDb(v));",
  );
  if (dialect !== "mysql") {
    L.push("    return c.json(await db.get(sql, values), 201);");
  } else if (pk) {
    L.push(
      "    const res = (await db.run(sql, values)) as { lastInsertId?: unknown } | null | undefined;",
      `    const id = (c.body as Row)[${JSON.stringify(pk.name)}] ?? res?.lastInsertId;`,
      `    return c.json((await db.get(${selectOne}, [id])) ?? null, 201);`,
    );
  } else {
    L.push("    await db.run(sql, values);", "    return c.json(c.body, 201);");
  }
  L.push("  });", "");

  if (pk) {
    const item = `${prefix.replace(/\/+$/, "")}/:${pk.name}`;
    const params = `t.object({ ${propKey(pk.name)}: ${mapColumnType(pk)} })`;
    const id = `c.params[${JSON.stringify(pk.name)}]`;
    L.push(
      `  app.get(${lit(item)}, { summary: ${lit(`Get one ${label}`)}, params: ${params} }, async (c) => {`,
      `    const row = await db.get(${selectOne}, [${id}]);`,
      `    if (!row) throw new HttpError(404, ${lit(`${label} not found`)});`,
      "    return row;",
      "  });",
      "",
      `  app.patch(${lit(item)}, { summary: ${lit(`Update ${label}`)}, params: ${params}, body: ${name}UpdateSchema }, async (c) => {`,
      "    const entries = defined(c.body);",
      "    if (entries.length) {",
      `      const sets = entries.map(([k], i) => q(k) + " = " + ph(i + 1)).join(", ");`,
      `      await db.run(${lit(`UPDATE ${T} SET `)} + sets + ${lit(` WHERE ${qi(pk.name)} = `)} + ph(entries.length + 1), [...entries.map(([, v]) => toDb(v)), ${id}]);`,
      "    }",
      `    const row = await db.get(${selectOne}, [${id}]);`,
      `    if (!row) throw new HttpError(404, ${lit(`${label} not found`)});`,
      "    return row;",
      "  });",
      "",
      `  app.delete(${lit(item)}, { summary: ${lit(`Delete ${label}`)}, params: ${params} }, async (c) => {`,
      `    const row = await db.get(${selectOne}, [${id}]);`,
      `    if (!row) throw new HttpError(404, ${lit(`${label} not found`)});`,
      `    await db.run(${lit(`DELETE FROM ${T} WHERE ${qi(pk.name)} = ${ph(1)}`)}, [${id}]);`,
      "    return undefined;",
      "  });",
      "",
    );
  }
  L.push("  return app;", "}", "");
  return L.join("\n");
}

function singlePk(table: Table): Column | undefined {
  const pks = table.columns.filter((c) => c.primaryKey);
  return pks.length === 1 ? pks[0] : undefined;
}

function pascal(s: string): string {
  const out = s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(out) || !out ? `T${out}` : out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "items";
}

function propKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

/** Single-quoted JS string literal (keeps SQL double quotes readable). */
function lit(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}
