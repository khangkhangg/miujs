// @miujs/db/postgres against a real Postgres: PGlite (Postgres 17 compiled to WASM) served over
// TCP by @electric-sql/pglite-socket, reached by the real postgres.js network driver.
//
// Covered with real Postgres semantics: SQL, parameters, types, transactions, constraint errors,
// migrations (incl. $$ bodies and drizzle-kit files), Drizzle's postgres-js adapter.
// NOT covered: a networked Postgres server (TLS, auth, concurrent backends: PGlite has one) and
// Cloudflare Hyperdrive itself. The Hyperdrive path is exercised with a fake env binding
// ({ HYPERDRIVE: { connectionString } }) and runtime "workerd", which is exactly what the plugin
// reads on Workers; the connection behind it is PGlite, not Hyperdrive's pooler.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { miu, route, type Plugin } from "miujs";
import postgres from "postgres";
import { loadMigrations, migrationsFromGlob } from "../src/index.ts";
import { fromPgError, migratePostgres, pg, type PgDriver } from "../src/postgres.ts";
import { quiet, startPostgres, type TestPostgres } from "./pglite.ts";

const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  body: text("body").notNull().unique(),
  votes: integer("votes").notNull().default(0),
});
const schema = { notes };
const NOTES_SQL = "CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL UNIQUE, votes integer NOT NULL DEFAULT 0);";

let server: TestPostgres;
beforeAll(async () => {
  server = await startPostgres();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await server.reset();
});

/** postgres.js, recording each client the plugin creates and whether it was ended. */
function recordingDriver() {
  const clients: { url: string; options: Record<string, unknown>; ended: boolean }[] = [];
  const driver: PgDriver = (url, options) => {
    const client = postgres(url, { ...options, ...quiet });
    const rec = { url, options: options as Record<string, unknown>, ended: false };
    clients.push(rec);
    const end = client.end.bind(client);
    (client as { end: typeof end }).end = (o) => {
      rec.ended = true;
      return end(o);
    };
    return client;
  };
  return { driver, clients };
}

function app(plugin: Plugin, routes: NonNullable<Parameters<typeof miu>[0]>["routes"]) {
  return miu({ plugins: [plugin], routes, logLevel: "silent" });
}

