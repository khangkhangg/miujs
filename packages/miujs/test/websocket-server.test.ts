// WebSockets over a real Bun.serve: what a connection keeps alive, and the server's limits.
import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { miu, route, type WebSocketHandlers } from "../src/index.ts";

const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function serve(handlers: WebSocketHandlers, onCtx?: (ctx: object) => void, opts: Parameters<typeof miu>[0] = {}) {
  const app = miu({
    logLevel: "silent",
    ...opts,
    routes: [
      route.get("/ws", {
        handler: (ctx) => {
          onCtx?.(ctx);
          return ctx.upgrade(handlers);
        },
      }),
    ],
  });
  const server = await app.listen(0, "127.0.0.1");
  servers.push(server);
  return { app, url: `ws://127.0.0.1:${server.port}/ws` };
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as any);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

const closed = (ws: WebSocket) => new Promise<{ code: number }>((resolve) => (ws.onclose = (e) => resolve({ code: e.code })));

async function collect() {
  for (let i = 0; i < 5; i++) {
    Bun.gc(true);
    await Bun.sleep(5);
  }
}

describe("an open socket does not keep its request context alive", () => {
  test("the RequestContext (Request, cookies, Authorization) is collectable while the socket stays open", async () => {
    const refs: WeakRef<object>[] = [];
    // Handlers defined outside the route handler: nothing of ours references ctx.
    const handlers: WebSocketHandlers = { message: (s, m) => s.send(m) };
    const { url } = await serve(handlers, (ctx) => refs.push(new WeakRef(ctx)));
    const ws = await open(url, { cookie: "sid=secret", authorization: "Bearer secret" });
    const echoed = new Promise((r) => (ws.onmessage = (e) => r(e.data)));
    ws.send("hi");
    expect(await echoed).toBe("hi");
    expect(refs).toHaveLength(1);
    await collect();
    expect(refs[0].deref()).toBeUndefined();
    ws.close();
  });
});

// ---- payload and backpressure limits -------------------------------------------------------------

