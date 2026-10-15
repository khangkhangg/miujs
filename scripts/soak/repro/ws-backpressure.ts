// Probe: (a) how big a frame Bun buffers before the room's 16 KiB check runs, (b) how much a
// client that never reads makes the server buffer. Run: bun scripts/soak/repro/ws-backpressure.ts
import { miu, t } from "../../../packages/miujs/src/index.ts";
import { defineRoom, rooms } from "../../../packages/realtime/src/index.ts";
import { connect } from "node:net";

const big = defineRoom("big", {
  state: t.object({ blob: t.string() }),
  client: { set: t.object({ n: t.integer() }) },
  init: () => ({ blob: "" }),
  rateLimit: false,
  on: { set: ({ room, msg }) => void (room.state.blob = "x".repeat(msg.n) + Math.random()) },
});
const realtime = rooms({ rooms: [big] });
const app = miu({ plugins: [realtime], logLevel: "silent" });
const srv = await app.listen(0);
const port = Number(new URL(srv.url).port);
const mb = () => (process.memoryUsage().rss / 1e6).toFixed(0);
Bun.gc(true);
console.log("rss start", mb());

// (a) 15 MB text frame
{
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rooms/big/a?name=A`);
  await new Promise((r) => (ws.onopen = r));
  let closed: any = null;
  ws.onclose = (e) => (closed = e.code);
  ws.send("y".repeat(15_000_000));
  await Bun.sleep(500);
  console.log("15 MB frame: closed with", closed, "rss", mb());
}

// (b) a raw TCP client that upgrades, joins and never reads; another client makes the room broadcast 200 KB patches
const SLOW = Number(process.env.SLOW ?? 1);
const socks = [];
for (let k = 0; k < SLOW; k++) {
const sock = connect(port, "127.0.0.1");
socks.push(sock);
await new Promise((r) => sock.once("connect", r));
sock.write(`GET /rooms/big/b?name=Slow HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
await Bun.sleep(200);
sock.pause(); // stop reading: the kernel buffers fill, then Bun buffers in user space
}
const fast = new WebSocket(`ws://127.0.0.1:${port}/rooms/big/b?name=Fast`);
await new Promise((r) => (fast.onopen = r));
let got = 0;
fast.onmessage = () => got++;
for (let i = 0; i < 400; i++) {
  fast.send(JSON.stringify({ t: "msg", type: "set", data: { n: 200_000 } }));
  if (i % 100 === 99) {
    await Bun.sleep(300);
    console.log(`after ${i + 1} broadcasts of ~200 KB: rss ${mb()} MB (fast client got ${got} frames)`);
  }
}
for (const sock of socks) sock.destroy();
fast.close();
await srv.stop();
realtime.stop();