describe("long-lived pool (Bun / Node / Deno)", () => {
  test("ctx.sql and ctx.orm run real queries; one client serves every request", async () => {
    const { driver, clients } = recordingDriver();
    const database = pg({ url: server.url, schema, max: 1, driver, migrations: [{ id: "0001_notes", sql: NOTES_SQL }] });
    const a = app(database, [
      route.post("/notes", {
        handler: async (ctx) => {
          const [row] = await database.orm(ctx).insert(notes).values({ body: "hello" }).returning();
          return row;
        },
      }),
      route.get("/notes", {
        handler: async (ctx) => {
          const raw = await ctx.sql<{ body: string }[]>`SELECT body FROM notes WHERE votes = ${0}`;
          const orm = await database.orm(ctx).select().from(notes).where(eq(notes.body, "hello"));
          const rel = await database.orm(ctx).query.notes.findMany();
          return { raw: raw.map((r) => r.body), orm: orm.map((r) => r.id), rel: rel.length, same: (ctx as any).orm === database.orm(ctx) };
        },
      }),
    ]);
    expect((await a.request("/notes", { method: "POST" })).status).toBe(200);
    expect(await (await a.request("/notes")).json()).toEqual({ raw: ["hello"], orm: [1], rel: 1, same: true });
    expect(clients.length).toBe(1);
    expect(clients[0].url).toBe(server.url);
    expect(clients[0].options.max).toBe(1);
    expect(clients[0].ended).toBe(false);
    await a.close();
    expect(clients[0].ended).toBe(true);
  });

  test("reads DATABASE_URL from env when no url is given", async () => {
    const { driver, clients } = recordingDriver();
    const database = pg({ driver, max: 1 });
    const a = app(database, [route.get("/", { handler: async (ctx) => (await ctx.sql`SELECT 41 + 1 AS n`)[0] })]);
    const res = await a.dispatch(new Request("http://x/"), { DATABASE_URL: server.url }, { runtime: "bun" });
    expect(await res.json()).toEqual({ n: 42 });
    expect(clients[0].url).toBe(server.url);
    await a.close();
  });

  test("no url and no DATABASE_URL explains the fix", async () => {
    const a = app(pg({}), [route.get("/", { handler: () => "x" })]);
    const res = await a.dispatch(new Request("http://x/"), {}, { runtime: "bun" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; fix: string } };
    expect(body.error.code).toBe("MIU_E_DB_POSTGRES_URL_MISSING");
    expect(body.error.fix).toContain("DATABASE_URL");
  });

  test("transactions: sql.begin and orm.transaction commit, and roll back on throw", async () => {
    const database = pg({ url: server.url, schema, max: 1, options: quiet, migrations: [{ id: "0001_notes", sql: NOTES_SQL }] });
    const a = app(database, [
      route.post("/ok", {
        handler: async (ctx) => {
          await ctx.sql.begin(async (tx) => {
            await tx`INSERT INTO notes (body) VALUES ('a')`;
            await tx`INSERT INTO notes (body) VALUES ('b')`;
          });
          await database.orm(ctx).transaction(async (tx) => {
            await tx.insert(notes).values({ body: "c" });
          });
          return { ok: true };
        },
      }),
      route.post("/fail", {
        handler: async (ctx) => {
          await database.orm(ctx).transaction(async (tx) => {
            await tx.insert(notes).values({ body: "d" });
            throw new Error("boom");
          });
        },
      }),
      route.get("/count", { handler: async (ctx) => (await ctx.sql`SELECT count(*)::int AS n FROM notes`)[0] }),
    ]);
    await a.request("/ok", { method: "POST" });
    expect((await a.request("/fail", { method: "POST" })).status).toBe(500);
    expect(await (await a.request("/count")).json()).toEqual({ n: 3 });
    await a.close();
  });

  test("inspect() describes the plugin without the connection string", async () => {
    const database = pg({ url: "postgres://user:secret@db.internal:5432/app", hyperdriveId: "abc" });
    const info = JSON.stringify(database.inspect!());
    expect(info).not.toContain("secret");
    expect(database.inspect!()).toMatchObject({ adapter: "postgres", binding: "HYPERDRIVE" });
  });
});

