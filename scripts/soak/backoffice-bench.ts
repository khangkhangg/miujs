// Back-office load benchmark on the CRM example (Bun + SQLite, in process through app.fetch):
// seeds 100k+ records, then measures list / filter / sort / search / pagination latency, SQL
// statements per request, query plans, CSV export of 100k rows (peak heap), CSV import of 5k rows,
// bulk updates, and 50–200 concurrent users doing mixed CRUD.
//
//   bun scripts/soak/backoffice-bench.ts                    # 100k contacts, :memory:
//   bun scripts/soak/backoffice-bench.ts --contacts=200000 --db=file --suffix=after
//
// Results: scripts/soak/results/backoffice-bench[-suffix].json and a table on stdout.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../examples/crm/app.ts";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
const N_CONTACTS = Number(argv.contacts ?? 100_000);
const N_COMPANIES = Math.max(100, Math.round(N_CONTACTS / 10));
const N_DEALS = Math.round(N_CONTACTS / 2);
const N_ACTIVITIES = Math.round(N_CONTACTS / 2);
const REPS = Number(argv.reps ?? 100);
const suffix = argv.suffix ? `-${argv.suffix}` : "";
const dbFile = argv.db === "file" ? join(tmpdir(), `miu-backoffice-${process.pid}.db`) : ":memory:";

const BASE = "http://localhost";
const { app, database } = createApp({ dbPath: dbFile, dev: true, passwordIterations: 1000, sessionSecret: "backoffice-bench-session-secret-0123456789abcdef" });
const db = database!;

// ---- statement capture -------------------------------------------------------------------
let counting = false;
/** SQL → [calls, total ms], collected while timing is on (the concurrent phase). */
let timing: Map<string, [number, number]> | null = null;
let captured: { sql: string; values: unknown[] }[] = [];
const origPrepare = db.prepare.bind(db);
(db as { prepare: typeof db.prepare }).prepare = (sql: string) => {
  const wrap = (st: ReturnType<typeof origPrepare>): ReturnType<typeof origPrepare> =>
    new Proxy(st, {
      get(target, prop, recv) {
        if (prop === "bind") return (...v: unknown[]) => wrap(target.bind(...v));
        if (counting && (prop === "all" || prop === "first" || prop === "run" || prop === "raw")) captured.push({ sql, values: (target as unknown as { values?: unknown[] }).values ?? [] });
        const val = Reflect.get(target, prop, recv);
        if (timing && typeof val === "function" && (prop === "all" || prop === "first" || prop === "run")) {
          return async (...a: unknown[]) => {
            const t = performance.now();
            try { return await val.apply(target, a); } finally { const e = timing?.get(sql) ?? [0, 0]; e[0]++; e[1] += performance.now() - t; timing?.set(sql, e); }
          };
        }
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
  return wrap(origPrepare(sql));
};
const origBatch = db.batch.bind(db);
(db as { batch: typeof db.batch }).batch = (stmts) => {
  if (counting) for (const s of stmts) captured.push({ sql: (s as unknown as { sql: string }).sql, values: (s as unknown as { values: unknown[] }).values ?? [] });
  return origBatch(stmts as never);
};

// ---- client ------------------------------------------------------------------------------
let cookie = "";
let orgId = "";
async function call(method: string, path: string, body?: unknown, raw = false): Promise<{ status: number; json: any; text: string; res: Response }> {
  const headers = new Headers({ origin: BASE, cookie });
  if (orgId) headers.set("x-org-id", orgId);
  let b: string | undefined;
  if (body !== undefined) { b = JSON.stringify(body); headers.set("content-type", "application/json"); }
  const res = await app.fetch(new Request(BASE + path, { method, headers, body: b }));
  if (raw) return { status: res.status, json: null, text: "", res };
  const text = await res.text();
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); if (pair.startsWith("miu")) cookie = pair; }
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, res };
}

