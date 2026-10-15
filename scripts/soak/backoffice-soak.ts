// Back-office soak: examples/crm served over real HTTP (scripts/soak/serve-bun.ts crm, production
// password hashing, in-memory SQLite), driven by N signed-in users doing mixed CRM work for a
// fixed time. Samples the server's RSS and heap after a full GC, then checks that the heap stays
// flat (no per-request retention), RSS comes back after the load, and the process exits by itself
// after /__soak/stop.
//
//   bun scripts/soak/backoffice-soak.ts                       # 600 s, 32 users
//   bun scripts/soak/backoffice-soak.ts --duration=60 --users=16 --suffix=quick
//
// Results: scripts/soak/results/backoffice-soak[-suffix].json and a summary on stdout.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
const DURATION = Number(argv.duration ?? 600) * 1000;
const USERS = Number(argv.users ?? 50);
const SAMPLE_MS = Number(argv.sample ?? 10_000);
const suffix = argv.suffix ? `-${argv.suffix}` : "";
const ROOT = join(import.meta.dir, "..", "..");

// ---- server ------------------------------------------------------------------------------
const t0 = performance.now();
// A SQLite file (WAL), so RSS measures the process and not an in-memory database that grows
// with every record, audit row and workflow run. --db=memory keeps it in memory.
const dbFile = argv.db === "memory" ? null : join(tmpdir(), `miu-backoffice-soak-${process.pid}.db`);
const proc = Bun.spawn([process.execPath, "scripts/soak/serve-bun.ts", "crm", "0"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(dbFile ? { DB_PATH: dbFile } : {}) } });
const dbSize = () => (dbFile ? [dbFile, `${dbFile}-wal`].reduce((a, p) => a + (existsSync(p) ? statSync(p).size : 0), 0) : 0);
const reader = proc.stdout.getReader();
let buf = "";
let port = 0;
while (!port) {
  const { value, done } = await reader.read();
  if (done) throw new Error(`server exited: ${await new Response(proc.stderr).text()}`);
  buf += new TextDecoder().decode(value);
  const m = /READY (\d+)/.exec(buf);
  if (m) port = Number(m[1]);
}
const coldMs = Math.round(performance.now() - t0);
const BASE = `http://127.0.0.1:${port}`;
const mem = async (gc = true) => (await (await fetch(`${BASE}/__soak/mem${gc ? "?gc=1" : ""}`)).json()) as { rss: number; heap: number; objects: number; inflight: number; orgId: string };

// ---- client ------------------------------------------------------------------------------
class Client {
  jar = new Map<string, string>();
  constructor(public ip: string, public org: string) {}
  async req(method: string, path: string, body?: unknown, read: "json" | "text" | "drain" = "json") {
    const headers = new Headers({ origin: BASE, "x-soak-ip": this.ip });
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (this.org && path.startsWith("/api")) headers.set("x-org-id", this.org);
    let b: string | undefined;
    if (body !== undefined) { b = JSON.stringify(body); headers.set("content-type", "application/json"); }
    const res = await fetch(BASE + path, { method, headers, body: b, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (/max-age=0/i.test(c) || i === pair.length - 1) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (read === "drain") { const r = res.body!.getReader(); let n = 0; for (;;) { const x = await r.read(); if (x.done) break; n += x.value.byteLength; } return { status: res.status, json: null as any, bytes: n }; }
    const text = await res.text();
    let json: any = null;
    if (read === "json") try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, bytes: text.length };
  }
}

const stats = new Map<string, { lat: number[]; errors: Record<number, number>; n: number }>();
const record = (op: string, ms: number, status: number) => {
  let s = stats.get(op);
  if (!s) stats.set(op, (s = { lat: [], errors: {}, n: 0 }));
  s.n++;
  if (s.lat.length < 20000) s.lat.push(ms);
  else s.lat[Math.floor(Math.random() * 20000)] = ms;
  if (status >= 400) s.errors[status] = (s.errors[status] ?? 0) + 1;
};
const q = (p: number[], f: number) => { const s = [...p].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 100) / 100 : 0; };
const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const words = ["acme", "globex", "initech", "hooli", "stark", "wonka", "umbrella", "duff"];

