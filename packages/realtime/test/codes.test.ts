import { expect, test } from "bun:test";
import { miu } from "miujs";
import { FakeClock, KvCodeStore, MemoryCodeStore, allocateCode, createRoomDurableObject, defineRoom, rooms, t } from "../src/index.ts";
import { fakeSocket } from "./helpers.ts";

const lobby = defineRoom("lobby", {
  state: t.object({ title: t.string() }),
  init: (ctx) => ({ title: (ctx.data as { title?: string } | undefined)?.title ?? "untitled" }),
});

function fakeKv() {
  const data = new Map<string, string>();
  const puts: { key: string; ttl?: number }[] = [];
  return {
    data,
    puts,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      data.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
  };
}

// ---- stores --------------------------------------------------------------------------------

test("MemoryCodeStore: claim is first-come, entries expire", async () => {
  const clock = new FakeClock(0);
  const store = new MemoryCodeStore(clock);
  expect(await store.claim("123456", { type: "lobby", id: "a" }, 1_000)).toBe(true);
  expect(await store.claim("123456", { type: "lobby", id: "b" }, 1_000)).toBe(false);
  expect(await store.get("123456")).toEqual({ type: "lobby", id: "a" });
  clock.advance(1_000);
  expect(await store.get("123456")).toBeNull();
  expect(await store.claim("123456", { type: "lobby", id: "c" }, 1_000)).toBe(true);
});

test("KvCodeStore writes JSON with an expirationTtl (KV minimum 60 s) and refuses live codes", async () => {
  const kv = fakeKv();
  const store = new KvCodeStore(kv);
  expect(await store.claim("654321", { type: "lobby", id: "x" }, 5_000)).toBe(true);
  expect(kv.puts).toEqual([{ key: "miu:code:654321", ttl: 60 }]);
  expect(await store.claim("654321", { type: "lobby", id: "y" }, 5_000)).toBe(false);
  expect(await store.get("654321")).toEqual({ type: "lobby", id: "x" });
  expect(await store.get("000000")).toBeNull();
  await store.claim("111111", { type: "lobby", id: "z" }, 7_200_000);
  expect(kv.puts.at(-1)!.ttl).toBe(7_200);
});

test("allocateCode retries on a live collision and gives up with MIU_E_ROOM_CODES_EXHAUSTED", async () => {
  const store = new MemoryCodeStore(new FakeClock());
  await store.claim("111111", { type: "lobby", id: "taken" }, 60_000);
  const seq = ["111111", "111111", "222222"];
  expect(await allocateCode(store, { type: "lobby", id: "new" }, 60_000, () => seq.shift()!)).toBe("222222");
  await expect(allocateCode(store, { type: "lobby", id: "n" }, 60_000, () => "111111")).rejects.toMatchObject({ code: "MIU_E_ROOM_CODES_EXHAUSTED" });
});

// ---- plugin --------------------------------------------------------------------------------

