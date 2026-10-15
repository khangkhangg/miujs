// Memory, exit and speed health of the admin API and UI. Leak checks run thousands of requests
// through app.fetch against in-memory SQLite and fail if live memory keeps growing.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { definePlugin, miu, type AuthUser } from "miujs";
import { db as dbPlugin, sqlite } from "@miujs/db";
import { access, accessStore, defineRoles } from "@miujs/access";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { admin, field, resource } from "../src/index.ts";
import { uiSetup } from "./ui/harness.ts";
import { uiResources } from "./ui/fixtures.ts";
import { systemSetup } from "./system-fixtures.ts";

const PKG = join(import.meta.dir, "..");

const companies = resource("companies", { fields: { name: field.text({ required: true, searchable: true }), domain: field.text() }, tenant: "org", search: true });
const contacts = resource("contacts", {
  fields: {
    name: field.text({ required: true, searchable: true }),
    email: field.email({ unique: true }),
    company: field.relation("companies", { onDelete: "set null" }),
    stage: field.select(["lead", "customer", "lost"], { default: "lead" }),
    value: field.money({ currency: "USD" }),
    tags: field.tags(),
  },
  tenant: "org",
  timestamps: true,
  search: true,
  permissions: "contacts",
});

const ROLES = defineRoles({ owner: ["*"] });