/** Statements grouped by their first words, most frequent first. */
const breakdown = (list: { sql: string }[]) => {
  const m = new Map<string, number>();
  for (const c of list) { const k = c.sql.replace(/\s+/g, " ").slice(0, 70); m.set(k, (m.get(k) ?? 0) + 1); }
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 12));
};
const q = (p: number[], f: number) => { const s = [...p].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

// ---- seed --------------------------------------------------------------------------------
const words = ["acme", "globex", "initech", "umbrella", "stark", "wayne", "wonka", "hooli", "vandelay", "soylent", "tyrell", "cyberdyne", "aperture", "massive", "dynamic", "pied", "piper", "oscorp", "gringotts", "duff"];
const first = ["ada", "grace", "alan", "linus", "ken", "barbara", "edsger", "donald", "margaret", "john", "radia", "tim", "vint", "frances", "dennis", "bjarne"];
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: readonly T[]) => a[rnd(a.length)];

async function insertMany(table: string, cols: string[], rows: unknown[][]) {
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += 2000) await db.batch(rows.slice(i, i + 2000).map((r) => db.prepare(sql).bind(...r)));
}

async function seed(org: string, owner: string, scale: number) {
  const now = Date.now();
  const companies: string[] = [];
  const cRows: unknown[][] = [];
  for (let i = 0; i < Math.round(N_COMPANIES * scale); i++) {
    const id = crypto.randomUUID();
    companies.push(id);
    cRows.push([id, org, `${pick(words)} ${pick(words)} ${i}`, `c${i}.example`, pick(["software", "finance", "retail", "other"]), JSON.stringify([]), owner, now - i * 1000, now - i * 1000, owner, owner]);
  }
  await insertMany("companies", ["id", "org_id", "name", "domain", "industry", "tags", "owner", "created_at", "updated_at", "created_by", "updated_by"], cRows);
  const contacts: string[] = [];
  const pRows: unknown[][] = [];
  for (let i = 0; i < Math.round(N_CONTACTS * scale); i++) {
    const id = crypto.randomUUID();
    contacts.push(id);
    const d = new Date(now + (rnd(120) - 60) * 86_400_000).toISOString().slice(0, 10);
    pRows.push([id, org, `${pick(first)} ${pick(words)} ${i}`, `p${i}-${org.slice(0, 6)}@x.example`, pick(companies), pick(["lead", "qualified", "customer", "lost"]), rnd(1_000_000), JSON.stringify(rnd(5) === 0 ? ["vip"] : []), d, rnd(3) ? owner : "someone-else", now - i * 1000, now - i * 1000, owner, owner]);
  }
  await insertMany("contacts", ["id", "org_id", "name", "email", "company", "stage", "value", "tags", "next_follow_up", "owner", "created_at", "updated_at", "created_by", "updated_by"], pRows);
  const dRows: unknown[][] = [];
  for (let i = 0; i < Math.round(N_DEALS * scale); i++) {
    const d = new Date(now + (rnd(120) - 30) * 86_400_000).toISOString().slice(0, 10);
    dRows.push([crypto.randomUUID(), org, `deal ${pick(words)} ${i}`, pick(companies), pick(contacts), pick(["lead", "qualified", "proposal", "negotiation", "won", "lost"]), rnd(10_000_000), 50, d, owner, now - i * 1000, now - i * 1000, owner, owner]);
  }
  await insertMany("deals", ["id", "org_id", "title", "company", "contact", "stage", "amount", "probability", "expected_close", "owner", "created_at", "updated_at", "created_by", "updated_by"], dRows);
  const aRows: unknown[][] = [];
  for (let i = 0; i < Math.round(N_ACTIVITIES * scale); i++) {
    aRows.push([crypto.randomUUID(), org, pick(["call", "email", "meeting", "note"]), `talk ${pick(words)} ${i}`, "contacts", pick(contacts), now - i * 60_000, owner, now - i * 1000, now - i * 1000, owner, owner]);
  }
  await insertMany("activities", ["id", "org_id", "type", "subject", "subject_type", "subject_id", "occurred_at", "owner", "created_at", "updated_at", "created_by", "updated_by"], aRows);
  return { companies, contacts };
}

// ---- run ---------------------------------------------------------------------------------
await app.ready();
const t0 = performance.now();
await call("POST", "/auth/register", { email: "owner@example.com", password: "correct horse battery" });
await call("POST", "/auth/login", { email: "owner@example.com", password: "correct horse battery" });
const me = (await call("GET", "/auth/me")).json.user.id as string;
const other = (await call("POST", "/orgs", { name: "Other" })).json.org.id as string;
orgId = (await call("POST", "/orgs", { name: "Acme" })).json.org.id as string;
await call("GET", "/api/contacts?limit=1"); // migrations
const main = await seed(orgId, me, 1);
await seed(other, me, 0.2); // a second tenant in the same tables
const seedMs = performance.now() - t0;
console.log(`seeded ${N_CONTACTS} contacts (+20% in a second org) in ${Math.round(seedMs)} ms`);
await db.exec("ANALYZE");