test("createRoom() makes a room with init data and a 6-digit code; GET /rooms/code/:code resolves it", async () => {
  const realtime = rooms({ rooms: [lobby], clock: new FakeClock() });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  const { id, code } = await realtime.createRoom("lobby", { data: { title: "Friday quiz" } });
  expect(code).toMatch(/^\d{6}$/);
  expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(id).not.toBe(code);
  const inst = realtime.registry.get("lobby", id)!;
  const s = fakeSocket();
  inst.connect(s, { name: "Ann" });
  expect(s.last("state").state).toEqual({ title: "Friday quiz" });

  const res = await app.request(`/rooms/code/${code}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ type: "lobby", id });
});

test("unknown codes are 404; createRoom with an unknown type throws", async () => {
  const realtime = rooms({ rooms: [lobby] });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  const res = await app.request("/rooms/code/999999");
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe("MIU_E_ROOM_CODE_UNKNOWN");
  expect((await app.request("/rooms/code/abc")).status).toBe(404);
  await expect(realtime.createRoom("nope")).rejects.toMatchObject({ code: "MIU_E_ROOM_TYPE_UNKNOWN" });
});

test("live codes never collide", async () => {
  const realtime = rooms({ rooms: [lobby] });
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) codes.add((await realtime.createRoom("lobby")).code);
  expect(codes.size).toBe(200);
});

test("codes expire after codeTtlMs", async () => {
  const clock = new FakeClock(0);
  const realtime = rooms({ rooms: [lobby], clock, codeTtlMs: 1_000 });
  const app = miu({ plugins: [realtime], logLevel: "silent" });
  const { code } = await realtime.createRoom("lobby");
  clock.advance(1_000);
  expect((await app.request(`/rooms/code/${code}`)).status).toBe(404);
});

test("code lookups are rate-limited per IP against guessing (429 MIU_E_ROOM_CODE_RATE_LIMITED)", async () => {
  const clock = new FakeClock(0);
  const realtime = rooms({ rooms: [lobby], clock, codeLookups: { perMinute: 6, burst: 3 } });
  await miu({ plugins: [realtime], logLevel: "silent" }).ready();
  const lookup = realtime.routes.find((r) => r.path.endsWith("/code/:code"))!;
  const call = async (ip: string) => {
    try {
      await lookup.config.handler({ params: { code: "999999" }, ip, runtime: "bun", env: {} } as any);
      return 200;
    } catch (e: any) {
      return e.code;
    }
  };
  expect([await call("1.1.1.1"), await call("1.1.1.1"), await call("1.1.1.1")]).toEqual(Array(3).fill("MIU_E_ROOM_CODE_UNKNOWN"));
  expect(await call("1.1.1.1")).toBe("MIU_E_ROOM_CODE_RATE_LIMITED");
  expect(await call("2.2.2.2")).toBe("MIU_E_ROOM_CODE_UNKNOWN"); // other IPs unaffected
  clock.advance(10_000); // 6/min → one lookup per 10 s
  expect(await call("1.1.1.1")).toBe("MIU_E_ROOM_CODE_UNKNOWN");
  expect(await call("1.1.1.1")).toBe("MIU_E_ROOM_CODE_RATE_LIMITED");
});

test("cloudflare() declares the codes KV binding next to the Durable Object", () => {
  expect(rooms({ rooms: [lobby], codes: "ROOM_CODES" }).cloudflare()).toEqual({
    durableObjects: [{ binding: "MIU_ROOMS", className: "MiuRooms" }],
    kv: ["ROOM_CODES"],
  });
});

// ---- Cloudflare ----------------------------------------------------------------------------

function fakeDoState() {
  const data = new Map<string, unknown>();
  return {
    data,
    acceptWebSocket() {},
    getWebSockets: () => [],
    storage: {
      async get(k: string) {
        return structuredClone(data.get(k));
      },
      async put(k: string, v: unknown) {
        data.set(k, structuredClone(v));
      },
      async delete(k: string) {
        return data.delete(k);
      },
    },
  };
}

test("on Cloudflare createRoom() claims the code in KV and initialises the Durable Object with the data", async () => {
  const Rooms = createRoomDurableObject([lobby], { clock: new FakeClock() });
  const objects = new Map<string, { obj: InstanceType<typeof Rooms>; state: ReturnType<typeof fakeDoState> }>();
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      if (!objects.has(name)) {
        const state = fakeDoState();
        objects.set(name, { obj: new Rooms(state as any, {}), state });
      }
      return { fetch: (req: Request) => objects.get(name)!.obj.fetch(req) };
    },
  };
  const kv = fakeKv();
  const env = { MIU_ROOMS: ns, ROOM_CODES: kv };
  const realtime = rooms({ rooms: [lobby], codes: "ROOM_CODES" });
  const { id, code } = await realtime.createRoom("lobby", { data: { title: "Edge" }, env });
  expect(JSON.parse(kv.data.get(`miu:code:${code}`)!)).toEqual({ type: "lobby", id });
  const snap = objects.get(`lobby:${id}`)!.state.data.get("miu:room") as any;
  expect(snap.state).toEqual({ title: "Edge" });

  const lookup = realtime.routes.find((r) => r.path.endsWith("/code/:code"))!;
  expect(await lookup.config.handler({ params: { code }, ip: "1.1.1.1", runtime: "workerd", env } as any)).toEqual({ type: "lobby", id });
});
