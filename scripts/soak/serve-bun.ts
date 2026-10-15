// Soak wrapper entry (Bun): loads one example app unchanged, serves it the way `app.listen()`
// does on Bun (Bun.serve + app.fetch + app.websocket), and adds debug-only routes that never
// reach the app:
//
//   GET /__soak/mem[?gc=1][&types=1]   RSS, JSC heap, object counts, in-flight requests, rooms
//   GET /__soak/stop                   graceful shutdown: server.stop(), app.close(), then nothing
//                                      (the process should exit by itself)
//
// One test-only shim: `x-soak-ip` sets the client IP the app sees (Bun's server.requestIP), so
// the load generator can act as many clients without tripping per-IP sign-in limits. Without the
// header the real socket address is used.
//
//   bun scripts/soak/serve-bun.ts <api|quiz|crm|arena|core> [port]
// Prints `READY <port> <ms since process start>` when listening.

import { heapStats } from "bun:jsc";
import { join } from "node:path";

const which = process.argv[2] ?? "core";
const port = Number(process.argv[3] ?? 0);
const root = join(import.meta.dir, "..", "..");
const t0 = performance.now();

type AnyApp = {
  fetch: (req: Request, server?: unknown) => Response | Promise<Response> | undefined;
  websocket: unknown;
  maxRequestBodySize: number;
  ready(): Promise<void>;
  drain(): Promise<void>;
  stop?(): Promise<void>;
  plugins: { name: string; registry?: { list(): { players: number; connected: number }[]; closeAll(): void } }[];
};

let app: AnyApp;
const extra: Record<string, () => unknown> = {};

if (which === "api") {
  const mod = await import(join(root, "examples/api/app.ts"));
  // The example's own factory with production defaults (real PBKDF2 cost, in-memory SQLite).
  const made = mod.createApp({ sessionSecret: "soak-secret-that-is-long-enough-0123456789abcdef" });
  app = made.app;
  extra.jobsRan = () => made.jobs.ranFor.length;
  // The example's job appends every note title to `ranFor` (a demo/test hook) forever.
  // SOAK_TRIM_RANFOR=1 empties it every second, to separate that from framework retention.
  if (process.env.SOAK_TRIM_RANFOR) setInterval(() => (made.jobs.ranFor.length = 0), 1000).unref();
} else if (which === "crm") {
  const mod = await import(join(root, "examples/crm/app.ts"));
  const { seed } = await import(join(root, "examples/crm/seed.ts"));
  const made = mod.createApp({ sessionSecret: "soak-secret-that-is-long-enough-0123456789abcdef" });
  app = made.app;
  // The example's own seed (password from seed.ts's default). SOAK_NO_SEED=1 skips it, for
  // cold-start timing of the bare app.
  if (!process.env.SOAK_NO_SEED) {
    const out = await seed(app, made.database, { password: "correct horse battery" });
    extra.orgId = () => out.org.id;
  }
} else if (which === "quiz") {
  app = (await import(join(root, "examples/quiz/app.ts"))).default;
} else if (which === "arena") {
  app = (await import(join(root, "packages/game/examples/arena/app.ts"))).default;
} else if (which === "core") {
  app = (await import(join(import.meta.dir, "core-app.ts"))).createCoreApp();
} else {
  throw new Error(`unknown app ${which}`);
}

await app.ready();

let inflight = 0;
let maxInflight = 0;
let served = 0;
const done = () => {
  inflight--;
};

function rooms() {
  const reg = app.plugins.find((p) => p.name === "rooms")?.registry;
  if (!reg) return null;
  const list = reg.list();
  return { rooms: list.length, players: list.reduce((a, r) => a + r.players, 0), connected: list.reduce((a, r) => a + r.connected, 0) };
}

function mem(url: URL) {
  if (url.searchParams.has("gc")) {
    Bun.gc(true);
    Bun.gc(true);
  }
  const h = heapStats();
  const m = process.memoryUsage();
  const out: Record<string, unknown> = {
    rss: m.rss,
    heap: h.heapSize,
    heapCapacity: h.heapCapacity,
    extraMemory: h.extraMemorySize,
    objects: h.objectCount,
    inflight,
    maxInflight,
    served,
    rooms: rooms(),
  };
  for (const [k, f] of Object.entries(extra)) out[k] = f();
  if (url.searchParams.has("types")) out.types = h.objectTypeCounts;
  return Response.json(out);
}

let server: ReturnType<typeof Bun.serve>;
// The app sees this object as Bun's server: upgrade() is Bun's, requestIP() honours x-soak-ip.
const shim = {
  upgrade: (req: Request, opts: { data: unknown }) => server.upgrade(req, opts),
  requestIP: (req: Request) => {
    const fake = req.headers.get("x-soak-ip");
    return fake ? { address: fake, family: "IPv4", port: 0 } : server.requestIP(req);
  },
};

server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  maxRequestBodySize: app.maxRequestBodySize,
  websocket: app.websocket as never,
  idleTimeout: 60,
  fetch(req) {
    const path = req.url.slice(req.url.indexOf("/", 8));
    if (path.startsWith("/__soak/")) {
      const url = new URL(req.url);
      if (url.pathname === "/__soak/mem") return mem(url);
      if (url.pathname === "/__soak/stop") {
        setTimeout(async () => {
          const t = performance.now();
          await server.stop(true);
          // app.close() (drain + plugins' stop hooks) where the framework has it, else drain only.
          await (app.close ? app.close() : app.drain());
          console.error(`STOPPED ${Math.round(performance.now() - t)}`);
        }, 5);
        return new Response("stopping");
      }
      return new Response("unknown soak route", { status: 404 });
    }
    served++;
    inflight++;
    if (inflight > maxInflight) maxInflight = inflight;
    let res: Response | Promise<Response> | undefined;
    try {
      res = app.fetch(req, shim);
    } catch (e) {
      done();
      throw e;
    }
    if (res instanceof Promise) return res.finally(done) as Promise<Response>;
    done();
    return res as Response;
  },
});

console.log(`READY ${server.port} ${Math.round(performance.now() - t0)}`);
