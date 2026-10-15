// Test helper: a real Postgres (PGlite, Postgres compiled to WASM) behind a TCP socket, so the
// real postgres.js network driver talks the real wire protocol to it. What this does NOT cover:
// a networked Postgres server (TLS, auth, many concurrent backends) and Cloudflare Hyperdrive.
//
// PGlite has one backend: the socket server serves one connection at a time and queues the rest,
// so long-lived pools in tests use `max: 1`.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export interface TestPostgres {
  /** postgres:// URL of the socket server. */
  url: string;
  /** Direct (in-process) access, for setup and assertions. */
  db: PGlite;
  /** Drops and recreates the public schema (all tables, incl. _miu_migrations). */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/** postgres.js options for tests: PGlite reports DEBUG notices that postgres.js would print. */
export const quiet = { onnotice: () => {} };

export async function startPostgres(): Promise<TestPostgres> {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
  await server.start();
  return {
    url: `postgres://postgres:postgres@${server.getServerConn()}/postgres`,
    db,
    async reset() {
      await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    },
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