// ---- setup: sign in as the seeded owner, import a working set ------------------------------
const orgId = (await mem(false)).orgId;
const login = async (ip: string) => {
  const c = new Client(ip, orgId);
  const r = await c.req("POST", "/auth/login", { email: "owner@example.com", password: "correct horse battery" });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  return c;
};
const admin = await login("10.0.0.1");
const rows = Array.from({ length: 5000 }, (_, i) => `Seed ${pick(words)} ${i},seed${i}@soak.example,${pick(["lead", "qualified", "customer", "lost"])},${(i % 997) * 10}`);
const imp = await admin.req("POST", "/api/contacts/import", { csv: ["name,email,stage,value", ...rows].join("\n") });
if (imp.status !== 200) throw new Error(`seed import ${imp.status} ${JSON.stringify(imp.json).slice(0, 300)}`);
const ids: string[] = imp.json.ids;
const companies = (await admin.req("GET", "/api/companies?limit=50")).json.items.map((c: { id: string }) => c.id);
console.log(`server on :${port} (cold ${coldMs} ms); imported ${ids.length} contacts; ${USERS} users for ${DURATION / 1000} s`);

// ---- load --------------------------------------------------------------------------------
type Op = [string, number, (c: Client, mine: string[]) => Promise<{ status: number }>];
let importN = 0;
const ops: Op[] = [
  ["list stage", 14, (c) => c.req("GET", `/api/contacts?stage=${pick(["lead", "customer"])}&limit=25`)],
  ["list sort name", 6, (c) => c.req("GET", `/api/contacts?sort=${pick(["name", "-name"])}&limit=25`)],
  ["list sort value", 5, (c) => c.req("GET", `/api/contacts?sort=-value&limit=25`)],
  ["search", 8, (c) => c.req("GET", `/api/contacts?q=${pick(words)}&limit=25`)],
  ["get", 10, (c) => c.req("GET", `/api/contacts/${pick(ids)}`)],
  ["create", 9, async (c, mine) => { const r = await c.req("POST", "/api/contacts", { name: `Soak ${pick(words)}`, stage: pick(["lead", "customer"]), company: pick(companies) }); if (r.status === 201) mine.push(r.json.id); return r; }],
  ["update", 9, (c, mine) => c.req("PATCH", `/api/contacts/${mine.length ? pick(mine) : pick(ids)}`, { stage: pick(["qualified", "customer"]), value: Math.floor(Math.random() * 1e6) })],
  ["delete", 5, async (c, mine) => (mine.length ? c.req("DELETE", `/api/contacts/${mine.pop()}`) : c.req("GET", "/api/tasks?limit=10"))],
  ["bulk update 20", 3, (c) => { const start = Math.floor(Math.random() * (ids.length - 20)); return c.req("POST", "/api/contacts/bulk", { action: "update", ids: ids.slice(start, start + 20), changes: { stage: pick(["lead", "qualified"]) } }); }],
  ["export (filtered)", 2, (c) => c.req("GET", `/api/contacts/export.csv?stage=lost`, undefined, "drain")],
  // Mostly customers: every imported lead starts the CRM's follow-up workflow (a run + a task).
  ["import 50", 2, (c) => { const n = importN++; return c.req("POST", "/api/contacts/import", { csv: ["name,email,stage", ...Array.from({ length: 50 }, (_, i) => `Imp ${n}-${i},imp${n}-${i}@soak.example,${i % 10 ? "customer" : "lead"}`)].join("\n") }); }],
  ["timeline", 5, (c) => c.req("GET", `/api/crm/timeline/contacts/${pick(ids)}`)],
  ["deals closingSoon", 4, (c) => c.req("GET", `/api/deals?view=closingSoon&limit=25`)],
  ["tasks open", 4, (c) => c.req("GET", `/api/tasks?view=open&limit=25`)],
  ["admin UI list page", 6, (c) => c.req("GET", `/admin/r/contacts`, undefined, "text")],
  ["admin UI record page", 3, (c) => c.req("GET", `/admin/r/contacts/${pick(ids)}`, undefined, "text")],
];
const total = ops.reduce((a, o) => a + o[1], 0);
const chooseOp = () => { let r = Math.random() * total; for (const o of ops) { r -= o[1]; if (r < 0) return o; } return ops[0]; };

