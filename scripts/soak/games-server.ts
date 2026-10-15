// Game-stack soak server (Bun): the quiz room from examples/quiz plus a bench "action" room (a
// real-time arena: every player streams positions, everyone gets the patches), served the way
// app.listen() does on Bun, with debug-only routes the app never sees:
//
//   POST /__soak/room?type=quiz|action|actionview   create a room → { id, hostKey }
//   GET  /__soak/mem[?gc=1][&types=1]                RSS, JSC heap, objects, rooms, CPU time
//   GET  /__soak/stop                                server.stop(), then app.close(); the process should exit
//
// `x-soak-ip` sets the client IP the app sees (per-IP limits), on HTTP and WebSocket upgrades.
//
//   bun scripts/soak/games-server.ts [port]       → prints `READY <port>`

import { heapStats } from "bun:jsc";
import { miu, t } from "../../packages/miujs/src/index.ts";
import { defineRoom, rooms } from "../../packages/realtime/src/index.ts";
import { quiz } from "../../examples/quiz/room.ts";

const port = Number(process.argv[2] ?? 0);

const pos = t.object({ x: t.number(), y: t.number() });
const actionDef = {
  state: t.object({ pos: t.record(pos), moves: t.integer() }),
  client: { move: t.object({ x: t.number(), y: t.number() }) },
  init: () => ({ pos: {}, moves: 0 }),
  // A 60 Hz client sends 60 inputs/s; leave headroom for bursts.
  rateLimit: { perSecond: Number(process.env.SOAK_RATE ?? 120), burst: 2 * Number(process.env.SOAK_RATE ?? 120) },
  createOnJoin: false,
  // SOAK_BATCH=16: one patch per 16 ms window (a 60 Hz server tick) instead of one per move.
  patchBatchMs: Number(process.env.SOAK_BATCH ?? 0),
  onJoin: ({ room, player }: any) => {
    room.state.pos[player.id] = { x: 0, y: 0 };
  },
  onLeave: ({ room, player }: any) => {
    delete room.state.pos[player.id];
  },
  on: {
    move: ({ room, sender, msg }: any) => {
      room.state.pos[sender.id] = { x: msg.x, y: msg.y };
      room.state.moves++;
    },
  },
};
/** Everyone sees everything: one patch per move, encoded once, sent to every member. */
const action = defineRoom("action", actionDef as any);
/** Interest management: each player sees only itself and the move counter (a view per player). */
const actionView = defineRoom("actionview", {
  ...(actionDef as any),
  view: (s: any, p: any) => ({ me: s.pos[p.id] ?? null, moves: s.moves }),
});

const realtime = rooms({ rooms: [quiz, action, actionView], maxConnectionsPerIp: 100_000 });
const app = miu({ name: "games-soak", plugins: [realtime], logLevel: "silent" });
await app.ready();

let server: ReturnType<typeof Bun.serve>;
const shim = {
  upgrade: (req: Request, opts: { data: unknown }) => server.upgrade(req, opts),
  requestIP: (req: Request) => {
    const fake = req.headers.get("x-soak-ip");
    return fake ? { address: fake, family: "IPv4", port: 0 } : server.requestIP(req);
  },
};

function mem(url: URL) {
  if (url.searchParams.has("gc")) {
    Bun.gc(true);
    Bun.gc(true);
  }
  const h = heapStats();
  const list = realtime.registry.list();
  const cpu = process.cpuUsage();
  const out: Record<string, unknown> = {
    rss: process.memoryUsage().rss,
    heap: h.heapSize,
    objects: h.objectCount,
    cpuMs: (cpu.user + cpu.system) / 1000,
    rooms: list.length,
    players: list.reduce((a, r) => a + r.players, 0),
    connected: list.reduce((a, r) => a + r.connected, 0),
    sockets: [...realtime.registry.instances()].reduce((a, r) => a + r.connections, 0),
  };
  if (url.searchParams.has("types")) out.types = h.objectTypeCounts;
  return Response.json(out);
}

server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  websocket: app.websocket as never,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__soak/mem") return mem(url);
    if (url.pathname === "/__soak/room") {
      const made = await realtime.createRoom(url.searchParams.get("type") ?? "action", { code: false });
      return Response.json(made);
    }
    if (url.pathname === "/__soak/stop") {
      setTimeout(async () => {
        await server.stop(true);
        await app.close();
      }, 5);
      return new Response("stopping");
    }
    return app.fetch(req, shim as never);
  },
});
console.log(`READY ${server.port}`);
