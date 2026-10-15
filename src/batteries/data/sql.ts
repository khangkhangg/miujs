import {
  assertField, clampLimit, newId,
  ConflictError, type CreateInput, type Doc, type ListQuery, type ListResult, type Repository,
} from "./types.ts";

/**
 * Portable core of the SQL document repositories (`sqliteRepository` in `miujs/sqlite`, `d1Repository` in
 * `miujs/cloudflare`). Documents are stored as JSON in one table:
 *
 *   id TEXT PRIMARY KEY, data TEXT (JSON, without id/timestamps), created_at TEXT, updated_at TEXT
 *
 * Values are always bound parameters. Field names cannot be bound inside an expression that an index must
 * match, so they are validated with `assertField` (identifier characters only) before being interpolated.
 */
export interface SqlExecutor {
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  first(sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined>;
  run(sql: string, params: unknown[]): Promise<void>;
}

export interface SqlRepositoryOptions<T> {
  /** Table name (identifier characters only). Created on first use. */
  table: string;
  /** Fields searched by `q`. Default: every top-level string value. */
  searchFields?: (keyof T & string)[];
  /** Top-level fields to index with a JSON expression index (speeds up `where` and `sort`). */
  indexes?: (keyof T & string)[];
}

/** Validate a table name; returns it. */
export function assertTable(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid table name: ${name}`);
  return name;
}

/** SQL expression for a document field. */
function col(field: string): string {
  if (field === "id") return "id";
  if (field === "createdAt") return "created_at";
  if (field === "updatedAt") return "updated_at";
  return `json_extract(data, '$.${assertField(field)}')`;
}

/** DDL for the table and its declared indexes. */
export function schemaSql(table: string, indexes: readonly string[] = []): string[] {
  assertTable(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ${table}_created_at ON ${table}(created_at)`,
    ...indexes.map((f) => `CREATE INDEX IF NOT EXISTS ${table}_${assertField(f)} ON ${table}(${col(f)})`),
  ];
}

const bindable = (v: unknown): unknown => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);

