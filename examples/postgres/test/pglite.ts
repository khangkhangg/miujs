// A real Postgres for tests: PGlite (Postgres compiled to WASM) behind a TCP socket, so the app's
// real postgres.js driver connects to it over the wire protocol. Not a networked server (one
// backend, no TLS) and not Hyperdrive.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export async function startPostgres() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
  await server.start();
  return {
    url: `postgres://postgres:postgres@${server.getServerConn()}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
