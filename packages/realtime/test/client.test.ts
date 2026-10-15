import { afterAll, beforeAll, expect, test } from "bun:test";
import { miu } from "miujs";
import { connect } from "../src/client.ts";
import { defineRoom, rooms, t } from "../src/index.ts";

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  client: { say: t.object({ text: t.string() }), shout: t.object({ text: t.string() }) },
  init: () => ({ lines: [] }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`];
    },
    shout: ({ room, msg }) => room.broadcast("shout", { text: msg.text.toUpperCase() }),
  },
});

let server: { url: string; stop(): Promise<void> };
let base = "";

beforeAll(async () => {
  const app = miu({ plugins: [rooms({ rooms: [chat] })], logLevel: "silent" });
  server = await app.listen(0);
  base = server.url.replace("http", "ws") + "rooms/chat/";
});
afterAll(() => server.stop());

function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const v = fn();
      if (v !== undefined && v !== false) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("connect() joins, exposes me + state, and applies patches", async () => {
  const c = connect<{ lines: string[] }>(base + "C1", { name: "Ann" });
  await c.ready;
  expect(c.me).toMatchObject({ name: "Ann", role: "host" });
  expect(c.state).toEqual({ lines: [] });
  const seen: string[][] = [];
  c.on("state", (s: { lines: string[] }) => seen.push(s.lines));
  c.send("say", { text: "hi" });
  await until(() => seen.length > 0);
  expect(c.state).toEqual({ lines: ["Ann: hi"] });
  expect(seen).toEqual([["Ann: hi"]]);
  c.close();
});

test("server events and error frames reach on() listeners", async () => {
  const c = connect(base + "C2", { name: "Ann" });
  await c.ready;
  const shouts: unknown[] = [];
  const errs: any[] = [];
  const off = c.on("shout", (d) => shouts.push(d));
  c.on("error", (e) => errs.push(e));
  c.send("shout", { text: "hey" });
  c.send("nope", {});
  await until(() => shouts.length > 0 && errs.length > 0);
  expect(shouts).toEqual([{ text: "HEY" }]);
  expect(errs[0].code).toBe("MIU_E_ROOM_UNKNOWN_MESSAGE");
  off();
  c.send("shout", { text: "again" });
  c.send("say", { text: "x" });
  await until(() => c.state && (c.state as any).lines.length === 1);
  expect(shouts.length).toBe(1);
  c.close();
});

test("a dropped connection reconnects with the resume token and keeps the player id", async () => {
  const c = connect(base + "C3", { name: "Ann", reconnect: { minDelayMs: 10 } });
  await c.ready;
  const id = c.me!.id;
  const states: unknown[] = [];
  c.on("reconnected", () => states.push("reconnected"));
  c.socket!.close(3000, "simulated drop");
  await until(() => states.length > 0);
  expect(c.me!.id).toBe(id);
  c.send("say", { text: "back" });
  await until(() => (c.state as any).lines.length === 1);
  c.close();
});

test("messages sent while reconnecting are queued and delivered", async () => {
  const c = connect(base + "C4", { name: "Ann", reconnect: { minDelayMs: 10 } });
  await c.ready;
  c.socket!.close(3000);
  c.send("say", { text: "queued" });
  await until(() => (c.state as any).lines.length === 1);
  expect((c.state as any).lines).toEqual(["Ann: queued"]);
  c.close();
});

test("close() stops reconnecting", async () => {
  const c = connect(base + "C5", { name: "Ann", reconnect: { minDelayMs: 10 } });
  await c.ready;
  let reopened = 0;
  c.on("open", () => reopened++);
  const closed = new Promise((r) => c.on("close", r));
  c.close();
  await closed;
  await new Promise((r) => setTimeout(r, 50));
  expect(reopened).toBe(0);
  expect(c.connected).toBe(false);
});

test("encoding: 'msgpack' negotiates ?enc=msgpack and speaks binary frames both ways", async () => {
  const c = connect<{ lines: string[] }>(base + "C6", { name: "Ann", encoding: "msgpack" });
  await c.ready;
  expect(new URL(c.socket!.url).searchParams.get("enc")).toBe("msgpack");
  const kinds: string[] = [];
  c.socket!.addEventListener("message", (e: MessageEvent) => kinds.push(typeof e.data === "string" ? "text" : "binary"));
  c.send("say", { text: "packed" });
  await until(() => c.state && c.state.lines.length === 1);
  expect(c.state!.lines).toEqual(["Ann: packed"]);
  expect(kinds).toEqual(["binary"]);
  c.close();
});
