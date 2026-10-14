import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect as tcpConnect, type Socket } from "node:net";
import { FrameParser, OP, encodeFrame } from "../../src/adapters/node-ws.ts";

// Runs the Bun behavioral suite against the Node adapter in a real Node process.
let proc: ReturnType<typeof Bun.spawn>;
let port = 0;
let base = "";
let http = "";

beforeAll(async () => {
  proc = Bun.spawn(["node", "--experimental-strip-types", "--no-warnings", new URL("./fixtures/node-ws-app.ts", import.meta.url).pathname], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`node fixture exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  port = JSON.parse(text.split("\n")[0]!).port;
  base = `ws://127.0.0.1:${port}`;
  http = `http://127.0.0.1:${port}`;
}, 20_000);

afterAll(() => {
  proc?.kill();
});

const serverLog = async (): Promise<unknown[]> => (await fetch(`${http}/log`)).json() as Promise<unknown[]>;
async function waitForLog(pred: (log: unknown[]) => boolean): Promise<unknown[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const log = await serverLog();
    if (pred(log)) return log;
    if (Date.now() > deadline) throw new Error(`timeout; log = ${JSON.stringify(log)}`);
    await Bun.sleep(20);
  }
}
const has = (entry: unknown) => (log: unknown[]) => log.some((e) => JSON.stringify(e) === JSON.stringify(entry));

