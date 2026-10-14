// Spawned by test/realtime/ws-node.test.ts under `node --experimental-strip-types`.
// Prints {"port": n} once listening; GET /log returns server-side events.
import { Miu, HttpError, t } from "../../../src/index.ts";
import { createRoomHub } from "../../../src/realtime/index.ts";
import { serve } from "../../../src/adapters/node.ts";

const log: unknown[] = [];
const hub = createRoomHub<{ name: string }>();

const app = new Miu({ logger: false })
  .use("/secure", async (c, next) => {
    if (c.req.headers.get("authorization") !== "Bearer ok") throw new HttpError(401, "Login required");
    c.header("x-auth", "yes");
    await next();
  })
  .get("/log", () => log)
  .get("/runtime", () => ({ node: typeof (globalThis as { Bun?: unknown }).Bun === "undefined" }))
  .post("/publish/:topic", async (c) => {
    app.publish(String(c.params.topic), await c.req.text());
    return { ok: true };
  })
  .ws("/echo", {
    open(ws) {
      log.push(["open", ws.readyState]);
      ws.send("welcome");
    },
    message(ws, data) {
      ws.json({ echo: data });
    },
    close(_ws, code, reason) {
      log.push(["close", code, reason]);
    },
  })
  .ws(
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
  )
  .ws("/bin", {
    message(ws, data) {
      ws.json({ binary: data instanceof ArrayBuffer, bytes: data instanceof ArrayBuffer ? [...new Uint8Array(data)] : null });
      if (data instanceof ArrayBuffer) ws.send(new Uint8Array(data).reverse());
    },
  })
  .ws("/secure", { open: (ws) => ws.send("in") })
  .ws("/reject", { upgrade: () => new Response("busy", { status: 503 }) }, { open: () => {} })
  .ws("/v", { query: t.object({ n: t.integer() }) }, { open: (ws) => ws.send("valid") })
  .ws("/chat", {
    open(ws) {
      ws.subscribe("chat");
      ws.send("ready");
    },
    message(ws, data) {
      if (data === "leave") return ws.unsubscribe("chat");
      ws.publish("chat", String(data));
    },
  })
  .ws("/news", {
    open(ws) {
      ws.subscribe("news");
      ws.send("subscribed");
    },
  })
  .ws(
    "/room/:id",
    { upgrade: (c) => ({ name: String(c.query.name) }) },
    {
      open(ws) {
        hub.join("r1", ws, { name: ws.data.name });
        hub.broadcast("r1", { type: "presence", members: hub.members("r1").map((m) => m.meta.name) });
      },
      message(ws, data) {
        hub.broadcast("r1", { from: ws.data.name, text: String(data) }, { except: ws });
      },
      close() {
        log.push(["room-left", hub.members("r1").map((m) => m.meta.name)]);
      },
    },
  )
  .ws("/err", {
    message() {
      throw new Error("boom");
    },
    error(ws, err) {
      log.push(["error", (err as Error).message]);
      ws.send("recovered");
    },
  })
  .ws("/bye", {
    open(ws) {
      ws.close(4001, "server says bye");
    },
    close(_ws, code, reason) {
      log.push(["bye-closed", code, reason]);
    },
  });

const server = await serve(app, { port: 0, hostname: "127.0.0.1", ws: { maxPayload: 64 * 1024, idleTimeout: 2 } });
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
