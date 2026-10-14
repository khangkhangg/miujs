import { afterEach, describe, expect, test } from "bun:test";
import { Miu, HttpError, t } from "../../src/index.ts";
import { listTools } from "../../src/ai/mcp.ts";
import { generateOpenAPI } from "../../src/ai/openapi.ts";
import { createRoomHub } from "../../src/realtime/index.ts";

type Server = { port: number; stop: (force?: boolean) => void };
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(app: Miu<any>): string {
  const s = app.listen(0);
  servers.push(s);
  return `ws://localhost:${s.port}`;
}

/** Connect and collect messages; resolves once open. */
function connect(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? ({ headers } as any) : undefined);
  const messages: string[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    messages.push(String(e.data));
    for (const w of waiters.splice(0)) w();
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  /** Wait until at least `n` messages have arrived. */
  const next = async (n = messages.length + 1): Promise<string[]> => {
    const deadline = Date.now() + 2000;
    while (messages.length < n) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${n} messages, got ${JSON.stringify(messages)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return messages;
  };
  return { ws, messages, opened, closed, next };
}

describe("app.ws on Bun", () => {
  test("open, message echo and close handlers run", async () => {
    const events: string[] = [];
    let closeInfo: unknown;
    const closedServer = Promise.withResolvers<void>();
    const app = new Miu({ logger: false }).ws("/echo", {
      open(ws) {
        events.push("open");
        ws.send("welcome");
      },
      message(ws, data) {
        events.push(`msg:${data}`);
        ws.json({ echo: data });
      },
      close(_ws, code, reason) {
        closeInfo = { code, reason };
        closedServer.resolve();
      },
    });
    const client = connect(`${serve(app)}/echo`);
    await client.opened;
    client.ws.send("hi");
    expect(await client.next(2)).toEqual(["welcome", JSON.stringify({ echo: "hi" })]);
    client.ws.close(4000, "bye");
    await closedServer.promise;
    expect(events).toEqual(["open", "msg:hi"]);
    expect(closeInfo).toEqual({ code: 4000, reason: "bye" });
  });

  test("socket has id, readyState and per-connection data from upgrade()", async () => {
    const app = new Miu({ logger: false }).ws(
      "/rooms/:room",
      {
        params: t.object({ room: t.string() }),
        query: t.object({ name: t.string() }),
        upgrade: (c) => ({ user: c.query.name, room: c.params.room, token: c.req.headers.get("x-token") }),
      },
      {
        open(ws) {
          ws.json({ data: ws.data, hasId: typeof ws.id === "string" && ws.id.length > 0, readyState: ws.readyState });
        },
      },
    );
    const client = connect(`${serve(app)}/rooms/lobby?name=ann`, { "x-token": "abc" });
    const [msg] = await client.next(1);
    expect(JSON.parse(msg!)).toEqual({ data: { user: "ann", room: "lobby", token: "abc" }, hasId: true, readyState: 1 });
    client.ws.close();
  });

  test("binary messages arrive as ArrayBuffer", async () => {
    const app = new Miu({ logger: false }).ws("/bin", {
      message(ws, data) {
        ws.json({ binary: data instanceof ArrayBuffer, bytes: data instanceof ArrayBuffer ? [...new Uint8Array(data)] : null });
      },
    });
    const client = connect(`${serve(app)}/bin`);
    await client.opened;
    client.ws.send(new Uint8Array([1, 2, 3]));
    const [msg] = await client.next(1);
    expect(JSON.parse(msg!)).toEqual({ binary: true, bytes: [1, 2, 3] });
    client.ws.close();
  });

  test("global middleware rejects before upgrade (401)", async () => {
    const seen: string[] = [];
    const app = new Miu({ logger: false })
      .use(async (c, next) => {
        seen.push(c.url.pathname);
        if (c.req.headers.get("authorization") !== "Bearer ok") throw new HttpError(401, "Login required");
        await next();
      })
      .ws("/secure", { open: (ws) => ws.send("in") });

    const res = await app.request("/secure", { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(res.status).toBe(401);

    const url = `${serve(app)}/secure`;
    const denied = connect(url);
    await expect(denied.opened).rejects.toThrow();
    const ok = connect(url, { authorization: "Bearer ok" });
    expect(await ok.next(1)).toEqual(["in"]);
    ok.ws.close();
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  test("route middleware and upgrade() can reject with a Response or HttpError", async () => {
    const app = new Miu({ logger: false })
      .ws("/mw", { use: [(c) => c.json({ nope: true }, 403)] }, { open: () => {} })
      .ws("/resp", { upgrade: () => new Response("busy", { status: 503 }) }, { open: () => {} })
      .ws("/throw", { upgrade: () => { throw new HttpError(401); } }, { open: () => {} });
    const h = { upgrade: "websocket", connection: "Upgrade" };
    expect((await app.request("/mw", { headers: h })).status).toBe(403);
    expect((await app.request("/resp", { headers: h })).status).toBe(503);
    expect((await app.request("/throw", { headers: h })).status).toBe(401);
  });

  test("query validation applies before upgrade (422)", async () => {
    const app = new Miu({ logger: false }).ws("/v", { query: t.object({ n: t.integer() }) }, { open: () => {} });
    const res = await app.request("/v?n=abc", { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(res.status).toBe(422);
  });

  test("plain GET to a WS path is 426 Upgrade Required", async () => {
    const app = new Miu({ logger: false }).ws("/live", { open: () => {} });
    const res = await app.request("/live");
    expect(res.status).toBe(426);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("upgrade")).toBe("websocket");
    expect(await res.json()).toMatchObject({ status: 426, title: "Upgrade Required" });
  });

  test("a GET route and a WS route can share a path", async () => {
    const app = new Miu({ logger: false }).get("/both", () => "page").ws("/both", { open: (ws) => ws.send("socket") });
    expect(await (await app.request("/both")).text()).toBe("page");
    const client = connect(`${serve(app)}/both`);
    expect(await client.next(1)).toEqual(["socket"]);
    client.ws.close();
  });

  test("pub/sub: publish reaches other subscribers but not the sender", async () => {
    const app = new Miu({ logger: false }).ws("/chat", {
      open(ws) {
        ws.subscribe("chat");
        ws.send("ready");
      },
      message(ws, data) {
        ws.publish("chat", String(data));
      },
    });
    const url = `${serve(app)}/chat`;
    const a = connect(url);
    const b = connect(url);
    await a.next(1);
    await b.next(1);
    a.ws.send("hello from a");
    expect(await b.next(2)).toEqual(["ready", "hello from a"]);
    await Bun.sleep(30);
    expect(a.messages).toEqual(["ready"]);
    a.ws.close();
    b.ws.close();
  });

  test("rooms: presence and broadcast through the hub, auto-leave on close", async () => {
    const hub = createRoomHub<{ name: string }>();
    const left = Promise.withResolvers<void>();
    const app = new Miu({ logger: false }).ws(
      "/room/:id",
      { upgrade: (c) => ({ name: String(c.query.name) }) },
      {
        open(ws) {
          const room = "r1";
          hub.join(room, ws, { name: ws.data.name });
          hub.broadcast(room, { type: "presence", members: hub.members(room).map((m) => m.meta.name) });
        },
        message(ws, data) {
          hub.broadcast("r1", { from: ws.data.name, text: String(data) }, { except: ws });
        },
        close() {
          if (hub.members("r1").length === 1) left.resolve();
        },
      },
    );
    const url = `${serve(app)}/room/r1`;
    const a = connect(`${url}?name=ann`);
    await a.next(1);
    const b = connect(`${url}?name=bob`);
    await b.next(1);
    await a.next(2);
    expect(JSON.parse(a.messages[1]!)).toEqual({ type: "presence", members: ["ann", "bob"] });
    b.ws.send("yo");
    expect(JSON.parse((await a.next(3))[2]!)).toEqual({ from: "bob", text: "yo" });
    b.ws.close();
    await left.promise;
    expect(hub.members("r1").map((m) => m.meta.name)).toEqual(["ann"]);
    a.ws.close();
  });

  test("handler errors go to error() and don't crash the server", async () => {
    const errors: string[] = [];
    const app = new Miu({ logger: false }).ws("/err", {
      message() {
        throw new Error("boom");
      },
      error(ws, err) {
        errors.push((err as Error).message);
        ws.send("recovered");
      },
    });
    const client = connect(`${serve(app)}/err`);
    await client.opened;
    client.ws.send("x");
    expect(await client.next(1)).toEqual(["recovered"]);
    expect(errors).toEqual(["boom"]);
    client.ws.close();
  });

  test("routes mounted with app.route() keep their WebSocket handlers", async () => {
    const sub = new Miu().ws("/feed", { open: (ws) => ws.send("feed") });
    const app = new Miu({ logger: false }).route("/api", sub);
    const client = connect(`${serve(app)}/api/feed`);
    expect(await client.next(1)).toEqual(["feed"]);
    client.ws.close();
  });

  test("app.websocket exposes Bun's handler for `export default app`", async () => {
    const app = new Miu({ logger: false }).ws("/x", { open: (ws) => ws.send("default-export") });
    expect(typeof app.websocket.open).toBe("function");
    expect(typeof app.websocket.message).toBe("function");
    expect(typeof app.websocket.close).toBe("function");
    // Simulate Bun's auto-serve of a default export.
    const s = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket } as any);
    servers.push(s as any);
    const client = connect(`ws://localhost:${s.port}/x`);
    expect(await client.next(1)).toEqual(["default-export"]);
    client.ws.close();
  });

  test("WS routes are not MCP tools nor OpenAPI operations", () => {
    const app = new Miu({ logger: false }).get("/items", () => []).ws("/live", { open: () => {} });
    expect(listTools(app).map((t) => t.name)).toEqual(["get_items"]);
    expect(Object.keys(generateOpenAPI(app).paths)).toEqual(["/items"]);
    expect(app.routes.find((r) => r.path === "/live")?.method).toBe("WS");
  });

  test("without Bun server or WebSocketPair (e.g. Node) upgrade returns 501", async () => {
    const app = new Miu({ logger: false }).ws("/n", { open: () => {} });
    const res = await app.request("/n", { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(res.status).toBe(501);
    expect((await res.json()).detail).toContain("ws adapter");
  });
});
