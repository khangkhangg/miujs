import { expect, test } from "bun:test";
import { sqlite } from "@miujs/db";
import { FakeClock, rooms, t } from "@miujs/realtime";
import { createMatchmakerDurableObject, durableHost } from "../src/cloudflare.ts";
import { matchmaker } from "../src/matchmaker.ts";
import { gameRoom } from "../src/room.ts";
import { GameStore } from "../src/store.ts";
import { verifyTicket } from "../src/sign.ts";

const SECRET = "cf-secret-0123456789abcdef-xyz";

class CfSocket {
  frames: any[] = [];
  closed: { code?: number } | null = null;
  tags: string[] = [];
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
}

function fakeState() {
  const data = new Map<string, unknown>();
  const sockets: CfSocket[] = [];
  let alarm: number | null = null;
  return {
    data,
    sockets,
    get alarm() {
      return alarm;
    },
    acceptWebSocket(ws: CfSocket, tags: string[] = []) {
      ws.tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag?: string) {
      return sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag)));
    },
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
      async setAlarm(at: number) {
        alarm = at;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
  };
}

function setup() {
  const clock = new FakeClock(100_000);
  const db = sqlite(":memory:");
  const arena = gameRoom("cfarena", { state: t.object({}), init: () => ({}) }, { secret: SECRET });
  const realtime = rooms({ rooms: [arena], clock });
  const mm = matchmaker({ rooms: realtime, secret: SECRET, database: db, clock, queues: { ranked: { room: "cfarena", teamSize: 1, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000 } } });
  const MiuMatchmaker = createMatchmakerDurableObject(mm, { clock, webSocketPair: () => [new CfSocket(), new CfSocket()] as any });
  const states = new Map<string, ReturnType<typeof fakeState>>();
  const objects = new Map<string, InstanceType<typeof MiuMatchmaker>>();
  const env: Record<string, unknown> = {};
  const ns = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      if (!objects.has(name)) {
        const st = fakeState();
        states.set(name, st);
        objects.set(name, new MiuMatchmaker(st as any, env));
      }
      return objects.get(name)!;
    },
  };
  env.MIU_MATCH = ns;
  const host = durableHost(ns);
  return { clock, mm, MiuMatchmaker, ns, states, objects, host, env, realtime, store: new GameStore(db, { clock }) };
}

test("join / status / leave are forwarded to the queue's Durable Object (match:<queue>)", async () => {
  const { host, states } = setup();
  expect(await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 })).toMatchObject({ state: "queued", since: 100_000 });
  expect(states.has("match:ranked")).toBe(true);
  expect(await host.status("ranked", "a")).toMatchObject({ state: "queued" });
  expect(await host.leave("ranked", "a")).toBe(true);
  expect(await host.status("ranked", "a")).toEqual({ state: "idle" });
});

test("errors from the object come back as MiuErrors", async () => {
  const { host } = setup();
  await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 });
  const err = await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 }).catch((e) => e);
  expect(err.code).toBe("MIU_E_GAME_ALREADY_QUEUED");
  expect(err.status).toBe(409);
});

test("a match creates the room, records it, and stores each player's room and ticket", async () => {
  const { host, store, clock, realtime } = setup();
  await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 });
  const s = await host.join("ranked", { userId: "b", name: "Bob", rating: 1520 });
  expect(s.state).toBe("matched");
  const a = await host.status("ranked", "a");
  if (a.state !== "matched") throw new Error("not matched");
  expect(realtime.registry.get("cfarena", a.room.id)).toBeTruthy();
  expect(await verifyTicket(SECRET, a.ticket, { roomType: "cfarena", roomId: a.room.id, now: clock.now() })).toMatchObject({ userId: "a" });
  expect(await store.match(a.matchId)).toMatchObject({ status: "pending", roomId: a.room.id });
});

test("widening runs from Durable Object alarms, deterministically on the fake clock", async () => {
  const { host, states, objects, clock, store } = setup();
  await store.setRating("hi", "ranked", 1800);
  await host.join("ranked", { userId: "lo", name: "lo", rating: 1500 });
  await host.join("ranked", { userId: "hi", name: "hi", rating: 1800 });
  const st = states.get("match:ranked")!;
  expect(st.alarm).toBe(105_000);
  clock.advance(5_000);
  await objects.get("match:ranked")!.alarm();
  expect((await host.status("ranked", "lo")).state).toBe("queued");
  expect(st.alarm).toBe(110_000);
  clock.advance(5_000);
  await objects.get("match:ranked")!.alarm();
  expect((await host.status("ranked", "lo")).state).toBe("matched");
});

test("queue state is persisted: a fresh object instance (after eviction) sees the same queue", async () => {
  const { host, states, MiuMatchmaker, env } = setup();
  await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 });
  const revived = new MiuMatchmaker(states.get("match:ranked") as any, env);
  const res = await revived.fetch(new Request("https://miu-match/_miu/match/status?queue=ranked", { method: "POST", body: JSON.stringify({ userId: "a" }) }));
  expect((await res.json()).ok).toMatchObject({ state: "queued" });
  await revived.alarm(); // alarm after eviction knows its queue
});