describe("Hyperdrive (Workers): a client per request", () => {
  test("creates the client from env.HYPERDRIVE.connectionString and ends it via waitUntil", async () => {
    const { driver, clients } = recordingDriver();
    const database = pg({ driver });
    const a = app(database, [route.get("/", { handler: async (ctx) => (await ctx.sql`SELECT 1 + 1 AS n`)[0] })]);
    const env = { HYPERDRIVE: { connectionString: server.url } };
    for (let i = 0; i < 2; i++) {
      const background: Promise<unknown>[] = [];
      const executionContext = { waitUntil: (p: Promise<unknown>) => void background.push(p) };
      const res = await a.dispatch(new Request("http://x/"), env, { runtime: "workerd", executionContext });
      expect(await res.json()).toEqual({ n: 2 });
      expect(background.length).toBe(1);
      await Promise.all(background);
    }
    expect(clients.length).toBe(2);
    expect(clients.every((c) => c.ended && c.url === server.url)).toBe(true);
    // Hyperdrive pools for us: a small per-request client, no type-fetch round trip.
    expect(clients[0].options).toMatchObject({ max: 5, fetch_types: false });
  });

  test("the client is ended after errors too", async () => {
    const { driver, clients } = recordingDriver();
    const a = app(pg({ driver, binding: "PG" }), [
      route.get("/", {
        handler: async (ctx) => {
          await ctx.sql`SELECT * FROM missing_table`;
        },
      }),
    ]);
    const background: Promise<unknown>[] = [];
    const res = await a.dispatch(new Request("http://x/"), { PG: { connectionString: server.url } }, {
      runtime: "workerd",
      executionContext: { waitUntil: (p: Promise<unknown>) => void background.push(p) },
    });
    expect(res.status).toBe(500);
    await Promise.all(background);
    expect(clients.length).toBe(1);
    expect(clients[0].ended).toBe(true);
  });

  test("a Hyperdrive binding in env is used off Workers too (wrangler dev, tests)", async () => {
    const { driver, clients } = recordingDriver();
    const a = app(pg({ driver, url: "postgres://never-used/x" }), [route.get("/", { handler: async (ctx) => (await ctx.sql`SELECT 3 AS n`)[0] })]);
    const pending = new Set<Promise<unknown>>();
    const res = await a.dispatch(new Request("http://x/"), { HYPERDRIVE: { connectionString: server.url } }, { runtime: "bun", pending: pending });
    await Promise.all(pending);
    expect(await res.json()).toEqual({ n: 3 });
    expect(clients[0].url).toBe(server.url);
  });

  test("a missing binding on Workers explains the fix", async () => {
    const a = app(pg({}), [route.get("/", { handler: () => "x" })]);
    const res = await a.dispatch(new Request("http://x/"), {}, { runtime: "workerd" });
    const body = (await res.json()) as { error: { code: string; fix: string } };
    expect(body.error.code).toBe("MIU_E_DB_HYPERDRIVE_MISSING");
    expect(body.error.fix).toContain("[[hyperdrive]]");
  });

  test("cloudflare() declares the Hyperdrive binding for miu deploy cloudflare", () => {
    expect(pg({}).cloudflare!()).toEqual({ hyperdrive: [{ binding: "HYPERDRIVE" }] });
    expect(pg({ binding: "PG", hyperdriveId: "a1b2", localConnectionString: "postgres://localhost:5432/dev" }).cloudflare!()).toEqual({
      hyperdrive: [{ binding: "PG", id: "a1b2", localConnectionString: "postgres://localhost:5432/dev" }],
    });
  });
});

describe("migratePostgres", () => {
  test("applies pending migrations in order, once, and records them", async () => {
    const sql = postgres(server.url, { max: 1, ...quiet });
    const migrations = [
      { id: "0001_notes", sql: NOTES_SQL },
      { id: "0002_votes", sql: "ALTER TABLE notes ADD COLUMN tag text; CREATE INDEX notes_tag ON notes (tag);" },
    ];
    expect(await migratePostgres(sql, migrations)).toEqual(["0001_notes", "0002_votes"]);
    expect(await migratePostgres(sql, migrations)).toEqual([]);
    const rows = await sql`SELECT id FROM _miu_migrations ORDER BY id`;
    expect(rows.map((r) => r.id)).toEqual(["0001_notes", "0002_votes"]);
    await sql.end();
  });

  test("runs whole scripts: $$ function bodies with semicolons, and drizzle-kit breakpoints", async () => {
    const sql = postgres(server.url, { max: 1, ...quiet });
    const drizzleKit = migrationsFromGlob({
      "0000_init.sql": `CREATE TABLE "items" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL);\n--> statement-breakpoint\nCREATE INDEX "items_name" ON "items" ("name");`,
      "0001_fn.sql": `CREATE FUNCTION shout(t text) RETURNS text AS $$ BEGIN RETURN upper(t) || '!'; END; $$ LANGUAGE plpgsql;`,
    });
    await migratePostgres(sql, drizzleKit);
    await sql`INSERT INTO items (name) VALUES ('x')`;
    expect((await sql`SELECT shout(name) AS s FROM items`)[0].s).toBe("X!");
    await sql.end();
  });

  test("a failing migration is rolled back with MIU_E_DB_MIGRATION_FAILED; earlier ones stay", async () => {
    const sql = postgres(server.url, { max: 1, ...quiet });
    const err = await migratePostgres(sql, [
      { id: "0001_ok", sql: "CREATE TABLE a (id int);" },
      { id: "0002_bad", sql: "CREATE TABLE b (id int); INSERT INTO nope VALUES (1);" },
    ]).catch((e) => e);
    expect(err.code).toBe("MIU_E_DB_MIGRATION_FAILED");
    expect(err.message).toContain("0002_bad");
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(["_miu_migrations", "a"]);
    await sql.end();
  });

  test("works with loadMigrations() files", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "miu-pg-mig-"));
    writeFileSync(join(dir, "0001_notes.sql"), NOTES_SQL);
    const sql = postgres(server.url, { max: 1, ...quiet });
    expect(await migratePostgres(sql, await loadMigrations(dir))).toEqual(["0001_notes"]);
    await sql.end();
    rmSync(dir, { recursive: true });
  });

  test("pg({ migrations }) applies them once before the first request", async () => {
    const { driver } = recordingDriver();
    const database = pg({ url: server.url, max: 1, driver, migrations: [{ id: "0001_notes", sql: NOTES_SQL }] });
    const a = app(database, [route.get("/", { handler: async (ctx) => (await ctx.sql`SELECT count(*)::int AS n FROM notes`)[0] })]);
    expect(await (await a.request("/")).json()).toEqual({ n: 0 });
    expect(await (await a.request("/")).json()).toEqual({ n: 0 });
    await a.close();
    // Checked in-process once the socket client is closed: PGlite has a single backend.
    expect((await server.db.query<{ n: number }>("SELECT count(*)::int AS n FROM _miu_migrations")).rows[0].n).toBe(1);
  });
});

