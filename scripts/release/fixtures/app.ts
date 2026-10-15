// The consumer app scripts/release/verify.ts runs from installed tarballs on Node (through
// miujs/node), Deno and Bun, and type-checks with tsc. It serves real HTTP and checks every answer;
// the last stdout line is a JSON report. Exit code 1 if any check failed.
import { detectRuntime, miu, route, t } from "miujs";
import { serveNode } from "miujs/node";
import { auth, dbUserStore } from "@miujs/auth";
import { bots } from "@miujs/bots";
import { cache } from "@miujs/cache";
import { db, sqlite, type Database } from "@miujs/db";
import { defineJob, queue } from "@miujs/queue";
import { defineRoom, rooms } from "@miujs/realtime";
import { session } from "@miujs/session";
import { nodeSqliteD1 } from "./d1-node-sqlite.ts";

const runtime = detectRuntime();
// @miujs/db's sqlite() is bun:sqlite; Node and Deno get a D1-shaped node:sqlite database.
const database: Database = runtime === "bun" ? sqlite(":memory:") : await nodeSqliteD1(":memory:");

const sent: string[] = [];
const welcome = defineJob("welcome", {
  input: t.object({ to: t.string() }),
  run: async ({ input }) => {
    sent.push(input.to);
  },
});

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  client: { say: t.object({ text: t.string() }) },
  init: () => ({ lines: [] as string[] }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`];
    },
  },
});
const realtime = rooms({ rooms: [chat] });

let computed = 0;
const routes = [
  route.get("/hello/:name", {
    params: t.object({ name: t.string() }),
    handler: ({ params }) => ({ hi: params.name, runtime }),
  }),
  route.post("/notes", {
    body: t.object({ body: t.string() }),
    handler: async ({ body, db }) => {
      const r = await db.prepare("INSERT INTO notes (body) VALUES (?)").bind(body.body).run();
      return { id: r.meta.last_row_id };
    },
  }),
  route.get("/notes", {
    handler: async ({ db }) => ({ notes: (await db.prepare("SELECT id, body FROM notes ORDER BY id").all<{ id: number; body: string }>()).results }),
  }),
  route.get("/cached", {
    handler: async ({ cache }) => cache.remember("k", 60, async () => ({ computed: ++computed })),
  }),
  route.post("/signup-email", {
    body: t.object({ email: t.string() }),
    handler: async ({ body, queue }) => ({ queued: (await queue.dispatch(welcome, { to: body.email })).id }),
  }),
  route.get("/dashboard", { auth: "required", handler: ({ user }) => ({ hello: user.email ?? user.id }) }),
  route.post("/rooms-new", { handler: async () => realtime.createRoom("chat") }),
  route.get("/posts/:id", {
    params: t.object({ id: t.string() }),
    handler: ({ params, visitor }) => ({ id: params.id, servedTo: visitor.kind }),
  }),
];

const app = miu({
  name: "release-verify",
  dev: false,
  logLevel: "silent",
  routes,
  plugins: [
    session({ secret: "release-verify-secret-0123456789abcdef" }),
    db({ database, migrations: [{ id: "001_notes", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);" }] }),
    auth({ users: dbUserStore(database) }),
    cache(),
    queue({ jobs: [welcome] }),
    realtime,
    bots(),
  ],
});

await app.ready();
const server = runtime === "node" ? await serveNode(app, { port: 0, hostname: "127.0.0.1" }) : await app.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${server.port}`;

const checks: Record<string, boolean> = {};
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = ok;
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
};
const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const until = async (fn: () => Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await fn()) return true;
  return false;
};

