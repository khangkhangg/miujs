import { expect, test } from "bun:test";
import { FakeClock, createRoomDurableObject, defineRoom, rooms, shardedRoom, t } from "../src/index.ts";

const base = defineRoom("arena", {
  state: t.object({ scores: t.record(t.number()), top: t.number(), title: t.string() }),
  client: { score: t.object({ n: t.number() }) },
  init: (ctx) => ({ scores: {}, top: 0, title: (ctx.data as { title?: string } | undefined)?.title ?? "" }),
  onJoin: ({ room, player }) => {
    if (player.role !== "spectator") room.state.scores[player.id] = 0;
  },
  on: {
    score: ({ room, sender, msg }) => {
      room.state.scores[sender.id] += msg.n;
    },
  },
});

/** The best score anywhere, published into every shard as `top`. */
const arena = shardedRoom(base, {
  shardSize: 2,
  aggregate: (shards) => Math.max(0, ...shards.flatMap((s) => Object.values(s.state.scores))),
  publish: ({ room, aggregate }) => {
    room.state.top = aggregate;
  },
});

class CfSocket {
  frames: any[] = [];
  closed: { code?: number } | null = null;
  private att: unknown = null;
  send(m: string) {
    this.frames.push(JSON.parse(m));
  }
  close(code?: number) {
    this.closed = { code };
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(t?: string) {
    for (let i = this.frames.length - 1; i >= 0; i--) if (!t || this.frames[i].t === t) return this.frames[i];
  }
}

/** A Durable Object namespace whose objects are real MiuRooms instances over fake storage. */
function world() {
  const Rooms = createRoomDurableObject([arena], { clock: new FakeClock(), webSocketPair: () => [new CfSocket(), new CfSocket()] as any });
  const objects = new Map<string, { obj: any; sockets: CfSocket[] }>();
  const env: Record<string, unknown> = {};
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (req: Request) => {
        let o = objects.get(name);
        if (!o) {
          const data = new Map<string, unknown>();
          const sockets: CfSocket[] = [];
          const state = {
            acceptWebSocket: (ws: CfSocket) => sockets.push(ws),
            getWebSockets: () => sockets.filter((s) => !s.closed),
            storage: {
              get: async (k: string) => structuredClone(data.get(k)),
              put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
              delete: async (k: string) => data.delete(k),
            },
          };
          objects.set(name, (o = { obj: new Rooms(state as any, env), sockets }));
        }
        return o.obj.fetch(req);
      },
    }),
  };
  env.MIU_ROOMS = ns;
  const plugin = rooms({ rooms: [arena] });
  const connect = plugin.routes.find((r) => r.path === "/rooms/:type/:id")!;
  const join = async (query: string) => {
    const req = new Request(`https://app.example/rooms/arena/BIG?${query}`, { headers: { upgrade: "websocket" } });
    const q = Object.fromEntries(new URLSearchParams(query));
    const res = (await connect.config.handler({ req, params: { type: "arena", id: "BIG" }, query: q, runtime: "workerd", env, log: console } as any)) as Response;
    expect(res.status).toBe(101);
    const shard = [...objects.entries()].find(([, o]) => o.sockets.length && o.sockets.at(-1)!.frames.length && !o.sockets.at(-1)!["claimed" as never]);
    const ws = shard![1].sockets.at(-1)!;
    (ws as any).claimed = true;
    return { ws, obj: shard![1].obj, name: shard![0] };
  };
  return { plugin, objects, env, join };
}

test("on Cloudflare joins are routed by the coordinator object type:id to shard objects type:id:shardN", async () => {
  const w = world();
  const a = await w.join("name=Ann");
  const b = await w.join("name=Bob");
  const c = await w.join("name=Cat");
  expect([a.name, b.name, c.name]).toEqual(["arena:BIG:shard0", "arena:BIG:shard0", "arena:BIG:shard1"]);
  expect(c.ws.last("welcome").room).toEqual({ type: "arena", id: "BIG:shard1" });
  expect(w.objects.has("arena:BIG")).toBe(true); // the coordinator
});

test("a resume token goes straight to its shard", async () => {
  const w = world();
  await w.join("name=Ann");
  await w.join("name=Bob");
  const c = await w.join("name=Cat");
  const token = c.ws.last("welcome").resumeToken;
  const again = await w.join(`resume=${token}`);
  expect(again.name).toBe("arena:BIG:shard1");
  expect(again.ws.last("welcome")).toMatchObject({ resumed: true, me: { name: "Cat" } });
});

test("shards report to the coordinator, which publishes the aggregate to every shard", async () => {
  const w = world();
  const a = await w.join("name=Ann");
  await w.join("name=Bob");
  const c = await w.join("name=Cat");
  await c.obj.webSocketMessage(c.ws, JSON.stringify({ t: "msg", type: "score", data: { n: 7 } }));
  expect(c.ws.last("patch")).toBeDefined();
  // Ann is in shard 0 and sees the best score from shard 1.

  expect(a.ws.frames.filter((f) => f.t === "patch").flatMap((f) => f.ops)).toContainEqual({ op: "replace", path: "/top", value: 7 });
});

test("createRoom data on a sharded type reaches each shard's init on Cloudflare", async () => {
  const w = world();
  await w.plugin.createRoom("arena", { data: { title: "Edge finals" }, env: w.env });
  // createRoom picked a random id; join that room.
  const id = [...w.objects.keys()][0].split(":")[1];
  const connect = w.plugin.routes.find((r) => r.path === "/rooms/:type/:id")!;
  const req = new Request(`https://app.example/rooms/arena/${id}?name=Ann`, { headers: { upgrade: "websocket" } });
  await connect.config.handler({ req, params: { type: "arena", id }, query: { name: "Ann" }, runtime: "workerd", env: w.env, log: console } as any);
  const shard = w.objects.get(`arena:${id}:shard0`)!;
  expect(shard.sockets[0].last("state").state.title).toBe("Edge finals");
});
