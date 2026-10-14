import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Miu } from "../../src/index.ts";
import { MiuRoom, roomRoute } from "../../src/realtime/durable-room.ts";
import type { CfWebSocket, DurableObjectNamespace, DurableObjectState } from "../../src/realtime/cf-types.ts";

class FakeWS implements CfWebSocket {
  sent: unknown[] = [];
  closed?: { code?: number; reason?: string };
  attachment: unknown;
  accept() {}
  addEventListener() {}
  send(d: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

class FakePair {
  0 = new FakeWS();
  1 = new FakeWS();
}

function fakeState() {
  const sockets: { ws: CfWebSocket; tags: string[] }[] = [];
  const state: DurableObjectState & { sockets: typeof sockets } = {
    sockets,
    acceptWebSocket(ws, tags = []) {
      sockets.push({ ws, tags });
    },
    getWebSockets(tag?: string) {
      return sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws);
    },
    getTags(ws) {
      return sockets.find((s) => s.ws === ws)?.tags ?? [];
    },
  };
  return state;
}

const H = { upgrade: "websocket", connection: "Upgrade" };

class QuizRoom extends MiuRoom<{ name: string }> {
  log: unknown[] = [];
  override onConnect(req: Request) {
    const name = new URL(req.url).searchParams.get("name");
    if (!name) return new Response("name required", { status: 400 });
    return { data: { name }, tags: [name === "host" ? "host" : "player"] };
  }
  override onOpen(ws: CfWebSocket) {
    this.broadcast({ type: "joined", name: this.dataOf(ws)?.name, count: this.sockets().length });
  }
  override onMessage(ws: CfWebSocket, msg: string | ArrayBuffer) {
    this.log.push(["msg", this.dataOf(ws)?.name, msg]);
    this.broadcast(String(msg), { except: ws });
  }
  override onClose(ws: CfWebSocket, code: number) {
    this.log.push(["close", this.dataOf(ws)?.name, code]);
  }
}

describe("MiuRoom (Durable Object, hibernation API)", () => {
  beforeEach(() => {
    (globalThis as any).WebSocketPair = FakePair;
  });
  afterEach(() => {
    delete (globalThis as any).WebSocketPair;
  });

  test("accepts upgrades via state.acceptWebSocket with tags and attachment", async () => {
    const state = fakeState();
    const room = new QuizRoom(state, {});
    const res = await room.fetch(new Request("http://do/room?name=host", { headers: H }));
    expect(res.status).toBe(101);
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]!.tags).toEqual(["host"]);
    expect(room.dataOf(state.sockets[0]!.ws)).toEqual({ name: "host" });
    expect((state.sockets[0]!.ws as FakeWS).sent).toEqual([JSON.stringify({ type: "joined", name: "host", count: 1 })]);
  });

  test("onConnect can reject; plain requests get 426", async () => {
    const room = new QuizRoom(fakeState(), {});
    expect((await room.fetch(new Request("http://do/room", { headers: H }))).status).toBe(400);
    expect((await room.fetch(new Request("http://do/room?name=a"))).status).toBe(426);
  });

  test("webSocketMessage/webSocketClose dispatch to hooks; broadcast skips sender, filters by tag", async () => {
    const state = fakeState();
    const room = new QuizRoom(state, {});
    await room.fetch(new Request("http://do/r?name=host", { headers: H }));
    await room.fetch(new Request("http://do/r?name=ann", { headers: H }));
    await room.fetch(new Request("http://do/r?name=bob", { headers: H }));
    const [host, ann, bob] = state.sockets.map((s) => s.ws as FakeWS);
    for (const s of [host!, ann!, bob!]) s.sent.length = 0;

    await room.webSocketMessage(ann!, "hello");
    expect(ann!.sent).toEqual([]);
    expect(host!.sent).toEqual(["hello"]);
    expect(bob!.sent).toEqual(["hello"]);

    expect(room.broadcast("players only", { tag: "player" })).toBe(2);
    expect(host!.sent).toEqual(["hello"]);

    expect(room.members().map((m) => m.data?.name)).toEqual(["host", "ann", "bob"]);

    await room.webSocketClose(bob!, 1001, "away", true);
    expect(bob!.closed).toEqual({ code: 1001, reason: "away" });
    expect(room.log).toEqual([
      ["msg", "ann", "hello"],
      ["close", "bob", 1001],
    ]);
  });

  test("handlers object configures a room without subclassing", async () => {
    const seen: unknown[] = [];
    class Echo extends MiuRoom {
      override handlers = {
        message: (ws: CfWebSocket, msg: string | ArrayBuffer) => {
          seen.push(msg);
          ws.send(`echo:${msg}`);
        },
      };
    }
    const state = fakeState();
    const room = new Echo(state, {});
    await room.fetch(new Request("http://do/x", { headers: H }));
    const ws = state.sockets[0]!.ws as FakeWS;
    await room.webSocketMessage(ws, "hi");
    expect(ws.sent).toEqual(["echo:hi"]);
    expect(seen).toEqual(["hi"]);
  });

  test("hook errors go to onError and don't throw out of the DO", async () => {
    const errors: string[] = [];
    class Boom extends MiuRoom {
      override onMessage(): void {
        throw new Error("boom");
      }
      override onError(_ws: CfWebSocket, err: unknown) {
        errors.push((err as Error).message);
      }
    }
    const state = fakeState();
    const room = new Boom(state, {});
    await room.fetch(new Request("http://do/x", { headers: H }));
    await room.webSocketMessage(state.sockets[0]!.ws, "x");
    await room.webSocketError(state.sockets[0]!.ws, new Error("net"));
    expect(errors).toEqual(["boom", "net"]);
  });
});

describe("roomRoute", () => {
  function fakeNamespace() {
    const calls: { name: string; url: string }[] = [];
    const ns: DurableObjectNamespace = {
      idFromName: (name) => ({ toString: () => `id:${name}` }),
      get: (id) => ({
        fetch: async (req) => {
          calls.push({ name: id.toString(), url: req.url });
          return new Response(`room ${id}`, { status: 200 });
        },
      }),
    };
    return { ns, calls };
  }

  test("forwards upgrades to the named Durable Object after middleware", async () => {
    const { ns, calls } = fakeNamespace();
    const app = new Miu<{ Bindings: { ROOMS: DurableObjectNamespace } }>({ logger: false })
      .use(async (c, next) => {
        if (c.req.headers.get("x-key") !== "ok") return c.json({ error: "no" }, 401);
        await next();
      })
      .ws("/quiz/:id", roomRoute((c) => c.env.ROOMS, (c) => `quiz-${c.params.id}`));
    const env = { ROOMS: ns };
    expect((await app.request("/quiz/42", { headers: H }, env)).status).toBe(401);
    const res = await app.request("/quiz/42?name=ann", { headers: { ...H, "x-key": "ok" } }, env);
    expect(await res.text()).toBe("room id:quiz-42");
    expect(calls).toEqual([{ name: "id:quiz-42", url: "http://localhost/quiz/42?name=ann" }]);
    expect((await app.request("/quiz/42", { headers: { "x-key": "ok" } }, env)).status).toBe(426);
  });

  test("accepts a namespace object directly", async () => {
    const { ns } = fakeNamespace();
    const handler = roomRoute(ns, () => "lobby");
    const app = new Miu({ logger: false }).ws("/lobby", handler);
    expect(await (await app.request("/lobby", { headers: H })).text()).toBe("room id:lobby");
  });
});