const sampleCompany = main.companies[5];
const sampleContact = main.contacts[777];
const enc = encodeURIComponent;
const scenarios: [string, () => string][] = [
  ["list default (-createdAt)", () => "/api/contacts?limit=50"],
  ["list page 20 (cursor)", () => "CURSOR"],
  ["filter stage=lead", () => "/api/contacts?stage=lead&limit=50"],
  ["filter stage + sort name", () => "/api/contacts?stage=customer&sort=name&limit=50"],
  ["sort -value", () => "/api/contacts?sort=-value&limit=50"],
  ["view upcoming (date filter + sort)", () => "/api/contacts?view=upcoming&limit=50"],
  ["filter company=<id>", () => `/api/contacts?company=${sampleCompany}&limit=50`],
  ["filter owner + stage in", () => `/api/contacts?filter=${enc(JSON.stringify({ owner: me, stage: { in: ["lead", "qualified"] } }))}&limit=50`],
  ["filter value range", () => `/api/contacts?value[gte]=500000&value[lt]=600000&limit=50`],
  ["filter tags contains vip", () => `/api/contacts?filter=${enc(JSON.stringify({ tags: { contains: "vip" } }))}&limit=50`],
  ["search q (FTS) common word", () => "/api/contacts?q=acme&limit=50"],
  ["search q (FTS) rare", () => `/api/contacts?q=${enc("grace stark 4242")}&limit=50`],
  ["filter name contains (LIKE)", () => `/api/contacts?filter=${enc(JSON.stringify({ name: { contains: "wonka 99" } }))}&limit=50`],
  ["list + include=company", () => "/api/contacts?limit=50&include=company"],
  ["deals view closingSoon", () => "/api/deals?view=closingSoon&limit=50"],
  ["deals pipeline stage=proposal sort -amount", () => "/api/deals?stage=proposal&sort=-amount&limit=50"],
  ["activities for a contact", () => `/api/activities?subjectType=contacts&subjectId=${sampleContact}&limit=50`],
  ["get contact by id", () => `/api/contacts/${sampleContact}`],
  ["timeline of a contact", () => `/api/crm/timeline/contacts/${sampleContact}`],
];

async function cursorPage(pages: number) {
  let path = "/api/contacts?limit=50";
  for (let i = 0; i < pages; i++) {
    const r = await call("GET", path);
    path = `/api/contacts?limit=50&cursor=${r.json.nextCursor}`;
  }
  return path;
}

const results: Record<string, unknown>[] = [];
const plans: Record<string, string[]> = {};
for (const [name, mk] of scenarios) {
  let path = mk();
  if (path === "CURSOR") path = await cursorPage(19);
  const lat: number[] = [];
  // warm-up
  for (let i = 0; i < 5; i++) await call("GET", path);
  counting = true;
  captured = [];
  const r = await call("GET", path);
  counting = false;
  if (r.status !== 200) throw new Error(`${name}: ${r.status} ${r.text.slice(0, 300)}`);
  const stmts = captured.length;
  const main = captured.filter((c) => /^\s*SELECT/i.test(c.sql) && !/sqlite_master|_migrations|admin_system|org_members|sessions|users/i.test(c.sql));
  plans[name] = [];
  for (const c of main) {
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).bind(...c.values).all<{ detail: string }>()).results.map((x) => x.detail);
    plans[name].push(`${c.sql.slice(0, 160)}\n      ${plan.join("\n      ")}`);
  }
  for (let i = 0; i < REPS; i++) {
    const s = performance.now();
    await call("GET", path);
    lat.push(performance.now() - s);
  }
  const row = { scenario: name, p50: r2(q(lat, 0.5)), p99: r2(q(lat, 0.99)), statements: stmts, items: Array.isArray(r.json?.items) ? r.json.items.length : null };
  results.push(row);
  console.log(`${name.padEnd(44)} p50 ${String(row.p50).padStart(7)} ms  p99 ${String(row.p99).padStart(7)} ms  stmts ${stmts}`);
}

