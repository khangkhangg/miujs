import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Miu } from "../../src/index.ts";

/** Minimal stand-in for Cloudflare's WebSocket (server side of a pair). */
class FakeWS {
  accepted = false;
  readyState = 1;
  sent: unknown[] = [];
  closed?: { code?: number; reason?: string };
  peer?: FakeWS;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  accept() {
    this.accepted = true;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  emit(type: string, e: any) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
}

const pairs: { client: FakeWS; server: FakeWS }[] = [];
class FakeWebSocketPair {
  0: FakeWS;
  1: FakeWS;
  constructor() {
    this[0] = new FakeWS();
    this[1] = new FakeWS();
    pairs.push({ client: this[0], server: this[1] });
  }
}

const H = { upgrade: "websocket", connection: "Upgrade" };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("app.ws on Cloudflare Workers (WebSocketPair)", () => {
  beforeEach(() => {
    (globalThis as any).WebSocketPair = FakeWebSocketPair;
    pairs.length = 0;
  });
  afterEach(() => {
    delete (globalThis as any).WebSocketPair;
  });

  test("returns 101, accepts the server socket and wires handlers", async () => {
    const events: unknown[] = [];
    const app = new Miu({ logger: false }).ws(
      "/ws",
      { upgrade: (c) => ({ user: c.query.user }) },
      {
        open(ws) {
          events.push(["open", ws.data]);
          ws.send("hi");
        },
        message(ws, data) {
          events.push(["message", data]);
          ws.json({ echo: data });
        },
        close(_ws, code, reason) {
          events.push(["close", code, reason]);
        },
        error(_ws, err) {
          events.push(["error", String(err)]);
        },
      },
    );
    const res = await app.request("/ws?user=ann", { headers: H }, { SOME: "binding" });
    expect(res.status).toBe(101);
    const { server } = pairs[0]!;
    expect(server.accepted).toBe(true);
    await tick();
    expect(server.sent).toEqual(["hi"]);
    server.emit("message", { data: "ping" });
    await tick();
    expect(server.sent[1]).toBe(JSON.stringify({ echo: "ping" }));
    server.emit("error", { error: new Error("bad") });
    server.emit("close", { code: 1000, reason: "done" });
    await tick();
    expect(events).toEqual([
      ["open", { user: "ann" }],
      ["message", "ping"],
      ["error", "Error: bad"],
      ["close", 1000, "done"],
    ]);
  });

  test("in-process pub/sub delivers to other subscribers only and cleans up on close", async () => {
    const app = new Miu({ logger: false }).ws("/chat", {
      open: (ws) => ws.subscribe("room"),
      message: (ws, data) => ws.publish("room", String(data)),
    });
    await app.request("/chat", { headers: H });
    await app.request("/chat", { headers: H });
    await app.request("/chat", { headers: H });
    const [a, b, c] = pairs.map((p) => p.server);
    await tick();
    a!.emit("message", { data: "hello" });
    await tick();
    expect(a!.sent).toEqual([]);
    expect(b!.sent).toEqual(["hello"]);
    expect(c!.sent).toEqual(["hello"]);
    c!.emit("close", { code: 1000, reason: "" });
    await tick();
    b!.emit("message", { data: "again" });
    await tick();
    expect(a!.sent).toEqual(["again"]);
    expect(c!.sent).toEqual(["hello"]);
  });

  test("close() and readyState go to the underlying socket", async () => {
    const app = new Miu({ logger: false }).ws("/c", { open: (ws) => ws.close(4001, `state:${ws.readyState}`) });
    await app.request("/c", { headers: H });
    await tick();
    expect(pairs[0]!.server.closed).toEqual({ code: 4001, reason: "state:1" });
  });

  test("a function handler forwards the upgrade (e.g. to a Durable Object)", async () => {
    const app = new Miu({ logger: false }).ws("/fw/:id", (c) => new Response(`forwarded ${c.params.id}`, { status: 200 }));
    expect(await (await app.request("/fw/7", { headers: H })).text()).toBe("forwarded 7");
    expect((await app.request("/fw/7")).status).toBe(426);
  });
});