async function apiApp() {
  const database = sqlite();
  const auth = definePlugin({
    name: "test-auth",
    onRequest(ctx) {
      if (ctx.headers.get("x-user") === "ann") ctx.user = { id: "ann", roles: [] } as AuthUser;
    },
  });
  const app = miu({ logLevel: "silent", plugins: [dbPlugin({ database }), auth, access({ roles: ROLES, database, routes: false }), admin({ resources: [companies, contacts], database, autoMigrate: true })] });
  const org = (await accessStore(database).createOrg({ name: "A", ownerId: "ann" })).id;
  await app.ready();
  const headers = { "x-user": "ann", "x-org-id": org, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  // Seed through SQL: 20 companies, `n` contacts spread over them.
  const seed = async (n: number) => {
    const companyIds: string[] = [];
    for (let i = 0; i < 20; i++) companyIds.push((await call("POST", "/api/companies", { name: `Co ${i}`, domain: `co${i}.test` })).id);
    const now = Date.now();
    const stmts = [];
    for (let i = 0; i < n; i++) {
      stmts.push(
        database
          .prepare(`INSERT INTO "contacts" ("id","org_id","name","email","company","stage","value","tags","created_at","updated_at") VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .bind(`c${String(i).padStart(6, "0")}`, org, `Person ${i} Smith`, `p${i}@x.test`, companyIds[i % 20], i % 3 ? "lead" : "customer", i * 100, JSON.stringify(["a", "b"]), now + i, now + i),
      );
      if (stmts.length === 1000) await database.batch(stmts.splice(0));
    }
    if (stmts.length) await database.batch(stmts);
    // Keep the FTS index in step with rows inserted behind the API's back.
    await database.prepare(`INSERT INTO "contacts_fts"("contacts_fts") VALUES ('rebuild')`).run().catch(() => {});
    return companyIds;
  };
  return { app, database, org, headers, call, seed };
}

describe("admin API memory plateaus", async () => {
  const a = await apiApp();
  const companyIds = await a.seed(500);

  const cases: [string, (i: number) => Promise<unknown>][] = [
    ["list 100 with include", () => a.call("GET", "/api/contacts?limit=100&include=company")],
    ["filter + sort", () => a.call("GET", `/api/contacts?limit=50&sort=-value&filter=${encodeURIComponent(JSON.stringify({ value: { gte: 1000 }, stage: "lead" }))}`)],
    ["full-text search", () => a.call("GET", "/api/contacts?q=Person%2012&limit=20")],
    ["schema", () => a.call("GET", "/api/_admin/schema")],
    [
      "create / get / update / delete",
      async (i) => {
        const c = await a.call("POST", "/api/contacts", { name: `New ${i}`, email: `n${i}@y.test`, company: companyIds[i % 20] });
        await a.call("GET", `/api/contacts/${c.id}?include=company`);
        await a.call("PATCH", `/api/contacts/${c.id}`, { stage: "customer" });
        await a.call("DELETE", `/api/contacts/${c.id}`);
      },
    ],
  ];
  for (const [name, fn] of cases) {
    test(name, async () => {
      const r = await leakCheck(name, fn, { warmup: 1000, perRound: 1500, rounds: 5 });
      expect(r.leaking, describeLeak(r)).toBe(false);
    }, 120_000);
  }
});

/** Reads a streamed response chunk by chunk, sampling the live heap; returns bytes and peak growth. */
async function streamPeak(res: Response): Promise<{ bytes: number; lines: number; peak: number }> {
  Bun.gc(true);
  const base = process.memoryUsage().heapUsed;
  let peak = 0;
  let bytes = 0;
  let lines = 0;
  let chunks = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    for (const b of value) if (b === 10) lines++;
    if (++chunks % 10 === 0) {
      Bun.gc(true);
      peak = Math.max(peak, process.memoryUsage().heapUsed - base);
    }
  }
  return { bytes, lines, peak };
}

describe("admin CSV", () => {
  test("export streams with bounded memory (5k vs 50k rows)", async () => {
    const small = await apiApp();
    await small.seed(5_000);
    const big = await apiApp();
    await big.seed(50_000);
    const run = async (x: Awaited<ReturnType<typeof apiApp>>) => {
      const t0 = performance.now();
      const res = await x.app.fetch(new Request("http://localhost/api/contacts/export.csv", { headers: x.headers }));
      expect(res.status).toBe(200);
      const r = await streamPeak(res);
      return { ...r, ms: performance.now() - t0 };
    };
    const s = await run(small);
    const b = await run(big);
    console.log(`export 5k: ${(s.bytes / 1e6).toFixed(1)} MB in ${s.ms.toFixed(0)} ms, peak +${(s.peak / 1e6).toFixed(1)} MB; 50k: ${(b.bytes / 1e6).toFixed(1)} MB in ${b.ms.toFixed(0)} ms, peak +${(b.peak / 1e6).toFixed(1)} MB`);
    expect(s.lines).toBe(5_001);
    expect(b.lines).toBe(50_001);
    // 10x the rows must not need anywhere near 10x the memory.
    expect(b.peak).toBeLessThan(Math.max(s.peak * 3, 8e6));
    // Each page must be an index range read: time per row must not grow with the table (it did:
    // ORDER BY (created_at IS NULL), ... sorted every matching row for every page).
    expect(b.ms / 50_000).toBeLessThan((s.ms / 5_000) * 2.5);
  }, 120_000);

  test("import of a max-size CSV (5000 rows)", async () => {
    const x = await apiApp();
    await x.seed(0);
    const rows = ["name,email,stage,value,company"];
    for (let i = 0; i < 5000; i++) rows.push(`Imported ${i},imp${i}@z.test,customer,${i}.50,Co ${i % 20}`);
    const csv = rows.join("\n");
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const dry = await x.call("POST", "/api/contacts/import", { csv, dryRun: true });
    const dryMs = performance.now() - t0;
    expect(dry.valid).toBe(5000);
    const t1 = performance.now();
    const res = await x.call("POST", "/api/contacts/import", { csv });
    const ms = performance.now() - t1;
    expect(res.imported).toBe(5000);
    Bun.gc(true);
    console.log(`import 5000 rows (${(csv.length / 1e6).toFixed(2)} MB): dry run ${dryMs.toFixed(0)} ms, import ${ms.toFixed(0)} ms, retained +${((process.memoryUsage().heapUsed - before) / 1e6).toFixed(1)} MB`);
    // One row over the limit is refused while parsing.
    const over = rows.concat("Extra,extra@z.test,lead,1,Co 1").join("\n");
    const r = await x.app.fetch(new Request("http://localhost/api/contacts/import", { method: "POST", headers: x.headers, body: JSON.stringify({ csv: over, dryRun: true }) }));
    expect(r.status).toBe(413);
  }, 120_000);
});

describe("admin speed (report)", () => {
  test("list 100 rows with include", async () => {
    const a = await apiApp();
    await a.seed(2_000);
    const n = 300;
    for (let i = 0; i < 50; i++) await a.call("GET", "/api/contacts?limit=100&include=company");
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await a.call("GET", "/api/contacts?limit=100&include=company");
    const ms = (performance.now() - t0) / n;
    const t1 = performance.now();
    for (let i = 0; i < n; i++) await a.call("GET", "/api/_admin/schema");
    const sms = (performance.now() - t1) / n;
    console.log(`admin list 100 + include: ${ms.toFixed(2)} ms/req (${Math.round(1000 / ms)} req/s); schema: ${sms.toFixed(3)} ms/req`);
  }, 120_000);
});

describe("admin UI", () => {
  test("page renders do not leak", async () => {
    const h = await uiSetup(uiResources());
    for (let i = 0; i < 30; i++) await h.req("POST", "/api/contacts", { body: { name: `C${i}`, email: `c${i}@x.test` } });
    const pages = ["/admin", "/admin/r/contacts", "/admin/r/contacts?view=pipeline", "/admin/r/contacts/new"];
    for (const p of pages) expect((await h.req("GET", p)).status).toBe(200);
    const t0 = performance.now();
    const r = await leakCheck("UI pages", async (i) => void (await h.req("GET", pages[i % pages.length])), { warmup: 1000, perRound: 1500, rounds: 5 });
    console.log(`admin UI pages: ${((performance.now() - t0) / 7000).toFixed(2)} ms/page`);
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);
});

describe("System area memory plateaus", async () => {
  // No audit store here: an in-memory audit log grows with every action by design.
  const h = await systemSetup({ audit: false, ui: true });
  const S = "/api/_admin/system";
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await h.req(method, path, { body });
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`);
  };
  const cases: [string, (i: number) => Promise<unknown>][] = [
    ["overview + section + app status", () => Promise.all([ok("GET", S), ok("GET", `${S}/jobs/queue`), ok("GET", `${S}/app/overview`)])],
    ["list page with filters", () => ok("GET", `${S}/jobs/queue/lists/jobs?limit=3&filters=${encodeURIComponent('{"state":"failed"}')}`)],
    ["actions (plain, validated, row)", () => Promise.all([ok("POST", `${S}/jobs/queue/actions/ping`, {}), ok("POST", `${S}/jobs/queue/actions/purge`, { olderThanDays: 2 }), ok("POST", `${S}/jobs/queue/lists/jobs/job1/actions/retry`, {})])],
    ["settings get + put", (i) => Promise.all([ok("GET", `${S}/jobs/queue/settings`), ok("PUT", `${S}/jobs/queue/settings`, { concurrency: (i % 40) + 1, paused: false })])],
    ["UI pages", (i) => ok("GET", i % 2 ? "/admin/system" : "/admin/system/jobs/queue")],
  ];
  for (const [name, fn] of cases) {
    test(name, async () => {
      // The fake plugin records every run/query/set; reset so only the System area is measured.
      const r = await leakCheck(name, async (i) => {
        await fn(i);
        h.jobs.runs.length = 0;
        h.jobs.queries.length = 0;
        h.jobs.sets.length = 0;
      }, { warmup: 500, perRound: 800, rounds: 5 });
      expect(r.leaking, describeLeak(r)).toBe(false);
    }, 120_000);
  }
});

describe("admin apps exit", () => {
  test("with the System area, its settings sync and an MCP action call", async () => {
    const r = await exitCheck(
      `
      import { definePlugin, miu, t } from "miujs";
      import { db as dbPlugin, sqlite } from "@miujs/db";
      import { admin } from "../src/index.ts";
      import { adminUI } from "../src/ui/index.ts";
      const database = sqlite();
      let v = { n: 1 };
      const p = definePlugin({ name: "p", manage: () => [{ id: "s", title: "S", status: () => ({ stats: [{ label: "x", value: 1 }] }), settings: { schema: t.object({ n: t.integer() }), get: () => v, set: (x) => { v = x; } }, actions: [{ name: "go", title: "Go", run: () => "ok" }] }] });
      const auth = definePlugin({ name: "a", onRequest(ctx) { ctx.user = { id: "u", roles: ["admin"] } as any; } });
      const app = miu({ logLevel: "silent", mcp: true, plugins: [dbPlugin({ database }), auth, p, admin({ resources: [], database, autoMigrate: true, systemSettingsTtlMs: 10 }), adminUI({ title: "T", workflows: false })] });
      await app.ready();
      const f = (path, init) => app.fetch(new Request("http://localhost" + path, init)).then((r) => r.text());
      await f("/api/_admin/system/p/s/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 2 }) });
      await f("/admin/system/p/s");
      await f("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system_p_go", arguments: {} } }) });
      await new Promise((r) => setTimeout(r, 30));
      await f("/api/_admin/system");
    `,
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  }, 10_000);

  const src = (tail: string) => `
    import { definePlugin, miu } from "miujs";
    import { db as dbPlugin, sqlite } from "@miujs/db";
    import { workflows, defineWorkflow, on } from "@miujs/workflows";
    import { admin, field, resource } from "../src/index.ts";
    import { adminUI } from "../src/ui/index.ts";
    const database = sqlite();
    const notes = resource("notes", { fields: { title: field.text({ required: true }) } });
    const auth = definePlugin({ name: "a", onRequest(ctx) { ctx.user = { id: "u", roles: ["admin"] } as any; } });
    const wf = workflows({ workflows: [defineWorkflow("w", { trigger: on("notes.created"), run: async ({ step }) => step.run("x", () => 1) })] });
    const app = miu({ logLevel: "silent", plugins: [dbPlugin({ database }), auth, wf, admin({ resources: [notes], database, autoMigrate: true }), adminUI({ title: "T" })] });
    ${tail}
  `;
  test("after ready() and some work", async () => {
    const r = await exitCheck(
      src(`
      await app.ready();
      for (let i = 0; i < 5; i++) await (await app.fetch(new Request("http://localhost/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t" + i }) }))).text();
      await (await app.fetch(new Request("http://localhost/admin/r/notes"))).text();
      await (await app.fetch(new Request("http://localhost/api/notes/export.csv"))).text();
      await new Promise((r) => setTimeout(r, 50));
    `),
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  }, 10_000);

  test("after listen() and stop()", async () => {
    const r = await exitCheck(
      src(`
      const s = await app.listen(0, "127.0.0.1");
      await (await fetch(new URL("/api/notes", s.url), { method: "POST", headers: { "content-type": "application/json", origin: s.url.origin }, body: JSON.stringify({ title: "x" }) })).text();
      await (await fetch(new URL("/admin/r/notes", s.url))).text();
      await s.stop();
    `),
      3000,
      PKG,
    );
    expect(r.exited, r.stderr).toBe(true);
  }, 10_000);
});