function toDoc<T>(row: Record<string, unknown>): T {
  const data = JSON.parse(String(row.data)) as Record<string, unknown>;
  return { ...data, id: String(row.id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } as T;
}

function stripMeta(input: Record<string, unknown>): Record<string, unknown> {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = input;
  return rest;
}

/** Build a Repository over any executor speaking SQLite SQL (bun:sqlite, node:sqlite, D1). */
export function sqlRepository<T extends Doc>(
  exec: SqlExecutor,
  init: () => Promise<void>,
  opts: SqlRepositoryOptions<T>,
): Repository<T> {
  const table = assertTable(opts.table);
  for (const f of opts.searchFields ?? []) assertField(f);
  for (const f of opts.indexes ?? []) assertField(f);
  const COLS = "id, data, created_at, updated_at";

  let ready: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= init().catch((e) => {
      ready = undefined;
      throw e;
    }));

  const whereClause = (query: ListQuery): { sql: string; params: unknown[] } => {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(query.where ?? {})) {
      const e = col(k);
      if (v === null) parts.push(`${e} IS NULL`);
      else {
        parts.push(`${e} = ?`);
        params.push(bindable(v));
      }
    }
    if (query.q) {
      if (opts.searchFields?.length) {
        const ors = opts.searchFields.map((f) => {
          const e = col(f);
          return f === "id" || f === "createdAt" || f === "updatedAt"
            ? `instr(lower(${e}), lower(?)) > 0`
            : `(json_type(data, '$.${f}') = 'text' AND instr(lower(${e}), lower(?)) > 0)`;
        });
        parts.push(`(${ors.join(" OR ")})`);
        for (let i = 0; i < ors.length; i++) params.push(query.q);
      } else {
        parts.push(`EXISTS (SELECT 1 FROM json_each(${table}.data) j WHERE j.type = 'text' AND instr(lower(j.value), lower(?)) > 0)`);
        params.push(query.q);
      }
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
  };

  const getRow = async (id: string) => exec.first(`SELECT ${COLS} FROM ${table} WHERE id = ?`, [id]);
  /** Which `unique` fields collide with another document (for the conflict error after a refused write). */
  const conflicting = async (fields: string[], data: Record<string, unknown>, exceptId = ""): Promise<string[]> => {
    const hits: string[] = [];
    for (const f of fields) {
      if (data[f] === undefined) continue;
      const row = await exec.first(
        `SELECT 1 AS hit FROM ${table} WHERE id <> ? AND json_extract(data, '$.${f}') = json_extract(?, '$') LIMIT 1`,
        [exceptId, JSON.stringify(data[f])],
      );
      if (row) hits.push(f);
    }
    return hits.length ? hits : fields;
  };

  return {
    async list(query: ListQuery = {}): Promise<ListResult<T>> {
      const w = whereClause(query); // validates field names before touching the database
      let order = " ORDER BY rowid";
      if (query.sort) {
        const desc = query.sort.startsWith("-");
        const e = col(desc ? query.sort.slice(1) : query.sort);
        order = ` ORDER BY (${e}) IS NULL, ${e} ${desc ? "DESC" : "ASC"}, rowid`;
      }
      await ensure();
      const limit = clampLimit(query.limit);
      const offset = Math.max(0, Math.floor(query.offset ?? 0)) || 0;
      const [rows, count] = await Promise.all([
        exec.all(`SELECT ${COLS} FROM ${table}${w.sql}${order} LIMIT ? OFFSET ?`, [...w.params, limit, offset]),
        query.count === false ? undefined : exec.first(`SELECT COUNT(*) AS n FROM ${table}${w.sql}`, w.params),
      ]);
      return { items: rows.map((r) => toDoc<T>(r)), total: query.count === false ? -1 : Number(count?.n ?? 0) };
    },

    async get(id) {
      await ensure();
      const row = await getRow(id);
      return row ? toDoc<T>(row) : undefined;
    },

    async create(input: CreateInput<T>, o = {}) {
      await ensure();
      const id = (input as { id?: string }).id ?? newId();
      const now = new Date().toISOString();
      const data = stripMeta(input as Record<string, unknown>);
      const json = JSON.stringify(data);
      try {
        const unique = (o.unique ?? []).filter((f) => data[assertField(f)] !== undefined);
        if (unique.length) {
          // One statement: SQLite/D1 run it atomically, so concurrent writers cannot both pass the check.
          const clash = unique.map((f) => `json_extract(data, '$.${f}') = json_extract(?, '$.${f}')`).join(" OR ");
          const row = await exec.first(
            `INSERT INTO ${table} (id, data, created_at, updated_at) SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${clash}) RETURNING id`,
            [id, json, now, now, ...unique.map(() => json)],
          );
          if (!row) throw new ConflictError(await conflicting(unique, data));
        } else {
          await exec.run(`INSERT INTO ${table} (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`, [id, json, now, now]);
        }
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message))) throw new Error(`Duplicate id: ${id}`, { cause: e });
        throw e;
      }
      return { ...(JSON.parse(JSON.stringify(data)) as object), id, createdAt: now, updatedAt: now } as T;
    },

    async update(id, patch, o = {}) {
      const rest = stripMeta(patch as Record<string, unknown>);
      const removes: string[] = [];
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(rest)) {
        assertField(k);
        if (v === undefined) removes.push(`'$.${k}'`);
        else {
          sets.push(`'$.${k}', json(?)`);
          params.push(JSON.stringify(v));
        }
      }
      const build = (base: string) => {
        let expr = base;
        if (removes.length) expr = `json_remove(${expr}, ${removes.join(", ")})`;
        if (sets.length) expr = `json_set(${expr}, ${sets.join(", ")})`;
        return expr;
      };
      await ensure();
      const unique = (o.unique ?? []).map(assertField);
      if (!unique.length) {
        const row = await exec.first(
          `UPDATE ${table} SET data = ${build("data")}, updated_at = ? WHERE id = ? RETURNING ${COLS}`,
          [...params, new Date().toISOString(), id],
        );
        return row ? toDoc<T>(row) : undefined;
      }
      // Atomic: the row is updated only if no other document holds any unique value of the merged result.
      const next = build(`${table}.data`);
      const clash = unique.map((f) => `json_extract(o.data, '$.${f}') = json_extract(${next}, '$.${f}')`).join(" OR ");
      const row = await exec.first(
        `UPDATE ${table} SET data = ${build("data")}, updated_at = ? WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM ${table} AS o WHERE o.id <> ${table}.id AND (${clash})) RETURNING ${COLS}`,
        [...params, new Date().toISOString(), id, ...unique.flatMap(() => params)],
      );
      if (row) return toDoc<T>(row);
      const current = await getRow(id);
      if (!current) return undefined;
      const merged = { ...(toDoc<T>(current) as Record<string, unknown>), ...rest };
      throw new ConflictError(await conflicting(unique, merged, id));
    },

    async delete(id) {
      await ensure();
      return (await exec.first(`DELETE FROM ${table} WHERE id = ? RETURNING id`, [id])) !== undefined;
    },
  };
}