// ---- export ------------------------------------------------------------------------------
Bun.gc(true);
const heap0 = process.memoryUsage().heapUsed;
const rss0 = process.memoryUsage().rss;
let peakHeap = heap0;
let peakRss = rss0;
const te = performance.now();
const exp = await call("GET", "/api/contacts/export.csv", undefined, true);
const reader = exp.res.body!.getReader();
let bytes = 0;
let lines = 0;
let chunks = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  bytes += value.byteLength;
  for (let i = 0; i < value.length; i++) if (value[i] === 10) lines++;
  if (++chunks % 20 === 0) {
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakRss = Math.max(peakRss, m.rss);
  }
}
const exportMs = performance.now() - te;
const exportRes = { rows: lines - 1, mb: mb(bytes), ms: Math.round(exportMs), rowsPerSec: Math.round(((lines - 1) / exportMs) * 1000), heapStartMB: mb(heap0), peakHeapDeltaMB: mb(peakHeap - heap0), peakRssDeltaMB: mb(peakRss - rss0) };
console.log("export", exportRes);
// Second pass: live heap after a full GC every ~5k rows. Flat = the export streams (nothing per
// row is retained); the peak above also counts garbage not yet collected.
{
  Bun.gc(true);
  const { heapStats } = await import("bun:jsc");
  const base = heapStats().heapSize;
  const live: number[] = [];
  const r2r = (await call("GET", "/api/contacts/export.csv", undefined, true)).res.body!.getReader();
  let rows = 0;
  let next = 5000;
  for (;;) {
    const { done, value } = await r2r.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) if (value[i] === 10) rows++;
    if (rows >= next) {
      next += 5000;
      Bun.gc(true);
      live.push(heapStats().heapSize - base);
    }
  }
  (exportRes as Record<string, unknown>).liveHeapAfterGcMB = { first: mb(live[0] ?? 0), max: mb(Math.max(...live)), last: mb(live[live.length - 1] ?? 0), samples: live.length };
  console.log("export live heap after GC (MB over baseline)", (exportRes as Record<string, unknown>).liveHeapAfterGcMB);
}

// ---- import 5k ---------------------------------------------------------------------------
const csvLines = ["name,email,stage,value,company,tags"];
for (let i = 0; i < 5000; i++) csvLines.push(`Imported ${i},imp${i}@y.example,lead,${(i % 1000) + 0.5},${i % 3 === 0 ? `${pick(words)} ${pick(words)} 1` : ""},"a, b"`);
// relation by title: use real names for some rows
const titleRow = await db.prepare("SELECT name FROM companies WHERE org_id = ? LIMIT 1").bind(orgId).first<{ name: string }>();
const csv = csvLines.map((l, i) => (i > 0 && i % 3 === 1 ? l.replace(/,[^,]*,"a, b"$/, `,${titleRow!.name},"a, b"`) : l)).join("\n").replace(/,(\w+ \w+ 1),"a, b"/g, ',,"a, b"');
counting = true;
captured = [];
let ti = performance.now();
const dry = await call("POST", "/api/contacts/import", { csv, dryRun: true });
const dryMs = performance.now() - ti;
const dryStmts = captured.length;
captured = [];
ti = performance.now();
const imp = await call("POST", "/api/contacts/import", { csv });
const impMs = performance.now() - ti;
const impStmts = captured.length;
const impBreakdown = breakdown(captured);
counting = false;
const importRes = { status: imp.status, dryStatus: dry.status, invalid: dry.json?.invalid, imported: imp.json?.imported, dryRunMs: Math.round(dryMs), dryRunStatements: dryStmts, importMs: Math.round(impMs), importStatements: impStmts, importBreakdown: impBreakdown, error: imp.status !== 200 ? imp.text.slice(0, 200) : undefined };
console.log("import 5k", importRes);

// ---- bulk update 500 ---------------------------------------------------------------------
const ids = main.contacts.slice(1000, 1500);
counting = true;
captured = [];
const tb = performance.now();
const bulk = await call("POST", "/api/contacts/bulk", { action: "update", ids, changes: { stage: "qualified", company: main.companies[1] } });
const bulkMs = performance.now() - tb;
counting = false;
const bulkRes = { status: bulk.status, ms: Math.round(bulkMs), statements: captured.length, breakdown: breakdown(captured) };
console.log("bulk update 500", bulkRes);

