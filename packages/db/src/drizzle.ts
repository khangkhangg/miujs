// @miujs/db/drizzle — Drizzle ORM over the D1-shaped `Database`. One driver everywhere:
// `drizzle-orm/d1` runs on a real D1 binding and on `sqlite()` (which implements the same
// prepare/bind/all/run/raw/batch surface). `drizzle-orm` is an optional peer dependency, so this
// lives in its own entry point and `@miujs/db` itself never imports it.

import { drizzle as drizzleD1, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Logger } from "drizzle-orm";
import { errors, type Context } from "miujs";
import { DRIZZLE_FACTORY, type Database, type DrizzleOptions } from "./index.ts";

export {
  schemaFromTable,
  tableFromSchema,
  type BridgeColumn,
  type BridgeTable,
  type IndexSpec,
  type SchemaFromTableOptions,
  type TableFromSchemaOptions,
  type TableFromSchemaResult,
} from "./bridge.ts";
export { describeTable, diffSchema, type DiffOptions, type SchemaDiff, type SchemaWarning } from "./diff.ts";

/**
 * Register your schema once to type `ctx.orm`:
 *
 * ```ts
 * declare module "@miujs/db/drizzle" { interface DrizzleRegister { schema: typeof schema } }
 * ```
 *
 * With Postgres (`@miujs/db/postgres`), register the whole ORM type instead:
 * `interface DrizzleRegister { orm: PgOrm<typeof schema> }`.
 */
export interface DrizzleRegister {}

export type RegisteredSchema = DrizzleRegister extends { schema: infer S extends Record<string, unknown> } ? S : Record<string, never>;

/** A Drizzle database over a MiuJS `Database`. */
export type Orm<TSchema extends Record<string, unknown> = RegisteredSchema> = DrizzleD1Database<TSchema>;

/** The type of `ctx.orm`: `DrizzleRegister["orm"]` when registered (Postgres), else `Orm`. */
export type ContextOrm = DrizzleRegister extends { orm: infer O } ? O : Orm;

declare module "miujs" {
  interface Context {
    /** Drizzle ORM over `ctx.db`, set by `db({ drizzle: { schema } })`. */
    orm: ContextOrm;
  }
}

export interface DrizzleForOptions<TSchema extends Record<string, unknown>> {
  /** Tables (and relations) for the relational query API, `orm.query.<table>`. */
  schema?: TSchema;
  logger?: boolean | Logger;
  casing?: "snake_case" | "camelCase";
}

const NO_OPTIONS = {};
const cache = new WeakMap<object, WeakMap<object, unknown>>();

/**
 * Drizzle over any `Database` (a D1 binding or `sqlite()`). Instances are cached per
 * (database, options object), so calling this per request is cheap.
 */
export function drizzleFor<TSchema extends Record<string, unknown> = Record<string, never>>(
  database: Database,
  options?: DrizzleForOptions<TSchema>,
): Orm<TSchema> {
  const key = options ?? NO_OPTIONS;
  let byOptions = cache.get(database);
  if (!byOptions) cache.set(database, (byOptions = new WeakMap()));
  let orm = byOptions.get(key) as Orm<TSchema> | undefined;
  if (!orm) {
    orm = drizzleD1(database as any, { schema: options?.schema, logger: options?.logger, casing: options?.casing }) as Orm<TSchema>;
    byOptions.set(key, orm);
  }
  return orm;
}

/** `ctx.orm` when the plugin set it up, otherwise Drizzle over `ctx.db` (no schema). */
export function drizzle(ctx: Pick<Context, "orm" | "db">): Orm {
  if (ctx.orm) return ctx.orm as unknown as Orm;
  if (!ctx.db) {
    throw errors.config(
      "MIU_E_DB_MISSING",
      "drizzle(ctx) needs ctx.db, but no database is set on this request",
      "Add db() from @miujs/db to miu({ plugins }), or call drizzleFor(database) with a database directly.",
    );
  }
  return drizzleFor(ctx.db) as unknown as Orm;
}

// Lets `db({ drizzle })` build `ctx.orm` without `@miujs/db` importing drizzle-orm itself.
(globalThis as Record<symbol, unknown>)[DRIZZLE_FACTORY] = (database: Database, options: DrizzleOptions) => drizzleFor(database, options);