test("notify sockets are tagged by user and get pushed the match", async () => {
  const { host, ns, states } = setup();
  const obj = ns.get("match:ranked");
  const res = await obj.fetch(new Request("https://miu-match/_miu/match/notify?queue=ranked", { headers: { upgrade: "websocket", "x-miu-user": "a" } }));
  expect(res.status).toBe(101);
  const ws = states.get("match:ranked")!.sockets[0];
  expect(ws.tags).toEqual(["a"]);
  expect(ws.frames[0]).toEqual({ t: "match", queue: "ranked", status: { state: "idle" } });
  await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 });
  await host.join("ranked", { userId: "b", name: "Bob", rating: 1500 });
  expect(ws.frames.map((f) => f.status.state)).toEqual(["idle", "queued", "matching", "matched"]);
  expect(typeof ws.frames[3].status.ticket).toBe("string");
});

test("the object refuses notify without the Worker-set user header, and unknown queues", async () => {
  const { ns } = setup();
  const obj = ns.get("match:ranked");
  const r1 = await obj.fetch(new Request("https://miu-match/_miu/match/notify?queue=ranked", { headers: { upgrade: "websocket" } }));
  expect(r1.status).toBe(401);
  const r2 = await obj.fetch(new Request("https://miu-match/_miu/match/status?queue=nope", { method: "POST", body: "{}" }));
  expect(r2.status).toBe(404);
});

test("lobby Durable Object: runs lobby operations and persists them across instances", async () => {
  const { createLobbyDurableObject, lobbies } = await import("../src/lobbies.ts");
  const clock = new FakeClock(0);
  const party = gameRoom("cfparty", { state: t.object({}), init: () => ({}) }, { secret: SECRET });
  const lb = lobbies({ rooms: rooms({ rooms: [party], clock }), room: "cfparty", secret: SECRET, database: sqlite(":memory:"), clock });
  const MiuLobbies = createLobbyDurableObject(lb);
  const st = fakeState();
  const exec = async (obj: any, body: unknown) => (await obj.fetch(new Request("https://miu-lobby/_miu/lobby/exec", { method: "POST", body: JSON.stringify(body) }))).json();
  const a = new MiuLobbies(st as any, {});
  const init = { id: "l0123456789abcdef", code: "123456", roomType: "cfparty", hostId: "ann", hostName: "Ann", minPlayers: 2, maxPlayers: 4, teams: 2, now: 0 };
  expect((await exec(a, { op: "create", init })).ok.lobby.hostId).toBe("ann");
  await exec(a, { op: "join", userId: "bob", name: "Bob" });
  const b = new MiuLobbies(st as any, {});
  expect((await exec(b, { op: "view", userId: "bob" })).ok.lobby.members.map((m: any) => m.userId)).toEqual(["ann", "bob"]);
  const denied = await exec(b, { op: "start", userId: "bob" });
  expect(denied.error.code).toBe("MIU_E_GAME_LOBBY_NOT_HOST");
  const empty = new MiuLobbies(fakeState() as any, {});
  expect((await exec(empty, { op: "view", userId: "x" })).error.code).toBe("MIU_E_GAME_LOBBY_NOT_FOUND");
});

test("MIU_GAME_SECRET is read from the Worker / Durable Object env when no secret option is given", async () => {
  // Regression (workerd harness): on Workers there is no process env, and the matchmaker object
  // never sees a request through the app, so tickets failed with MIU_E_GAME_SECRET_MISSING even
  // with MIU_GAME_SECRET set as a secret.
  const ENV_SECRET = "env-secret-0123456789abcdef-env";
  const clock = new FakeClock(100_000);
  const arena = gameRoom("cfenv", { state: t.object({}), init: () => ({}) });
  const realtime = rooms({ rooms: [arena], clock });
  const mm = matchmaker({ rooms: realtime, database: sqlite(":memory:"), clock, queues: { ranked: { room: "cfenv", teamSize: 1, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000 } } });
  const MiuMatchmaker = createMatchmakerDurableObject(mm, { clock, webSocketPair: () => [new CfSocket(), new CfSocket()] as any });
  const env: Record<string, unknown> = { MIU_GAME_SECRET: ENV_SECRET };
  const obj = new MiuMatchmaker(fakeState() as any, env);
  const ns = { idFromName: (n: string) => n, get: () => obj };
  env.MIU_MATCH = ns;
  const host = durableHost(ns);
  await host.join("ranked", { userId: "a", name: "Ann", rating: 1500 });
  await host.join("ranked", { userId: "b", name: "Bob", rating: 1500 });
  const a = await host.status("ranked", "a");
  if (a.state !== "matched") throw new Error(`not matched: ${JSON.stringify(a)}`);
  expect(await verifyTicket(ENV_SECRET, a.ticket, { roomType: "cfenv", roomId: a.room.id, now: clock.now() })).toMatchObject({ userId: "a" });
});

test("game rooms verify tickets with MIU_GAME_SECRET from the room's env", async () => {
  const ENV_SECRET = "env-secret-0123456789abcdef-env";
  const { issueTicket } = await import("../src/sign.ts");
  const { gameSecretFor } = await import("../src/sign.ts");
  expect(gameSecretFor(undefined, { MIU_GAME_SECRET: ENV_SECRET })).toBe(ENV_SECRET);
  expect(gameSecretFor("explicit-secret-0123456789", { MIU_GAME_SECRET: ENV_SECRET })).toBe("explicit-secret-0123456789");
  const tk = await issueTicket(ENV_SECRET, { userId: "u", name: "U", roomType: "x", roomId: "r1", matchId: "m", team: 0 }, 1000, 60_000);
  expect(await verifyTicket(gameSecretFor(undefined, { MIU_GAME_SECRET: ENV_SECRET }), tk, { roomType: "x", roomId: "r1", now: 1000 })).toMatchObject({ userId: "u" });
});
