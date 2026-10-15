// examples/api on workerd: D1 migrations + CRUD, sessions + auth (PBKDF2: Workers have no
// argon2), API tokens, KV-backed cache, Queues produce → consume, MCP with a Bearer token, and
// CRUD latency with a session check.

import { Client, check, eq, explorer, mcp, metrics, percentiles, scenario, skip, waitFor, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

const SECRET = "workerd-harness-session-secret-0123456789abcdef";
export const app: AppSpec = { name: "api", dir: "examples/api", vars: { SESSION_SECRET: SECRET } };

export async function run(dev: Dev, _ctx: SuiteContext) {
  const S = (name: string, fn: () => Promise<string | void>) => scenario("api", name, fn);
  const anon = new Client(dev.url);
  const mia = new Client(dev.url);
  let token = "";

  await S("cold start: first request (core + db + session + auth + cache + queue)", async () => {
    const first = await anon.get("/notes");
    eq([first.status, first.json?.error?.code], [401, "MIU_E_UNAUTHORIZED"], "anonymous GET /notes");
    const warm: number[] = [];
    for (let i = 0; i < 100; i++) warm.push((await anon.get("/notes")).ms);
    const w = percentiles(warm);
    metrics.apiColdStart = { startupMs: Math.round(dev.startupMs), firstRequestMs: Math.round(first.ms * 100) / 100, warm: w };
    return `wrangler ready ${Math.round(dev.startupMs)} ms, first request ${first.ms.toFixed(1)} ms (runs D1 migrations), warm p50 ${w.p50} ms`;
  });

  await S("D1: migrations ran (notes table and _miu_migrations)", async () => {
    const dbs = await explorer(dev, "/d1/database");
    const db = dbs.result?.[0];
    check(db, `no D1 database: ${JSON.stringify(dbs).slice(0, 300)}`);
    const q = await explorer(dev, `/d1/database/${db.uuid}/raw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" }) });
    const names = JSON.stringify(q);
    check(names.includes('"notes"') && names.includes("_miu_migrations"), names.slice(0, 500));
    return `database ${db.name}`;
  });

  await S("auth: register + login with PBKDF2 (no argon2 on Workers), session cookie", async () => {
    const reg = await mia.post("/auth/register", { email: "mia@example.com", password: "correct horse battery" });
    check(reg.status === 201, `register ${reg.status}: ${reg.text.slice(0, 400)}`);
    const me = await mia.get("/auth/me");
    eq([me.status, me.json?.user?.email], [200, "mia@example.com"], "me after register");
    const fresh = new Client(dev.url);
    const login = await fresh.post("/auth/login", { email: "mia@example.com", password: "correct horse battery" });
    check(login.status === 200, `login ${login.status}: ${login.text.slice(0, 300)}`);
    const wrong = await new Client(dev.url).post("/auth/login", { email: "mia@example.com", password: "wrong password!!" });
    eq(wrong.status, 401, "wrong password");
    const users = await explorer(dev, "/d1/database");
    const q = await explorer(dev, `/d1/database/${users.result[0].uuid}/raw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT password_hash FROM users LIMIT 1" }) });
    const hash = JSON.stringify(q);
    check(hash.includes("pbkdf2_sha256$"), `stored hash: ${hash.slice(0, 200)}`);
    const iterations = /pbkdf2_sha256\$(\d+)\$/.exec(hash)?.[1];
    return `stored as pbkdf2_sha256 with ${iterations} iterations; register ${reg.ms.toFixed(0)} ms, login ${login.ms.toFixed(0)} ms`;
  });

  await S("CSRF: a cross-origin POST with the session cookie is refused", async () => {
    const r = await mia.req("POST", "/notes", { json: { title: "x" }, headers: { origin: "https://evil.example" } });
    check(r.status === 403, `status ${r.status}`);
  });

  await S("validation: empty title is a 400 MIU_E_VALIDATION", async () => {
    const r = await mia.post("/notes", { title: "" });
    eq([r.status, r.json?.error?.code], [400, "MIU_E_VALIDATION"], "empty title");
  });

  let noteId = "";
  await S("D1 CRUD with the session (create, get, list, delete, 404)", async () => {
    const created = await mia.post("/notes", { title: "Buy tea", body: "oolong" });
    eq(created.status, 201, "create");
    noteId = created.json.id;
    eq((await mia.get(`/notes/${noteId}`)).json.title, "Buy tea", "get");
    const list = await mia.get("/notes");
    eq(list.json.notes.map((n: { id: string }) => n.id), [noteId], "list");
    const other = new Client(dev.url);
    await other.post("/auth/register", { email: "eve@example.com", password: "correct horse battery" });
    eq((await other.get(`/notes/${noteId}`)).status, 404, "another user's note");
    eq((await mia.req("DELETE", `/notes/${noteId}`)).status, 204, "delete");
    eq((await mia.get(`/notes/${noteId}`)).status, 404, "deleted");
  });

  await S("KV cache: the note list is cached in the CACHE namespace and invalidated on write", async () => {
    await mia.post("/notes", { title: "cached" });
    const first = await mia.get("/notes");
    eq(first.json.notes.length, 1, "list");
    const ns = await explorer(dev, "/storage/kv/namespaces");
    const cacheNs = (ns.result ?? []).find((n: { title: string; id: string }) => /cache/i.test(n.title) || /cache/i.test(n.id));
    if (!cacheNs) throw new Error(`no CACHE KV namespace bound (the cache fell back to per-isolate memory): ${JSON.stringify(ns).slice(0, 300)}`);
    const keys = await explorer(dev, `/storage/kv/namespaces/${cacheNs.id}/keys`);
    check(JSON.stringify(keys).includes("notes:"), `KV keys: ${JSON.stringify(keys).slice(0, 300)}`);
    await mia.post("/notes", { title: "second" });
    eq((await mia.get("/notes")).json.notes.length, 2, "list after write (cache invalidated)");
    return `namespace ${cacheNs.title ?? cacheNs.id}`;
  });

  await S("Queues: createNote dispatches note-created, the consumer acks it", async () => {
    // The job only logs at info level (off outside dev), so count Miniflare's "QUEUE <name> acked/total" lines.
    const acked = () => [...dev.logs().matchAll(/QUEUE notes-api-jobs (\d+)\/(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    const before = acked();
    await mia.post("/notes", { title: "queued" });
    const t0 = performance.now();
    await waitFor(() => acked() > before, 15_000, "a QUEUE notes-api-jobs batch acked by the consumer", 50);
    return `acked after ${Math.round(performance.now() - t0)} ms (job effects are checked in the kitchen suite)`;
  });

  await S("API token: create, then call MCP with Bearer", async () => {
    const t = await mia.post("/auth/tokens", { name: "agent" });
    eq(t.status, 201, "token");
    token = t.json.token;
    const bot = new Client(dev.url, { authorization: `Bearer ${token}` });
    const tools = (await mcp(bot, "tools/list")).result?.tools?.map((x: { name: string }) => x.name) ?? [];
    check(tools.some((n: string) => /notes/i.test(n)), `tools: ${tools}`);
    const listTool = tools.find((n: string) => /^list/i.test(n) && /notes/i.test(n));
    const called = await mcp(bot, "tools/call", { name: listTool, arguments: {} });
    check(JSON.stringify(called).includes("queued"), `tools/call: ${JSON.stringify(called).slice(0, 300)}`);
    return `tools: ${tools.join(", ")}`;
  });

  await S("CRUD on D1 with a session check: latency (create + get + list + delete)", async () => {
    const lat: Record<string, number[]> = { create: [], get: [], list: [], delete: [] };
    for (let i = 0; i < 150; i++) {
      const c = await mia.post("/notes", { title: `n${i}` });
      if (c.status !== 201) throw new Error(`create ${c.status} ${c.text.slice(0, 200)}`);
      lat.create.push(c.ms);
      lat.get.push((await mia.get(`/notes/${c.json.id}`)).ms);
      lat.list.push((await mia.get("/notes")).ms);
      lat.delete.push((await mia.req("DELETE", `/notes/${c.json.id}`)).ms);
    }
    const all = Object.values(lat).flat();
    const summary = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, percentiles(v)]));
    metrics.d1Crud = { all: percentiles(all), ...summary };
    const p = percentiles(all);
    return `${p.count} requests: p50 ${p.p50} ms, p99 ${p.p99} ms`;
  });

  await S("logout ends the session", async () => {
    eq((await mia.post("/auth/logout")).status, 204, "logout");
    eq((await mia.get("/notes")).status, 401, "after logout");
  });

  void skip;
}
