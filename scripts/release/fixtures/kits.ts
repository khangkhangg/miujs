// The kits as a consumer installs them: scripts/release/verify.ts runs this from the tarballs on
// Node, Deno and Bun, and type-checks it with tsc. @miujs/admin serves a resource's CRUD through
// app.request (with access + audit); @miujs/game, @miujs/tour and @miujs/migrate import and build
// their plugins. The last stdout line is a JSON report (the same shape as app.ts). Exit 1 on failure.
import { definePlugin, detectRuntime, miu, t, type AuthUser } from "miujs";
import { access, defineRoles } from "@miujs/access";
import { admin, field, resource } from "@miujs/admin";
import { audit, memoryAuditStore } from "@miujs/audit";
import { db, sqlite, type Database } from "@miujs/db";
import { memoryStore } from "@miujs/files";
import { createMatchmakerDurableObject, matchmaker } from "@miujs/game";
import { migrateProxy } from "@miujs/migrate";
import { defineRoom, rooms } from "@miujs/realtime";
import { tour } from "@miujs/tour";
import { nodeSqliteD1 } from "./d1-node-sqlite.ts";

const runtime = detectRuntime();
const database: Database = runtime === "bun" ? sqlite(":memory:") : await nodeSqliteD1(":memory:");

const checks: Record<string, boolean> = {};
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = ok;
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
};

/** Sign-in stand-in: `x-user: <id>` (a real app uses @miujs/auth). */
const signIn = definePlugin({
  name: "verify-sign-in",
  onRequest(ctx) {
    const id = ctx.headers.get("x-user");
    if (id) ctx.user = { id, roles: ["owner"] } as AuthUser;
  },
});

const notes = resource("notes", { fields: { title: field.text({ required: true, searchable: true }), done: field.boolean() } });
const app = miu({
  name: "release-verify-kits",
  dev: false,
  logLevel: "silent",
  plugins: [
    db({ database }),
    signIn,
    access({ roles: defineRoles({ owner: ["*"] }), database, routes: false }),
    audit({ store: memoryAuditStore(), routes: false }),
    admin({ resources: [notes], autoMigrate: true }),
  ],
});

try {
  await app.ready();
  const req = async (method: string, path: string, body?: unknown, user: string | null = "ann") => {
    const headers: Record<string, string> = {};
    if (user) headers["x-user"] = user;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const anon = await req("GET", "/api/notes", undefined, null);
  check("admin.auth", anon.status === 401, anon);
  const created = await req("POST", "/api/notes", { title: "ship the kits" });
  const id = created.body?.id;
  check("admin.create", created.status === 201 && typeof id === "string" && created.body.title === "ship the kits", created);
  const updated = await req("PATCH", `/api/notes/${id}`, { done: true });
  check("admin.update", updated.status === 200 && updated.body.done === true, updated);
  const listed = await req("GET", "/api/notes");
  check("admin.list", listed.status === 200 && listed.body.items?.length === 1 && listed.body.items[0].id === id, listed);
  const invalid = await req("POST", "/api/notes", {});
  check("admin.validation", invalid.status === 400, invalid);
  const removed = await req("DELETE", `/api/notes/${id}`);
  const gone = await req("GET", `/api/notes/${id}`);
  check("admin.delete", removed.status < 300 && gone.status === 404, [removed, gone]);

  // game: a matchmaker over a realtime room, and its Durable Object class
  const duel = defineRoom("duel", { state: t.object({ moves: t.number() }), init: () => ({ moves: 0 }) });
  const realtime = rooms({ rooms: [duel] });
  const mm = matchmaker({ rooms: realtime, database, secret: "release-verify-game-secret-0123456789", queues: { ranked: { room: "duel", teamSize: 1, rating: "elo", widenAfterMs: 5000, maxWaitMs: 60000 } } });
  check("game.plugin", mm.name === "matchmaker" && typeof createMatchmakerDurableObject(mm) === "function", mm.name);
  realtime.stop();

  // tour and migrate: their plugins build
  const tourPlugin = tour({ database, store: memoryStore(), secret: "release-verify-tour-secret-0123456789abcdef" });
  check("tour.plugin", typeof tourPlugin.name === "string" && Array.isArray(tourPlugin.routes), tourPlugin.name);
  const proxy = migrateProxy({ upstream: "http://127.0.0.1:9" });
  check("migrate.plugin", typeof proxy.name === "string", proxy.name);
} catch (e) {
  failures.push(`threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await app.close();
}

console.log(JSON.stringify({ runtime, resolved: { miujs: import.meta.resolve("miujs") }, checks, failures }));
if (failures.length) process.exit(1);
