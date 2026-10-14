import type { Hyperdrive } from "./types.ts";

/**
 * Connection string of a Hyperdrive binding, for any Postgres/MySQL driver.
 * Create the client per request (Hyperdrive pools connections for you):
 *
 * ```ts
 * import postgres from "postgres";
 * app.get("/users", async (c) => {
 *   const sql = postgres(hyperdriveUrl(c.env.HYPERDRIVE), { max: 5, fetch_types: false });
 *   try { return await sql`select id, name from users limit 50`; }
 *   finally { c.executionCtx?.waitUntil(sql.end()); }
 * });
 * ```
 */
export function hyperdriveUrl(binding: Pick<Hyperdrive, "connectionString">): string {
  return binding.connectionString;
}