const samples: { t: number; rss: number; heap: number; objects: number }[] = [];
const loadStart = performance.now();
const end = loadStart + DURATION;
let stopSampling = false;
const sampler = (async () => {
  while (!stopSampling) {
    await Bun.sleep(SAMPLE_MS);
    if (stopSampling) break;
    const m = await mem(true);
    samples.push({ t: Math.round((performance.now() - loadStart) / 1000), rss: m.rss, heap: m.heap, objects: m.objects });
    process.stdout.write(`  t=${samples.at(-1)!.t}s rss ${mb(m.rss)} MB heap ${mb(m.heap)} MB objects ${m.objects} db ${mb(dbSize())} MB\n`);
  }
})();
const user = async (u: number) => {
  // One sign-in shared by every user (per-account sign-in limits would refuse 50 logins at once).
  const c = new Client(`10.1.${Math.floor(u / 250)}.${u % 250}`, orgId);
  c.jar = new Map(admin.jar);
  const mine: string[] = [];
  while (performance.now() < end) {
    const [name, , fn] = chooseOp();
    const s = performance.now();
    let status = 0;
    try {
      status = (await fn(c, mine)).status;
    } catch {
      status = 599;
    }
    record(name, performance.now() - s, status);
  }
};
await Promise.all(Array.from({ length: USERS }, (_, u) => user(u)));
stopSampling = true;
await sampler;
const loadMs = performance.now() - loadStart;
const atEnd = await mem(true);
/** Workflow runs by status, read from the database file (WAL allows a second reader). */
const runCounts = async (): Promise<Record<string, number> | null> => {
  if (!dbFile) return null;
  const { Database } = await import("bun:sqlite");
  const ro = new Database(dbFile, { readonly: true });
  try {
    const rows = ro.query("SELECT status, COUNT(*) AS n FROM workflow_runs GROUP BY status").all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  } catch {
    return null;
  } finally {
    ro.close();
  }
};
const runsAtEnd = await runCounts();
// --settle (seconds, default 10): idle time before the settled sample, e.g. for a workflow backlog to drain.
await Bun.sleep(Number(argv.settle ?? 10) * 1000);
const settled = await mem(true);
const runsSettled = await runCounts();

// ---- shutdown ----------------------------------------------------------------------------
const tStop = performance.now();
await fetch(`${BASE}/__soak/stop`);
const exitWait = Number(argv["exit-wait"] ?? 120) * 1000;
const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(exitWait).then(() => false)]);
const exitMs = Math.round(performance.now() - tStop);
if (!exited) proc.kill();

// ---- verdict -----------------------------------------------------------------------------
const warm = samples[Math.max(0, Math.floor(samples.length * 0.2) - 1)] ?? samples[0];
const last = samples.at(-1)!;
// Least-squares slope of the heap over the samples after warm-up, in bytes per minute.
const tail = samples.filter((s) => s.t >= warm.t);
const n = tail.length;
const mx = tail.reduce((a, s) => a + s.t, 0) / n;
const my = tail.reduce((a, s) => a + s.heap, 0) / n;
const slope = (tail.reduce((a, s) => a + (s.t - mx) * (s.heap - my), 0) / Math.max(1, tail.reduce((a, s) => a + (s.t - mx) ** 2, 0))) * 60;
let requests = 0;
let errors = 0;
const perOp = [...stats].map(([op, s]) => {
  requests += s.n;
  const e = Object.values(s.errors).reduce((a, b) => a + b, 0);
  errors += e;
  return { op, n: s.n, p50: q(s.lat, 0.5), p99: q(s.lat, 0.99), errors: s.errors };
});
const out = {
  at: new Date().toISOString(),
  durationS: Math.round(loadMs / 1000),
  users: USERS,
  coldMs,
  requests,
  rps: Math.round((requests / loadMs) * 1000),
  errors,
  perOp,
  memory: {
    warmup: { t: warm.t, rssMB: mb(warm.rss), heapMB: mb(warm.heap), objects: warm.objects },
    lastSample: { t: last.t, rssMB: mb(last.rss), heapMB: mb(last.heap), objects: last.objects },
    endOfLoad: { rssMB: mb(atEnd.rss), heapMB: mb(atEnd.heap), objects: atEnd.objects },
    settled: { afterS: Number(argv.settle ?? 10), rssMB: mb(settled.rss), heapMB: mb(settled.heap), objects: settled.objects },
    heapGrowthPct: Math.round(((settled.heap - warm.heap) / warm.heap) * 1000) / 10,
    heapSlopeKBPerMin: Math.round(slope / 1024),
    peakRssMB: mb(Math.max(...samples.map((s) => s.rss), atEnd.rss)),
  },
  shutdown: { exited, exitMs },
  database: dbFile ? { file: true, sizeMB: mb(dbSize()) } : { file: false },
  workflowRuns: { atEndOfLoad: runsAtEnd, settled: runsSettled },
  samples: samples.map((s) => ({ t: s.t, rssMB: mb(s.rss), heapMB: mb(s.heap), objects: s.objects })),
};
mkdirSync(join(import.meta.dir, "results"), { recursive: true });
writeFileSync(join(import.meta.dir, "results", `backoffice-soak${suffix}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, samples: undefined }, null, 2));
if (dbFile) for (const p of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(p, { force: true });
process.exit(exited && errors === 0 ? 0 : 1);