/** A raw WebSocket client over TCP: the handshake by hand, then whatever bytes a test writes. */
async function rawSocket(port: number): Promise<{ sock: Socket; closed: Promise<void> }> {
  const sock = connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  const closed = new Promise<void>((r) => sock.once("close", () => r()));
  sock.on("data", (d: Buffer) => (buf = Buffer.concat([buf, d])));
  sock.on("error", () => {});
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(
    "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  while (!buf.includes("\r\n\r\n")) await Bun.sleep(5);
  expect(buf.toString("latin1")).toStartWith("HTTP/1.1 101");
  buf = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
  return { sock, closed };
}

describe("WebSocket limits on Bun", () => {
  test("defaults: 1 MiB payloads, 1 MiB backpressure, slow readers are closed", () => {
    const ws = miu({ logLevel: "silent" }).websocket as any;
    expect(ws.maxPayloadLength).toBe(1024 * 1024);
    expect(ws.backpressureLimit).toBe(1024 * 1024);
    expect(ws.closeOnBackpressureLimit).toBe(true);
    const custom = miu({ logLevel: "silent", websocket: { maxPayloadLength: 4096, backpressureLimit: 8192 } }).websocket as any;
    expect(custom.maxPayloadLength).toBe(4096);
    expect(custom.backpressureLimit).toBe(8192);
    expect(custom.closeOnBackpressureLimit).toBe(true);
  });

  test("invalid limits are a config error", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "1mb"]) {
      expect(() => miu({ websocket: { maxPayloadLength: bad as any } })).toThrow(/MIU_E_WS_LIMIT_INVALID|maxPayloadLength/);
      expect(() => miu({ websocket: { backpressureLimit: bad as any } })).toThrow(/backpressureLimit/);
    }
  });

  test("an oversized frame closes the socket and never reaches the handler", async () => {
    const got: number[] = [];
    const closes: [number, string][] = [];
    const { url } = await serve({ message: (_s, m) => void got.push(m.length), close: (_s, code, reason) => void closes.push([code, reason]) }, undefined, { websocket: { maxPayloadLength: 1024 } });
    const ws = await open(url);
    const done = closed(ws);
    ws.send("x".repeat(1000)); // under the limit: delivered
    ws.send("x".repeat(4096));
    // Bun drops the connection without a close frame: 1006 on both ends ("Received too big message").
    expect((await done).code).toBe(1006);
    await Bun.sleep(10);
    expect(got).toEqual([1000]);
    expect(closes).toEqual([[1006, "Received too big message"]]);
  });

  test("a frame header announcing 100 MiB is refused at once (the payload is never buffered)", async () => {
    const got: unknown[] = [];
    const { url } = await serve({ message: (_s, m) => void got.push(m) }, undefined, { websocket: { maxPayloadLength: 1024 } });
    const raw = await rawSocket(Number(new URL(url).port));
    const header = Buffer.alloc(14);
    header[0] = 0x82; // FIN + binary
    header[1] = 0x80 | 127; // masked, 64-bit length
    header.writeBigUInt64BE(100n * 1024n * 1024n, 2);
    raw.sock.write(header); // ...and not one byte of payload
    const t0 = performance.now();
    await raw.closed;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(got).toEqual([]);
  });

  test("a client that stops reading is closed (1013) once the server buffers more than backpressureLimit", async () => {
    let closedCode: number | undefined;
    let sent = 0;
    const chunk = "y".repeat(64 * 1024);
    const { url } = await serve(
      {
        open(s) {
          const timer = setInterval(() => {
            if (closedCode !== undefined) return clearInterval(timer);
            for (let i = 0; i < 16 && closedCode === undefined; i++) {
              s.send(chunk);
              sent += chunk.length;
            }
          }, 1);
        },
        close(_s, code) {
          closedCode = code;
        },
      },
      undefined,
      { websocket: { backpressureLimit: 256 * 1024 } },
    );
    const raw = await rawSocket(Number(new URL(url).port));
    raw.sock.pause(); // stop reading: the kernel buffers fill, then Bun's
    const deadline = Date.now() + 10_000;
    while (closedCode === undefined && Date.now() < deadline) await Bun.sleep(10);
    expect(closedCode).toBe(1013);
    // Bounded: kernel socket buffers plus the backpressure limit, not everything we tried to send.
    expect(sent).toBeLessThan(64 * 1024 * 1024);
    await raw.closed;
  }, 20_000);
});

describe("WebSocket limits on Deno and Workers (checked per message)", () => {
  test("a message over maxPayloadLength closes the socket with 1009 and never reaches the handler", async () => {
    const g = globalThis as { Deno?: unknown };
    const sock = new EventTarget() as EventTarget & { closed?: [number?, string?]; send(m: unknown): void; close(code?: number, reason?: string): void };
    sock.send = () => {};
    sock.close = (code, reason) => void (sock.closed = [code, reason]);
    g.Deno = { upgradeWebSocket: () => ({ socket: sock, response: new Response(null, { status: 200 }) }) };
    try {
      const got: number[] = [];
      const app = miu({ logLevel: "silent", websocket: { maxPayloadLength: 100 }, routes: [route.get("/ws", { handler: (c) => c.upgrade({ message: (_s, m) => void got.push(m.length) }) })] });
      expect((await app.request("/ws", { headers: { upgrade: "websocket" } })).status).toBe(200);
      sock.dispatchEvent(new MessageEvent("message", { data: "a".repeat(100) }));
      sock.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(100).buffer }));
      expect(sock.closed).toBeUndefined();
      sock.dispatchEvent(new MessageEvent("message", { data: "é".repeat(51) })); // 51 chars, 102 UTF-8 bytes
      expect(sock.closed).toEqual([1009, "Message too big"]);
      sock.closed = undefined;
      sock.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(101).buffer }));
      expect(sock.closed as unknown).toEqual([1009, "Message too big"]);
      expect(got).toEqual([100, 100]);
    } finally {
      delete g.Deno;
    }
  });
});