describe("fromPgError", () => {
  test("maps real constraint errors to MiuErrors and leaves others alone", async () => {
    const sql = postgres(server.url, { max: 1, ...quiet });
    await sql.unsafe(NOTES_SQL + " CREATE TABLE child (note_id int NOT NULL REFERENCES notes(id));");
    await sql`INSERT INTO notes (body) VALUES ('x')`;
    const unique = await sql`INSERT INTO notes (body) VALUES ('x')`.catch((e) => e);
    const fk = await sql`INSERT INTO child (note_id) VALUES (999)`.catch((e) => e);
    const notNull = await sql`INSERT INTO notes (body) VALUES (${null})`.catch((e) => e);
    const badInput = await sql`SELECT ${"abc"}::int`.catch((e) => e);
    await sql.end();
    expect(fromPgError(unique)).toMatchObject({ code: "MIU_E_CONFLICT", status: 409 });
    expect(fromPgError(fk)).toMatchObject({ code: "MIU_E_CONFLICT", status: 409 });
    expect(fromPgError(notNull)).toMatchObject({ code: "MIU_E_BAD_REQUEST", status: 400 });
    expect(fromPgError(badInput)).toMatchObject({ code: "MIU_E_BAD_REQUEST", status: 400 });
    // The constraint name is reported; the row's values are not echoed back.
    expect(fromPgError(unique)!.message).toContain("notes_body_key");
    expect(fromPgError(new Error("other"))).toBeUndefined();
  });
});

describe("process exit", () => {
  test("an app with a pg() pool exits after listen + stop (the pool is closed)", async () => {
    const { exitCheck } = await import("../../../scripts/lib/leak.ts");
    const r = await exitCheck(`
      import { miu, route } from "miujs";
      import { pg } from "../src/postgres.ts";
      import { quiet, startPostgres } from "../test/pglite.ts";
      const server = await startPostgres();
      const database = pg({ url: server.url, max: 1, options: quiet });
      const app = miu({ logLevel: "silent", plugins: [database],
        routes: [route.get("/", { handler: async ({ sql }) => (await sql\`SELECT 1 AS n\`)[0] })] });
      const s = await app.listen(0, "127.0.0.1");
      if ((await (await fetch(s.url)).json()).n !== 1) throw new Error("bad answer");
      await s.stop();
      await server.stop();
    `, 8000, join(import.meta.dir, ".."));
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 20_000);
});
