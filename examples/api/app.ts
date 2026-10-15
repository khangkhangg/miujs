// A notes API using every MiuJS battery: db, session, auth, cache and queue.
// Locally it uses SQLite and in-memory adapters; on Cloudflare (`miu deploy cloudflare`) the same
// code uses D1, KV and Queues.
//
//   bun examples/api/app.ts
//   curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
//        -d '{"email":"mia@example.com","password":"correct horse"}' -c jar
//   curl -X POST localhost:3000/notes -b jar -H 'content-type: application/json' -H 'origin: http://localhost:3000' -d '{"title":"Buy tea"}'

import { errors, miu, processEnv, route, t, targetRuntime } from "miujs";
import { auth, dbUserStore } from "@miujs/auth";
import { cache } from "@miujs/cache";
import { d1, db, sqlite, type DatabaseSource } from "@miujs/db";
import { defineJob, memoryQueue, queue } from "@miujs/queue";
import { session } from "@miujs/session";

const migrations = [
  {
    id: "001_notes",
    sql: `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_user ON notes(user_id, created_at);`,
  },
];

const Note = t.object({ id: t.string(), title: t.string(), body: t.string(), createdAt: t.string() });

interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
}
const toNote = (r: NoteRow) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at });
const listKey = (userId: string) => `notes:${userId}`;

export interface CreateAppOptions {
  /** Signs session cookies. Default: $SESSION_SECRET (a random one is generated in dev). */
  sessionSecret?: string;
  /** Lower PBKDF2 iterations only in tests. */
  passwordIterations?: number;
  dev?: boolean;
  /** SQLite file for local runs. Default: in memory. */
  dbPath?: string;
}

export function createApp(opts: CreateAppOptions = {}) {
  const source: DatabaseSource = targetRuntime() === "workerd" ? d1("DB") : sqlite(opts.dbPath ?? processEnv().DB_PATH ?? ":memory:");

  // A job that runs after a note is created (e.g. indexing or notifications).
  const ranFor: string[] = [];
  const noteCreated = defineJob("note-created", {
    input: t.object({ noteId: t.string(), title: t.string() }),
    run: async ({ input, log }) => {
      ranFor.push(input.title);
      log.info("note created", { noteId: input.noteId });
    },
  });
  const jobs = queue({ jobs: [noteCreated], ...(targetRuntime() === "workerd" ? {} : { adapter: memoryQueue() }) });

  const listNotes = route.get("/notes", {
    summary: "List my notes, newest first",
    auth: "required",
    response: t.object({ notes: t.array(Note) }),
    handler: async ({ user, db, cache }) => {
      const notes = await cache.remember(listKey(user.id), 60, async () => {
        const { results } = await db.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").bind(user.id).all<NoteRow>();
        return results.map(toNote);
      });
      return { notes };
    },
  });

  const createNote = route.post("/notes", {
    summary: "Create a note",
    auth: "required",
    status: 201,
    body: t.object({ title: t.string({ minLength: 1, maxLength: 200 }), body: t.default(t.string({ maxLength: 10_000 }), "") }),
    response: Note,
    handler: async ({ user, body, db, cache, queue }) => {
      const row: NoteRow = { id: crypto.randomUUID(), title: body.title, body: body.body, created_at: new Date().toISOString() };
      await db.prepare("INSERT INTO notes (id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(row.id, user.id, row.title, row.body, row.created_at).run();
      await cache.delete(listKey(user.id));
      await queue.dispatch(noteCreated, { noteId: row.id, title: row.title });
      return toNote(row);
    },
  });

  const getNote = route.get("/notes/:id", {
    summary: "Get one of my notes",
    auth: "required",
    params: t.object({ id: t.string() }),
    response: Note,
    handler: async ({ user, params, db }) => {
      const row = await db.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?").bind(params.id, user.id).first<NoteRow>();
      if (!row) throw errors.notFound("note", params.id);
      return toNote(row);
    },
  });

  const deleteNote = route.delete("/notes/:id", {
    summary: "Delete one of my notes",
    auth: "required",
    params: t.object({ id: t.string() }),
    handler: async ({ user, params, db, cache }) => {
      const res = await db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(params.id, user.id).run();
      if (res.meta.changes === 0) throw errors.notFound("note", params.id);
      await cache.delete(listKey(user.id));
    },
  });

  const app = miu({
    name: "notes-api",
    version: "0.1.0",
    dev: opts.dev,
    mcp: { instructions: "A personal notes API. Sign in first (session cookie or Bearer API token from POST /auth/tokens)." },
    routes: [{ listNotes, createNote, getNote, deleteNote }],
    plugins: [
      db({ database: source, migrations }),
      session({ secret: opts.sessionSecret }),
      auth({ users: dbUserStore(source), password: opts.passwordIterations ? { algorithm: "pbkdf2", iterations: opts.passwordIterations } : undefined }),
      cache(),
      jobs,
    ],
  });

  return { app, jobs: { adapter: jobs.adapter as ReturnType<typeof memoryQueue>, ranFor } };
}

export default createApp().app;
