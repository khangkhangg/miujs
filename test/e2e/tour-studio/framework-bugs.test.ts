/**
 * Framework bugs and rough edges found while building and load-testing apps/tour-studio.
 *
 * Each case asserts the CORRECT behaviour and is marked `test.failing` because the framework does not do it yet,
 * so the suite stays green while documenting the bug. When a fix lands, the case starts "unexpectedly passing":
 * flip it to `test` (and keep it as a regression test).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miu, memoryBlobStore, memoryRepository, memoryStore, rateLimit, serveBlob, sessions, auth, login, type BlobStore, type Repository } from "../../../src/index.ts";
import { openDatabase } from "../../../src/sqlite.ts";
import { diskBlobStore } from "../../../src/adapters/node.ts";
import { admin } from "../../../src/admin/index.ts";
import { tourKit, type Hotspot, type Scene, type Tour } from "../../../src/tour/index.ts";
import { t } from "../../../src/core/schema.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "miu-bug-"));

describe("framework bugs (documented with failing tests)", () => {
  /**
   * BUG (crash): src/adapters/node-files.ts `diskBlobStore().get()` opens a FileHandle eagerly and only closes it
   * when the stream is read to the end or cancelled. If the Response is dropped unread — an in-process
   * `app.request()` caller, a middleware that replaces `c.res` after an error, a test reading only headers —
   * Bun closes the handle at GC and throws ERR_INVALID_STATE ("A FileHandle object was closed during garbage
   * collection"), which kills the process. Hit twice while writing this app's tests/bench.
   * Fix: open lazily in the stream's first `pull()` (and close in `cancel`), or register the handle with a
   * FinalizationRegistry that closes it quietly; better, return a Blob (`Bun.file(path).slice()` /
   * `fs.openAsBlob`) which also fixes the Content-Length bug below and lets the runtime use sendfile.
   */
  test("a diskBlobStore body that is never read does not crash the process at GC", async () => {
    const dir = tmp();
    const script = `
      import { diskBlobStore } from ${JSON.stringify(join(ROOT, "src/adapters/node.ts"))};
      const s = diskBlobStore({ root: ${JSON.stringify(dir)} });
      await s.put("a/b.png", new Uint8Array(1000));
      for (let i = 0; i < 5; i++) await s.get("a/b.png"); // dropped without reading
      Bun.gc(true); await Bun.sleep(50); Bun.gc(true); await Bun.sleep(50);
      console.log("alive");`;
    const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    await p.exited;
    rmSync(dir, { recursive: true, force: true });
    expect(err).not.toContain("ERR_INVALID_STATE");
    expect(out).toContain("alive");
    expect(p.exitCode).toBe(0);
  }, 20_000);

  /**
   * BUG (HTTP): serveBlob() sets Content-Length, but on Bun the response goes out chunked without it when the
   * body is diskBlobStore's pull-based stream (200 and 206). Clients lose download progress/size, and a 206
   * without Content-Length is unusual for media players. Node's adapter keeps the header.
   * Fix: as above — serve a Blob/BunFile slice (Bun keeps its size), or a byte stream with a known length.
   */
  test("panoramas served from diskBlobStore keep Content-Length on Bun (200 and 206)", async () => {
    const dir = tmp();
    const files = diskBlobStore({ root: dir });
    await files.put("p/x.png", new Uint8Array(5000), { contentType: "image/png" });
    const app = new Miu({ logger: false }).get("/f", (c) => serveBlob(c, files, "p/x.png"));
    const server = Bun.serve(app.serveOptions({ port: 0, hostname: "127.0.0.1" }));
    try {
      const full = await fetch(`http://127.0.0.1:${server.port}/f`);
      await full.arrayBuffer();
      const part = await fetch(`http://127.0.0.1:${server.port}/f`, { headers: { range: "bytes=0-99" } });
      await part.arrayBuffer();
      expect([full.headers.get("content-length"), part.headers.get("content-length")]).toEqual(["5000", "100"]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * PERF: serveBlob()'s fast path calls store.get() (opens the data file) even when If-None-Match is present,
   * then cancels the body for the 304. With diskBlobStore that is realpath + sidecar read + open + close per
   * revalidation (~465 µs per 304 in-process vs ~360 µs for the whole public tour bundle). R2 pays a GET.
   * Fix: when the request has If-None-Match (or If-Modified-Since), use store.head() first.
   */
  test("a conditional GET that ends in 304 never opens the blob body", async () => {
    const inner = memoryBlobStore();
    let gets = 0;
    const store: BlobStore = { ...inner, get: (k, o) => (gets++, inner.get(k, o)) };
    await store.put("a/b.png", new Uint8Array(10), { contentType: "image/png" });
    const app = new Miu({ logger: false }).get("/f", (c) => serveBlob(c, store, "a/b.png"));
    const etag = (await inner.head("a/b.png"))!.etag;
    const res = await app.request("/f", { headers: { "if-none-match": `"${etag}"` } });
    expect(res.status).toBe(304);
    expect(gets).toBe(0);
  });

  /**
   * SECURITY (secure by default): rateLimit()'s default key is clientIp(), which trusts X-Forwarded-For /
   * X-Real-IP / CF-Connecting-IP from anyone. Without a proxy, an attacker rotates the header to get a fresh
   * bucket per request (unlimited password guessing); honest clients without the header all share ONE
   * "anonymous" bucket, so a single client can lock everyone out of /login. The adapters never expose the
   * socket address (Miu's fetch strips Bun's `server` from `env`, so `server.requestIP(req)` is unreachable).
   * Fix: expose the peer address (`c.ip` from Bun's server.requestIP / Node's socket.remoteAddress) and only
   * honour forwarding headers with an explicit `trustProxy` option.
   */
  test.failing("the default rate-limit key cannot be reset by spoofing X-Forwarded-For", async () => {
    const app = new Miu({ logger: false })
      .use(rateLimit({ store: memoryStore(), limit: 2, window: 60 }))
      .post("/login", () => ({ ok: false }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await app.request("/login", { method: "POST", headers: { "x-forwarded-for": `203.0.113.${i}` } })).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  /**
   * CORRECTNESS (scale-out drivers): tourKit's uniqueSlug() (src/tour/kit.ts) is check-then-insert with no
   * uniqueness constraint in the Repository API. On SQLite it happens to be atomic (synchronous driver, no
   * await yields between check and insert), but with an async driver (D1, a remote DB — simulated here with
   * 1 ms latency) concurrent creates with the same slug both succeed, and `/t/<slug>` then serves an arbitrary
   * one of them. Same pattern for the app's unique emails.
   * Fix: a `unique` option on repositories (UNIQUE index in SQL drivers; create() throws a typed conflict
   * error) and have tourKit map it to 409 / retry with a suffix.
   */
  test.failing("concurrent tour creates with the same slug cannot both succeed on an async repository", async () => {
    const slow = <T extends { id: string }>(r: Repository<T>): Repository<T> => ({
      list: async (q) => (await Bun.sleep(1), r.list(q)),
      get: async (id) => (await Bun.sleep(1), r.get(id)),
      create: async (d) => (await Bun.sleep(1), r.create(d)),
      update: async (id, p) => (await Bun.sleep(1), r.update(id, p)),
      delete: async (id) => (await Bun.sleep(1), r.delete(id)),
    });
    const tours = slow(memoryRepository<Tour>());
    const kit = tourKit({ tours, scenes: memoryRepository<Scene>(), hotspots: memoryRepository<Hotspot>(), files: memoryBlobStore(), authorize: () => ({ id: "u1" }) });
    const app = new Miu({ logger: false }).route("/", kit);
    const create = () => app.request("/api/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Twin", slug: "twin" }) });
    const statuses = (await Promise.all([create(), create(), create()])).map((r) => r.status);
    const twins = (await tours.list({ where: { slug: "twin" } })).total;
    expect({ statuses: statuses.sort(), twins }).toEqual({ statuses: [201, 409, 409], twins: 1 });
  });

  /**
   * DEVTOOLS (principle 7): the admin UI page has no <link rel="icon">, so every visit logs
   * "Failed to load resource: 404 /favicon.ico" in the Console (unless the app happens to serve one).
   * The tour pages already use `<link rel="icon" href="data:,">`. Fix: same in src/admin/ui.ts renderPage().
   */
  test.failing("the admin page declares an icon (no favicon 404 in the DevTools console)", async () => {
    const app = new Miu({ logger: false })
      .use(sessions({ store: memoryStore(), secret: "s".repeat(32) }))
      .use(auth({ loadUser: async () => ({ id: "a", roles: ["admin"] }) }))
      .post("/login", async (c) => (await login(c, { id: "a" }), { ok: true }))
      .route("/admin", admin({ resources: { notes: { schema: t.object({ title: t.string() }), repo: memoryRepository<any>() } } }));
    const cookie = (await app.request("/login", { method: "POST" })).headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await app.request("/admin", { headers: { cookie, accept: "text/html" } })).text();
    expect(html).toMatch(/<link rel="icon"/);
  });

  /**
   * AUDIT noise: an admin PATCH that changes nothing (e.g. only read-only/unknown fields, which are silently
   * stripped) still bumps updatedAt and writes an audit entry with `changes: {}`.
   * Fix: skip the update + audit when the patch is empty or equal to the stored values (or 422 on read-only keys).
   */
  test.failing("an admin PATCH that changes nothing is not audited", async () => {
    const audit = memoryRepository<any>();
    const repo = memoryRepository<any>();
    const app = new Miu({ logger: false })
      .use(auth({ loadUser: async () => undefined, bearer: async () => ({ id: "a", roles: ["admin"] }) }))
      .route("/admin", admin({ audit, resources: { notes: { schema: t.object({ title: t.string(), locked: t.optional(t.string()) }), repo, fields: { locked: { readOnly: true } } } } }));
    const note = await repo.create({ title: "x" });
    const res = await app.request(`/admin/api/notes/${note.id}`, { method: "PATCH", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ locked: "y" }) });
    expect(res.status).toBe(200);
    expect((await audit.list()).total).toBe(0);
  });

  /**
   * PERF default: openDatabase() turns on WAL but leaves synchronous=FULL, i.e. an fsync on every commit while
   * the (synchronous) driver blocks the event loop. Measured here: ~336 µs per small write with FULL vs ~83 µs
   * with NORMAL — the standard pairing with WAL (durable across process crashes; only an OS crash/power loss
   * can drop the last commits). Fix: `PRAGMA synchronous = NORMAL` by default in src/batteries/sqlite.ts, with
   * an option to keep FULL.
   */
  test.failing("openDatabase() pairs WAL with synchronous=NORMAL", async () => {
    const dir = tmp();
    const db = await openDatabase(join(dir, "x.sqlite"));
    const row = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    db.close();
    rmSync(dir, { recursive: true, force: true });
    expect(row.synchronous).toBe(1);
  });
});