try {
  // core: routing, params, validation, error docs links
  const hello = await json("GET", "/hello/ann");
  const helloBody = (await hello.json()) as { hi: string; runtime: string };
  check("core.route", hello.status === 200 && helloBody.hi === "ann" && helloBody.runtime === runtime, helloBody);
  const missing = await json("GET", "/nope");
  const missingBody = (await missing.json()) as { error: { code: string; docs?: string } };
  check("core.404", missing.status === 404 && missingBody.error.code.startsWith("MIU_E_"), missingBody);
  const invalid = await json("POST", "/notes", { body: 5 });
  check("core.validation", invalid.status === 400, await invalid.text());

  // db: migrations + insert/select through the D1 interface
  const added = await json("POST", "/notes", { body: "first" });
  const listed = (await (await json("GET", "/notes")).json()) as { notes: { id: number; body: string }[] };
  check("db.notes", added.status === 200 && listed.notes.length === 1 && listed.notes[0].body === "first", listed);

  // cache: second call is served from cache
  const c1 = (await (await json("GET", "/cached")).json()) as { computed: number };
  const c2 = (await (await json("GET", "/cached")).json()) as { computed: number };
  check("cache.remember", c1.computed === 1 && c2.computed === 1, [c1, c2]);

  // session + auth (dbUserStore on the same database)
  const anon = await json("GET", "/dashboard");
  check("auth.required", anon.status === 401, anon.status);
  const reg = await json("POST", "/auth/register", { email: "ann@example.com", password: "correct horse battery staple" });
  const cookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("auth.register", reg.status === 201 && cookie.length > 0, { status: reg.status, body: await reg.text() });
  const me = await json("GET", "/auth/me", undefined, { cookie });
  const meBody = (await me.json()) as { user?: { email?: string } };
  check("auth.me", me.status === 200 && meBody.user?.email === "ann@example.com", meBody);
  const dash = await json("GET", "/dashboard", undefined, { cookie });
  check("auth.session", dash.status === 200 && ((await dash.json()) as { hello: string }).hello === "ann@example.com", dash.status);

  // queue: in-process job runs after the response
  const q = await json("POST", "/signup-email", { email: "bob@example.com" });
  check("queue.dispatch", q.status === 200, await q.text());
  // Checked in process: GET /sent from a non-browser client is a bot to @miujs/bots, which caches it.
  check("queue.ran", await until(async () => sent.includes("bob@example.com")), sent);

  // realtime: create over HTTP, resolve the join code over HTTP, play in process
  const created = (await (await json("POST", "/rooms-new")).json()) as { id: string; code: string };
  const resolved = (await (await json("GET", `/rooms/code/${created.code}`)).json()) as { type: string; id: string };
  check("realtime.code", resolved.type === "chat" && resolved.id === created.id, resolved);
  const room = realtime.registry.get("chat", created.id);
  const frames: string[] = [];
  const socket = { id: "s1", data: {}, send: (m: string | Uint8Array | ArrayBuffer) => void frames.push(String(m)), close: () => {} };
  room?.connect(socket, { name: "Ann" });
  await room?.receive(socket, JSON.stringify({ t: "msg", type: "say", data: { text: "hi" } }));
  const state = room?.describe().state as { lines: string[] } | undefined;
  check("realtime.room", state?.lines[0] === "Ann: hi" && frames.some((f) => f.includes('"welcome"')), { state, frames: frames.length });
  realtime.stop();

  // bots: an AI crawler gets the handler once, then the cached copy
  const ua = { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" };
  const b1 = await json("GET", "/posts/1", undefined, ua);
  const b1Body = (await b1.json()) as { servedTo: string };
  check("bots.miss", b1.headers.get("x-miu-bot-cache") === "miss" && b1Body.servedTo === "ai", [b1.headers.get("x-miu-bot-cache"), b1Body]);
  check("bots.hit", await until(async () => {
    const r = await json("GET", "/posts/1", undefined, ua);
    await r.text();
    return r.headers.get("x-miu-bot-cache") === "hit";
  }), "never hit");
} catch (e) {
  failures.push(`threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await server.stop();
  if (runtime === "node") await app.stop(); // app.listen()'s stop() already stops the app
}

console.log(JSON.stringify({
  runtime,
  resolved: { miujs: import.meta.resolve("miujs"), cache: import.meta.resolve("@miujs/cache") },
  checks,
  failures,
}));
if (failures.length) process.exit(1);
