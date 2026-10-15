import { expect, test } from "bun:test";
import { miu } from "miujs";
import { connect } from "../src/client.ts";
import { FakeClock, LocalRooms, defineRoom, rooms, shardedRoom, t } from "../src/index.ts";
import { fakeSocket, type FakeSocket } from "./helpers.ts";

const arenaRoom = defineRoom("arena", {
  state: t.object({
    scores: t.record(t.number()),
    names: t.record(t.string()),
    top: t.array(t.object({ name: t.string(), score: t.number() })),
    title: t.string(),
  }),
  client: { score: t.object({ n: t.number() }) },
  init: (ctx) => ({ scores: {}, names: {}, top: [], title: (ctx.data as { title?: string } | undefined)?.title ?? "" }),
  onJoin: ({ room, player }) => {
    if (player.role === "spectator") return;
    room.state.scores[player.id] = 0;
    room.state.names[player.id] = player.name;
  },
  onLeave: ({ room, player }) => {
    delete room.state.scores[player.id];
    delete room.state.names[player.id];
  },
  on: {
    score: ({ room, sender, msg }) => {
      room.state.scores[sender.id] += msg.n;
    },
  },
});

/** Global top 3 across every shard, pushed back into each shard as `top`. */
const arena = shardedRoom(arenaRoom, {
  shardSize: 2,
  aggregate: (shards) =>
    shards
      .flatMap(({ state }) => Object.entries(state.scores).map(([id, score]) => ({ name: state.names[id], score })))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 3),
  publish: ({ room, aggregate }) => {
    room.state.top = aggregate;
  },
});

function setup() {
  const clock = new FakeClock(0);
  const reg = new LocalRooms([arena], { clock });
  const join = (name: string, extra: Record<string, string> = {}) => {
    const s = fakeSocket();
    const params = { name, ...extra };
    const inst = reg.route("arena", "BIG", params)!;
    inst.connect(s, params);
    return { s, inst };
  };
  return { clock, reg, join };
}

const say = (p: { s: FakeSocket; inst: any }, type: string, data: unknown) => p.inst.receive(p.s, JSON.stringify({ t: "msg", type, data }));

test("shardedRoom keeps the room's type and caps each shard at shardSize", () => {
  expect(arena.type).toBe("arena");
  expect(arena.def.maxPlayers).toBe(2);
  expect(arena.shards.shardSize).toBe(2);
});

test("joins fill shard 0, then shard 1, ...; each shard is its own room id:shardN", () => {
  const { join } = setup();
  const ids = ["A", "B", "C", "D", "E"].map((n) => join(n).s.last("welcome").room.id);
  expect(ids).toEqual(["BIG:shard0", "BIG:shard0", "BIG:shard1", "BIG:shard1", "BIG:shard2"]);
});

test("a resume token routes back to the player's shard", () => {
  const { join, reg } = setup();
  join("A");
  join("B");
  const c = join("C");
  const token = c.s.last("welcome").resumeToken;
  expect(token.startsWith("s1.")).toBe(true);
  c.inst.disconnect(c.s);
  expect(reg.route("arena", "BIG", { resume: token })).toBe(c.inst);
});

test("spectators go to shard 0 and do not take seats", () => {
  const { join } = setup();
  join("A");
  join("B");
  expect(join("Tv", { role: "spectator" }).s.last("welcome").room.id).toBe("BIG:shard0");
  expect(join("C").s.last("welcome").room.id).toBe("BIG:shard1");
});

test("a seat freed in an earlier shard is filled first", () => {
  const { join, clock } = setup();
  const a = join("A");
  join("B");
  join("C");
  a.inst.disconnect(a.s);
  clock.advance(30_000); // A's grace ends
  expect(join("D").s.last("welcome").room.id).toBe("BIG:shard0");
});

test("the coordinator aggregates across shards and publishes the result into every shard", () => {
  const { join, reg } = setup();
  const a = join("Ann");
  join("Bob");
  const c = join("Cat"); // shard 1
  say(a, "score", { n: 5 });
  say(c, "score", { n: 9 });
  const expected = [
    { name: "Cat", score: 9 },
    { name: "Ann", score: 5 },
    { name: "Bob", score: 0 },
  ];
  expect(reg.aggregate("arena", "BIG")).toEqual(expected);
  expect(a.inst.room.state.top).toEqual(expected); // shard 0 sees Cat from shard 1
  expect(c.s.last("patch") ?? c.s.last("state")).toBeDefined();
  expect(c.inst.room.state.top).toEqual(expected);
});

test("a new shard gets the current aggregate as soon as it opens", () => {
  const { join } = setup();
  const a = join("Ann");
  join("Bob");
  say(a, "score", { n: 3 });
  const c = join("Cat");
  expect(c.inst.room.state.top[0]).toEqual({ name: "Ann", score: 3 });
});

test("createRoom data reaches every shard's init", () => {
  const { reg, join } = setup();
  reg.create("arena", "BIG", { title: "Finals" });
  join("A");
  join("B");
  const c = join("C");
  expect(c.inst.room.state.title).toBe("Finals");
});

test("route() on a plain room type is just open()", () => {
  const plain = defineRoom("plain", { state: t.object({}), init: () => ({}) });
  const reg = new LocalRooms([plain], { clock: new FakeClock() });
  expect(reg.route("plain", "X", { name: "A" })).toBe(reg.open("plain", "X"));
  expect(reg.route("nope", "X", {})).toBeNull();
});

test("end to end: the rooms plugin routes WebSocket joins across shards", async () => {
  const s = await miu({ plugins: [rooms({ rooms: [arena] })], logLevel: "silent" }).listen(0);
  try {
    const url = s.url.replace("http", "ws") + "rooms/arena/E2E";
    const ids: string[] = [];
    const clients = [];
    for (const name of ["A", "B", "C"]) {
      const c = connect(url, { name, reconnect: false });
      c.on("welcome", (w) => ids.push(w.room.id));
      await c.ready;
      clients.push(c);
    }
    expect(ids).toEqual(["E2E:shard0", "E2E:shard0", "E2E:shard1"]);
    for (const c of clients) c.close();
  } finally {
    await s.stop();
  }
});