function connect(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? ({ headers } as any) : undefined);
  ws.binaryType = "arraybuffer";
  const messages: (string | ArrayBuffer)[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    messages.push(typeof e.data === "string" ? e.data : (e.data as ArrayBuffer));
    for (const w of waiters.splice(0)) w();
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  opened.catch(() => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  const next = async (n = messages.length + 1) => {
    const deadline = Date.now() + 3000;
    while (messages.length < n) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${n} messages, got ${JSON.stringify(messages)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return messages as string[];
  };
  return { ws, messages, opened, closed, next };
}

/** A raw TCP client speaking RFC 6455 by hand, for protocol-level checks. */
async function rawClient(path = "/echo", extraHeaders = "") {
  const sock: Socket = tcpConnect(port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  sock.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
  );
  const parser = new FrameParser({ maxPayload: 1 << 20, requireMask: false });
  const events: { type: string; data?: unknown; code?: number; reason?: string }[] = [];
  let head = "";
  let headDone = false;
  let ended = false;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  sock.on("data", (chunk: Buffer) => {
    let bytes: Uint8Array = chunk;
    if (!headDone) {
      head += chunk.toString("latin1");
      const i = head.indexOf("\r\n\r\n");
      if (i < 0) return;
      headDone = true;
      bytes = chunk.subarray(chunk.length - (head.length - i - 4));
      head = head.slice(0, i);
    }
    if (!head.startsWith("HTTP/1.1 101")) return;
    events.push(...parser.push(bytes));
    wake();
  });
  sock.on("close", () => {
    ended = true;
    wake();
  });
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timeout; events = ${JSON.stringify(events)}, head = ${head}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  await until(() => headDone || ended);
  const mask = () => crypto.getRandomValues(new Uint8Array(4));
  return {
    sock,
    events,
    head: () => head,
    ended: () => ended,
    until,
    send: (op: number, data: string | Uint8Array, o: { fin?: boolean; masked?: boolean } = {}) =>
      sock.write(encodeFrame(op, data, { fin: o.fin, mask: o.masked === false ? undefined : mask() })),
    write: (b: Uint8Array) => sock.write(b),
  };
}

describe("app.ws on Node (serve from miujs/node)", () => {
  test("the fixture really runs on Node", async () => {
    expect(await (await fetch(`${http}/runtime`)).json()).toEqual({ node: true });
  });

  test("open, message echo and close handlers run", async () => {
    const client = connect(`${base}/echo`);
    await client.opened;
    client.ws.send("hi");
    expect(await client.next(2)).toEqual(["welcome", JSON.stringify({ echo: "hi" })]);
    client.ws.close(4000, "bye");
    expect(await client.closed).toEqual({ code: 4000, reason: "bye" });
    await waitForLog(has(["close", 4000, "bye"]));
    expect(await serverLog()).toContainEqual(["open", 1]);
  });

  test("socket has id, readyState and per-connection data from upgrade()", async () => {
    const client = connect(`${base}/rooms/lobby?name=ann`, { "x-token": "abc" });
    const [msg] = await client.next(1);
    expect(JSON.parse(msg!)).toEqual({ data: { user: "ann", room: "lobby", token: "abc" }, hasId: true, readyState: 1 });
    client.ws.close();
  });

  test("binary messages arrive as ArrayBuffer and binary sends work", async () => {
    const client = connect(`${base}/bin`);
    await client.opened;
    client.ws.send(new Uint8Array([1, 2, 3]));
    await client.next(2);
    expect(JSON.parse(client.messages[0] as string)).toEqual({ binary: true, bytes: [1, 2, 3] });
    expect([...new Uint8Array(client.messages[1] as ArrayBuffer)]).toEqual([3, 2, 1]);
    client.ws.close();
  });

  test("middleware rejects before upgrade (401) and its headers reach the handshake", async () => {
    const denied = await rawClient("/secure");
    expect(denied.head()).toStartWith("HTTP/1.1 401");
    expect(denied.head().toLowerCase()).toContain("content-type: application/problem+json");
    await denied.until(denied.ended);

    const viaClient = connect(`${base}/secure`);
    await expect(viaClient.opened).rejects.toThrow();

    const ok = await rawClient("/secure", "Authorization: Bearer ok\r\n");
    expect(ok.head()).toStartWith("HTTP/1.1 101 Switching Protocols");
    expect(ok.head().toLowerCase()).toContain("x-auth: yes");
    await ok.until(() => ok.events.length > 0);
    expect(ok.events[0]).toEqual({ type: "message", data: "in" });
    ok.sock.destroy();
  });

  test("upgrade() returning a Response and query validation reject the handshake", async () => {
    const busy = await rawClient("/reject");
    expect(busy.head()).toStartWith("HTTP/1.1 503");
    const invalid = await rawClient("/v?n=abc");
    expect(invalid.head()).toStartWith("HTTP/1.1 422");
    const valid = connect(`${base}/v?n=3`);
    expect(await valid.next(1)).toEqual(["valid"]);
    valid.ws.close();
  });

  test("plain GET to a WS path is 426 Upgrade Required", async () => {
    const res = await fetch(`${http}/echo`);
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("websocket");
  });

  test("bad handshakes are refused (missing key, wrong version)", async () => {
    const raw = (headers: string) => {
      const sock = tcpConnect(port, "127.0.0.1");
      return new Promise<string>((resolve) => {
        let s = "";
        sock.on("data", (d) => (s += d.toString()));
        sock.on("close", () => resolve(s));
        sock.write(`GET /echo HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`);
      });
    };
    expect(await raw("Sec-WebSocket-Version: 13\r\n")).toStartWith("HTTP/1.1 400");
    expect(await raw("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n")).toStartWith("HTTP/1.1 400");
    expect(await raw("Sec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n")).toStartWith("HTTP/1.1 400");
  });

  test("pub/sub: publish reaches other subscribers but not the sender", async () => {
    const a = connect(`${base}/chat`);
    const b = connect(`${base}/chat`);
    await a.next(1);
    await b.next(1);
    a.ws.send("hello from a");
    expect(await b.next(2)).toEqual(["ready", "hello from a"]);
    await Bun.sleep(50);
    expect(a.messages).toEqual(["ready"]);
    b.ws.send("leave");
    await Bun.sleep(30);
    a.ws.send("after leave");
    await Bun.sleep(80);
    expect(b.messages).toEqual(["ready", "hello from a"]);
    a.ws.close();
    b.ws.close();
  });

  test("app.publish reaches every subscriber of a topic", async () => {
    const a = connect(`${base}/news`);
    const b = connect(`${base}/news`);
    await a.next(1);
    await b.next(1);
    const res = await fetch(`${http}/publish/news`, { method: "POST", body: "extra!" });
    expect(res.status).toBe(200);
    expect(await a.next(2)).toEqual(["subscribed", "extra!"]);
    expect(await b.next(2)).toEqual(["subscribed", "extra!"]);
    a.ws.close();
    b.ws.close();
  });

  test("rooms: presence and broadcast through the hub, auto-leave on close", async () => {
    const a = connect(`${base}/room/r1?name=ann`);
    await a.next(1);
    const b = connect(`${base}/room/r1?name=bob`);
    await b.next(1);
    await a.next(2);
    expect(JSON.parse(a.messages[1] as string)).toEqual({ type: "presence", members: ["ann", "bob"] });
    b.ws.send("yo");
    expect(JSON.parse((await a.next(3))[2]!)).toEqual({ from: "bob", text: "yo" });
    b.ws.close();
    await waitForLog(has(["room-left", ["ann"]]));
    a.ws.close();
  });

  test("handler errors go to error() and don't crash the server", async () => {
    const client = connect(`${base}/err`);
    await client.opened;
    client.ws.send("x");
    expect(await client.next(1)).toEqual(["recovered"]);
    client.ws.close();
  });

  test("server-initiated close completes the close handshake", async () => {
    const client = connect(`${base}/bye`);
    expect(await client.closed).toEqual({ code: 4001, reason: "server says bye" });
    await waitForLog(has(["bye-closed", 4001, "server says bye"]));
  });

  test("messages over maxPayload close the socket with 1009", async () => {
    const client = connect(`${base}/echo`);
    await client.next(1);
    client.ws.send("x".repeat(64 * 1024 + 1));
    expect((await client.closed).code).toBe(1009);
    // A message right at the limit is fine.
    const ok = connect(`${base}/echo`);
    await ok.next(1);
    ok.ws.send("y".repeat(64 * 1024 - 20));
    expect(JSON.parse((await ok.next(2))[1]!).echo.length).toBe(64 * 1024 - 20);
    ok.ws.close();
  });

  test("ping gets a pong with the same payload", async () => {
    const c = await rawClient("/echo");
    await c.until(() => c.events.length > 0);
    c.send(OP.PING, "are you there");
    await c.until(() => c.events.some((e) => e.type === "pong"));
    expect(c.events.find((e) => e.type === "pong")!.data).toEqual(new TextEncoder().encode("are you there"));
    c.sock.destroy();
  });

  test("fragmented messages from a raw client are reassembled", async () => {
    const c = await rawClient("/echo");
    c.send(OP.TEXT, "frag", { fin: false });
    c.send(OP.PING, "");
    c.send(OP.CONT, "mented");
    await c.until(() => c.events.length >= 3);
    expect(c.events.filter((e) => e.type === "message").map((e) => e.data)).toEqual(["welcome", JSON.stringify({ echo: "fragmented" })]);
    c.sock.destroy();
  });

  test("unmasked client frames are rejected with 1002", async () => {
    const c = await rawClient("/echo");
    c.send(OP.TEXT, "naked", { masked: false });
    await c.until(() => c.events.some((e) => e.type === "close"));
    expect(c.events.find((e) => e.type === "close")!.code).toBe(1002);
    await c.until(c.ended);
  });

  test("client close frames are echoed and the server reports the code", async () => {
    const c = await rawClient("/echo");
    await c.until(() => c.events.length > 0);
    c.send(OP.CLOSE, new Uint8Array([0x0f, 0xa2, 0x6f, 0x6b])); // 4002 "ok"
    await c.until(() => c.events.some((e) => e.type === "close"));
    expect(c.events.find((e) => e.type === "close")).toEqual({ type: "close", code: 4002, reason: "ok" });
    await c.until(c.ended);
    await waitForLog(has(["close", 4002, "ok"]));
  });

  test("idle connections are pinged, then dropped when silent", async () => {
    const c = await rawClient("/echo");
    // The raw client never answers pings; idleTimeout is 2s in the fixture.
    await c.until(() => c.events.some((e) => e.type === "ping"));
    const deadline = Date.now() + 6000;
    while (!c.ended() && Date.now() < deadline) await Bun.sleep(100);
    expect(c.ended()).toBe(true);
    await waitForLog(has(["close", 1006, ""]));
  }, 10_000);
});
