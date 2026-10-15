// Types of ctx.orm / ctx.sql for a Postgres app. Registering `orm` in DrizzleRegister is global to a
// TypeScript program, so it is checked in its own program (a temp folder with its own tsconfig),
// not in the repo-wide typecheck where D1 tests register a SQLite schema.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");

test("DrizzleRegister { orm: PgOrm<typeof schema> } types ctx.orm; ctx.sql is postgres.js", async () => {
  const dir = mkdtempSync(join(PKG, ".tmp-types-"));
  try {
    writeFileSync(
      join(dir, "app.ts"),
      `import { route } from "miujs";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { pg, type PgOrm } from "../src/postgres.ts";

const notes = pgTable("notes", { id: serial("id").primaryKey(), body: text("body").notNull() });
const schema = { notes };
declare module "../src/drizzle.ts" {
  interface DrizzleRegister { orm: PgOrm<typeof schema> }
}
export const database = pg({ schema });

export const list = route.get("/notes", {
  handler: async ({ orm, sql }) => {
    const a: { id: number; body: string }[] = await orm.select().from(notes);
    const b = await orm.query.notes.findMany();
    const c = await sql<{ n: number }[]>\`SELECT 1 AS n\`;
    // @ts-expect-error .get() is SQLite/D1-only Drizzle API
    orm.select().from(notes).get();
    return { a, b, n: c[0].n };
  },
});

export const typed = route.get("/typed", {
  handler: async (ctx) => (await database.orm(ctx).select().from(notes)).map((r) => r.body.toUpperCase()),
});
`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "../../../tsconfig.json",
        compilerOptions: { types: ["bun"], typeRoots: [join(ROOT, "node_modules", "@types")] },
        include: ["app.ts"],
      }),
    );
    const proc = Bun.spawn([process.execPath, "x", "tsc", "--noEmit", "-p", join(dir, "tsconfig.json")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    expect(out + err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
