// The todo app against a real Postgres (PGlite over TCP, through the real postgres.js driver).
// Tested here: SQL, Drizzle queries, transactions, constraint errors, migrations, and the
// Hyperdrive wiring (a client per request from env.HYPERDRIVE.connectionString, ended after the
// response). Not tested: a networked Postgres server or Cloudflare Hyperdrive itself.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { loadMigrations } from "@miujs/db";
import { migratePostgres } from "@miujs/db/postgres";
import { createApp } from "../app.ts";
import { startPostgres } from "./pglite.ts";

const quiet = { onnotice: () => {} };
let server: Awaited<ReturnType<typeof startPostgres>>;

beforeAll(async () => {
  server = await startPostgres();
  // As in production: migrations run once, out of band (bun migrate.ts), not per request.
  const sql = postgres(server.url, { max: 1, ...quiet });
  expect(await migratePostgres(sql, await loadMigrations(join(import.meta.dir, "..", "migrations")))).toEqual(["0001_todos"]);
  await sql.end();
});
afterAll(async () => {
  await server.stop();
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("todos on Bun (pooled connection)", () => {
  test("create, list, complete, stats, conflict and delete", async () => {
    const app = createApp({ url: server.url, max: 1, options: quiet });
    const a = await app.request("/todos", json({ title: "Buy tea" }));
    expect(a.status).toBe(200);
    const created = (await a.json()) as { id: number; title: string; done: boolean };
    expect(created).toMatchObject({ title: "Buy tea", done: false });

    await app.request("/todos", json({ title: "Write docs" }));
    // Unique title: a 409 from the database constraint, not a 500.
    const dup = await app.request("/todos", json({ title: "Buy tea" }));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("MIU_E_CONFLICT");

    expect((await app.request(`/todos/${created.id}/done`, { method: "POST" })).status).toBe(200);
    const list = (await (await app.request("/todos")).json()) as { todos: { title: string; done: boolean }[] };
    expect(list.todos.map((t) => [t.title, t.done])).toEqual([
      ["Buy tea", true],
      ["Write docs", false],
    ]);
    expect(await (await app.request("/stats")).json()).toEqual({ total: 2, done: 1 });

    // Completing everything runs in one transaction.
    expect(await (await app.request("/todos/complete-all", { method: "POST" })).json()).toEqual({ updated: 1 });
    expect(await (await app.request("/stats")).json()).toEqual({ total: 2, done: 2 });

    expect((await app.request(`/todos/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/todos/${created.id}`, { method: "DELETE" })).status).toBe(404);
    await app.close();
  });
});

describe("todos on Workers (Hyperdrive binding)", () => {
  test("each request gets its own client from env.HYPERDRIVE, closed after the response", async () => {
    const app = createApp({ options: quiet });
    const env = { HYPERDRIVE: { connectionString: server.url } };
    for (const title of ["From a Worker", "Another request"]) {
      const background: Promise<unknown>[] = [];
      const executionContext = { waitUntil: (p: Promise<unknown>) => void background.push(p) };
      const res = await app.dispatch(new Request("http://x/todos", json({ title })), env, { runtime: "workerd", executionContext });
      expect(res.status).toBe(200);
      expect(background.length).toBe(1); // sql.end()
      await Promise.all(background);
    }
    const background: Promise<unknown>[] = [];
    const res = await app.dispatch(new Request("http://x/stats"), env, { runtime: "workerd", executionContext: { waitUntil: (p: Promise<unknown>) => void background.push(p) } });
    expect(((await res.json()) as { total: number }).total).toBeGreaterThanOrEqual(2);
    await Promise.all(background);
  });

  test("wrangler.toml declares the Hyperdrive binding the app uses, with nodejs_compat", () => {
    const toml = readFileSync(join(import.meta.dir, "..", "wrangler.toml"), "utf8");
    const app = createApp({ localConnectionString: "postgres://postgres:postgres@localhost:5432/todos" });
    const hyperdrive = app.plugins.flatMap((p) => p.cloudflare?.().hyperdrive ?? []);
    expect(hyperdrive).toEqual([{ binding: "HYPERDRIVE", localConnectionString: "postgres://postgres:postgres@localhost:5432/todos" }]);
    expect(toml).toContain('[[hyperdrive]]\nbinding = "HYPERDRIVE"');
    expect(toml).toContain("localConnectionString");
    expect(toml).toContain('compatibility_flags = ["nodejs_compat"]');
  });
});
