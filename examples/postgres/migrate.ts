// Applies migrations/NNNN_*.sql to DATABASE_URL. Run it against the database directly (not through
// Hyperdrive) before deploying: bun migrate.ts
import postgres from "postgres";
import { loadMigrations } from "@miujs/db";
import { migratePostgres } from "@miujs/db/postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL, e.g. DATABASE_URL=postgres://postgres:postgres@localhost:5432/todos bun migrate.ts");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const applied = await migratePostgres(sql, await loadMigrations(new URL("./migrations", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
  console.log(applied.length ? `Applied ${applied.join(", ")}` : "Nothing to apply");
} finally {
  await sql.end();
}