// ---- audit cost per mutation -------------------------------------------------------------
const auditCost: Record<string, unknown> = {};
{
  const lat: number[] = [];
  for (let i = 0; i < 300; i++) {
    const s = performance.now();
    await call("PATCH", `/api/contacts/${main.contacts[2000 + i]}`, { stage: i % 2 ? "lead" : "customer" });
    lat.push(performance.now() - s);
  }
  counting = true;
  captured = [];
  await call("PATCH", `/api/contacts/${main.contacts[2400]}`, { stage: "lost" });
  counting = false;
  auditCost.patchP50 = r2(q(lat, 0.5));
  auditCost.patchP99 = r2(q(lat, 0.99));
  auditCost.statements = captured.length;
  auditCost.auditStatements = captured.filter((c) => /audit/i.test(c.sql)).length;
  auditCost.breakdown = breakdown(captured);
}
console.log("PATCH (with audit)", auditCost);

// ---- concurrent users --------------------------------------------------------------------
async function concurrent(users: number, ms: number) {
  const lat: number[] = [];
  const errors: Record<string, number> = {};
  let n = 0;
  const end = performance.now() + ms;
  const user = async (u: number) => {
    let mine: string | null = null;
    while (performance.now() < end) {
      const roll = Math.random();
      const s = performance.now();
      let r;
      if (roll < 0.4) r = await call("GET", `/api/contacts?limit=25&stage=${pick(["lead", "customer"])}`);
      else if (roll < 0.55) r = await call("GET", `/api/contacts?q=${pick(words)}&limit=25`);
      else if (roll < 0.7) r = await call("GET", `/api/contacts/${pick(main.contacts)}`);
      else if (roll < 0.82) { r = await call("POST", "/api/contacts", { name: `Load ${u}-${n}`, stage: "lead", company: pick(main.companies) }); if (r.status === 201) mine = r.json.id; }
      else if (roll < 0.94) r = await call("PATCH", `/api/contacts/${mine ?? pick(main.contacts)}`, { stage: pick(["lead", "qualified", "customer"]) });
      else if (roll < 0.97) r = await call("GET", `/api/deals?view=closingSoon&limit=25`);
      else { r = mine ? await call("DELETE", `/api/contacts/${mine}`) : await call("GET", "/api/tasks?limit=25"); mine = null; }
      lat.push(performance.now() - s);
      n++;
      if (r.status >= 400) errors[r.status] = (errors[r.status] ?? 0) + 1;
    }
  };
  const start = performance.now();
  await Promise.all(Array.from({ length: users }, (_, u) => user(u)));
  const took = performance.now() - start;
  return { users, requests: n, rps: Math.round((n / took) * 1000), p50: r2(q(lat, 0.5)), p99: r2(q(lat, 0.99)), errors };
}
const conc = [];
timing = new Map();
for (const u of [50, 200]) {
  const c = await concurrent(u, Number(argv.concurrentMs ?? 10_000));
  conc.push(c);
  console.log("concurrent", c);
}
const sqlTop = [...timing.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 10).map(([k, [n, ms]]) => ({ sql: k.replace(/s+/g, " ").slice(0, 140), calls: n, totalMs: Math.round(ms), avgMs: r2(ms / n) }));
timing = null;
console.log("slowest SQL in the concurrent phase", sqlTop);
Bun.gc(true);
const end = process.memoryUsage();
const out = { at: new Date().toISOString(), contacts: N_CONTACTS, db: argv.db === "file" ? "file" : "memory", seedMs: Math.round(seedMs), scenarios: results, plans, export: exportRes, import: importRes, bulk: bulkRes, auditCost, concurrent: conc, sqlTop, endHeapMB: mb(end.heapUsed), endRssMB: mb(end.rss) };
mkdirSync(join(import.meta.dir, "results"), { recursive: true });
writeFileSync(join(import.meta.dir, "results", `backoffice-bench${suffix}.json`), JSON.stringify(out, null, 2));
if (argv.plans) for (const [k, v] of Object.entries(plans)) console.log(`\n# ${k}\n  ${v.join("\n  ")}`);
await app.close();
if (dbFile !== ":memory:") rmSync(dbFile, { force: true });
