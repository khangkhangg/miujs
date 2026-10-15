import { expect, test } from "bun:test";
import { miu, validate, type Context, type ManageAction, type ManageSection } from "miujs";
import { sqlite } from "@miujs/db";
import { FakeClock, rooms, t } from "@miujs/realtime";
import { createMatchmakerDurableObject } from "../src/cloudflare.ts";
import { leaderboard } from "../src/leaderboard.ts";
import { matchmaker } from "../src/matchmaker.ts";
import { gameRoom, reportResult } from "../src/room.ts";
import { GameStore } from "../src/store.ts";
import { as, settle, testAuth } from "./helpers.ts";

const SECRET = "manage-secret-0123456789abcdef";
const local = { runtime: "bun", env: {} } as unknown as Context;

function action(actions: ManageAction[] | undefined, name: string): ManageAction {
  const a = actions?.find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
}

// ---- matchmaker ----------------------------------------------------------------------------------

function mmSetup() {
  const clock = new FakeClock(100_000);
  const db = sqlite(":memory:");
  const duel = gameRoom("mduel", { state: t.object({ ok: t.boolean() }), init: () => ({ ok: true }) }, { secret: SECRET });
  const realtime = rooms({ rooms: [duel], clock });
  const mm = matchmaker({
    rooms: realtime,
    secret: SECRET,
    database: db,
    clock,
    queues: {
      ranked: { room: "mduel", teamSize: 1, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000 },
      casual: { room: "mduel", teamSize: 1, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 60_000 },
    },
  });
  const app = miu({ plugins: [testAuth(), realtime, mm], logLevel: "silent" });
  const store = new GameStore(db, { clock });
  const join = (queue: string, user: string) => app.request(`/match/${queue}/join`, as(user, { method: "POST", body: "{}" }));
  const [section] = mm.manage() as ManageSection[];
  return { clock, app, mm, realtime, store, join, section, list: section.lists![0] };
}

/** Three players too far apart in rating to match: they all wait. */
async function threeWaiting(s: ReturnType<typeof mmSetup>) {
  await s.store.setRating("lo", "ranked", 1000);
  await s.store.setRating("mid", "ranked", 1800);
  await s.store.setRating("hi", "ranked", 2600);
  await s.join("ranked", "lo:Lo");
  s.clock.advance(1_000);
  await s.join("ranked", "mid:Mid");
  s.clock.advance(1_000);
  await s.join("ranked", "hi:Hi");
}

test("matchmaker manage(): one 'matchmaking' section with status, a queue list, settings and actions", () => {
  const { section, list } = mmSetup();
  expect(section.id).toBe("matchmaking");
  expect(list.name).toBe("queue");
  expect(list.rowActions!.map((a) => a.name)).toEqual(["remove"]);
  expect(section.actions!.map((a) => a.name)).toEqual(["closeFinishedRooms"]);
  expect(action(section.actions, "closeFinishedRooms").danger).toBe(true);
  expect(section.settings).toBeTruthy();
});

test("status: waiting players, wait times, matches in the last minute and long-polls in flight", async () => {
  const s = mmSetup();
  await threeWaiting(s);
  s.clock.advance(1_000);
  // Two casual players match at once.
  await s.join("casual", "c1");
  await s.join("casual", "c2");
  await settle();
  const poll = s.app.request("/match/ranked/status?wait=20000", as("lo"));
  await settle();
  const st = await s.section.status!(local);
  const stat = (label: string) => st.stats!.find((x) => x.label === label)!;
  expect(stat("Waiting players").value).toBe(3);
  expect(stat("Matches in the last minute").value).toBe(1);
  expect(stat("Long-polls in flight").value).toBe(1);
  expect(stat("Live game rooms").value).toBe(1);
  const queues = st.tables!.find((x) => x.title === "Queues")!;
  expect(queues.rows).toEqual([
    { queue: "ranked", room: "mduel", waiting: 3, oldestWaitMs: 3_000, avgWaitMs: 2_000, matchesLastMinute: 0 },
    { queue: "casual", room: "mduel", waiting: 0, oldestWaitMs: 0, avgWaitMs: 0, matchesLastMinute: 1 },
  ]);
  s.clock.advance(61_000);
  const later = await s.section.status!(local);
  expect(later.tables![0].rows[1].matchesLastMinute).toBe(0);
  s.mm.stop();
  await poll;
});

test("the queue list pages, filters by queue, searches and never shows tickets", async () => {
  const s = mmSetup();
  await threeWaiting(s);
  await s.join("casual", "solo:Solo");
  const p1 = await s.list.list({ limit: 2 }, local);
  expect(p1.rows.map((r) => r.entry)).toEqual(["ranked:lo", "ranked:mid"]);
  expect(p1.rows[0]).toMatchObject({ queue: "ranked", userId: "lo", name: "lo", rating: 1000, waitedMs: 2_000, window: 100 });
  const p2 = await s.list.list({ limit: 2, cursor: p1.next }, local);
  expect(p2.rows.map((r) => r.entry)).toEqual(["ranked:hi", "casual:solo"]);
  expect(p2.next).toBeUndefined();
  expect((await s.list.list({ limit: 10, filters: { queue: "casual" } }, local)).rows.map((r) => r.userId)).toEqual(["solo"]);
  expect((await s.list.list({ limit: 10, search: "mi" }, local)).rows.map((r) => r.userId)).toEqual(["mid"]);
  expect(JSON.stringify([...p1.rows, ...p2.rows])).not.toMatch(/ticket/i);
});

test("row action remove takes a player out of the queue; again is a no-op", async () => {
  const s = mmSetup();
  await threeWaiting(s);
  const remove = action(s.list.rowActions, "remove");
  expect(String(await remove.run({ id: "ranked:mid" }, local))).toContain("Removed");
  expect((await s.list.list({ limit: 10 }, local)).rows.map((r) => r.userId)).toEqual(["lo", "hi"]);
  expect(String(await remove.run({ id: "ranked:mid" }, local))).toContain("not waiting");
  await expect(Promise.resolve().then(() => remove.run({ id: "nope:mid" }, local))).rejects.toMatchObject({ code: "MIU_E_GAME_QUEUE_UNKNOWN" });
});

test("settings: queue tuning and closeAfterResultMs are read, validated and applied at runtime", async () => {
  const s = mmSetup();
  const settings = s.section.settings!;
  const now = await settings.get(local);
  expect(now.queues.ranked).toEqual({ widenAfterMs: 5_000, maxWaitMs: 60_000, initialWindow: 100, widenBy: 100, maxWindow: null });
  expect(now.closeAfterResultMs).toEqual({ mduel: 5_000 });
  expect(validate(settings.schema, { ...now, queues: { ...now.queues, ranked: { ...now.queues.ranked, maxWaitMs: -1 } } }).ok).toBe(false);
  expect(validate(settings.schema, { ...now, queues: { ...now.queues, ranked: { ...now.queues.ranked, widenAfterMs: 0 } } }).ok).toBe(false);
  expect(validate(settings.schema, { ...now, closeAfterResultMs: { mduel: -5 } }).ok).toBe(false);
  expect(validate(settings.schema, now).ok).toBe(true);

  // Two players 800 apart wait...
  await s.store.setRating("lo", "ranked", 1000);
  await s.store.setRating("mid", "ranked", 1800);
  await s.join("ranked", "lo");
  expect((await (await s.join("ranked", "mid")).json()).status.state).toBe("queued");
  // ...until the window is widened: matching re-runs at once.
  await settings.set({ ...now, queues: { ...now.queues, ranked: { ...now.queues.ranked, initialWindow: 1_000, maxWaitMs: 10_000 } } }, local);
  expect((await settings.get(local)).queues.ranked).toMatchObject({ initialWindow: 1_000, maxWaitMs: 10_000 });
  const res = await (await s.app.request("/match/ranked/status", as("mid"))).json();
  expect(res.status.state).toMatch(/matching|matched/);
  s.mm.stop();
});

test("closeFinishedRooms closes rooms whose result was reported and leaves live games alone", async () => {
  const s = mmSetup();
  const settingsNow = await s.section.settings!.get(local);
  await s.section.settings!.set({ ...settingsNow, closeAfterResultMs: { mduel: false } }, local);
  await s.join("casual", "a");
  await s.join("casual", "b");
  await settle();
  await s.join("ranked", "c");
  await s.join("ranked", "d");
  await settle();
  const live = [...s.realtime.registry.instances()];
  expect(live.length).toBe(2);
  // Winners must be rostered user ids.
  const roster = (live[0].room.secret as any).__game.match.players.map((p: any) => p.userId);
  await reportResult(live[0].room, { winners: [roster[0]] });
  const close = action(s.section.actions, "closeFinishedRooms");
  expect(String(await close.run({}, local))).toContain("Closed 1");
  expect(live[0].isClosed).toBe(true);
  expect(live[1].isClosed).toBe(false);
  expect(String(await close.run({}, local))).toContain("Closed 0");
  await s.section.settings!.set(settingsNow, local);
  s.mm.stop();
});

test("on Workers, status, the queue list, remove and settings go to each queue's Durable Object", async () => {
  const s = mmSetup();
  const MiuMatchmaker = createMatchmakerDurableObject(s.mm, { clock: s.clock });
  const objects = new Map<string, InstanceType<typeof MiuMatchmaker>>();
  const states = new Map<string, unknown>();
  const env: Record<string, unknown> = {};
  const ns = {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      const name = String(id);
      if (!objects.has(name)) {
        const data = new Map<string, unknown>();
        const st = {
          acceptWebSocket() {},
          getWebSockets: () => [],
          storage: { get: async (k: string) => structuredClone(data.get(k)), put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)), delete: async (k: string) => data.delete(k) },
        };
        states.set(name, st);
        objects.set(name, new MiuMatchmaker(st as any, env));
      }
      return objects.get(name)!;
    },
  };
  env.MIU_MATCH = ns;
  const ctx = { runtime: "workerd", env } as unknown as Context;
  const call = (queue: string, op: string, body: unknown) =>
    ns.get(ns.idFromName(`match:${queue}`)).fetch(new Request(`https://miu-match/_miu/match/${op}?queue=${queue}`, { method: "POST", body: JSON.stringify(body) }));
  await call("ranked", "join", { userId: "lo", name: "lo", rating: 1000 });
  s.clock.advance(2_000);
  await call("ranked", "join", { userId: "hi", name: "Hi", rating: 2000 });

  const st = await s.section.status!(ctx);
  expect(st.stats!.find((x) => x.label === "Waiting players")!.value).toBe(2);
  expect(st.stats!.find((x) => x.label === "Live game rooms")!.value).toBeNull();
  expect(st.tables![0].rows[0]).toMatchObject({ queue: "ranked", waiting: 2, oldestWaitMs: 2_000, avgWaitMs: 1_000 });

  const rows = (await s.list.list({ limit: 10 }, ctx)).rows;
  expect(rows.map((r) => r.entry)).toEqual(["ranked:lo", "ranked:hi"]);
  expect(String(await action(s.list.rowActions, "remove").run({ id: "ranked:lo" }, ctx))).toContain("Removed");
  expect((await s.list.list({ limit: 10 }, ctx)).rows.map((r) => r.entry)).toEqual(["ranked:hi"]);

  const now = await s.section.settings!.get(ctx);
  await s.section.settings!.set({ ...now, queues: { ...now.queues, ranked: { ...now.queues.ranked, initialWindow: 5_000 } } }, ctx);
  expect((await s.section.settings!.get(ctx)).queues.ranked.initialWindow).toBe(5_000);
  // The object applies it to its queue: the waiting player now matches a far rating.
  const res = await (await call("ranked", "join", { userId: "x", name: "X", rating: 6000 })).json();
  expect(res.ok.state).toMatch(/matching|matched/);
  // A fresh object (after eviction) keeps the override from storage.
  const fresh = new MiuMatchmaker(states.get("match:ranked") as any, env);
  const info = await (await fresh.fetch(new Request("https://miu-match/_miu/match/inspect?queue=ranked", { method: "POST", body: "{}" }))).json();
  expect(info.ok.tuning.initialWindow).toBe(5_000);
  s.mm.stop();
});

// ---- leaderboards --------------------------------------------------------------------------------

function lbSetup() {
  const clock = new FakeClock(Date.parse("2026-10-15T12:00:00Z"));
  const db = sqlite(":memory:");
  const lb = leaderboard({ id: "wins", sort: "desc", resets: "weekly", database: db, clock, maxScore: 1_000, clientSubmit: { secret: "client-secret-0123456789-abcdef" } });
  const [section] = lb.manage() as ManageSection[];
  return { clock, lb, section, list: section.lists![0], db };
}

test("leaderboard manage(): status shows the period, entry count and top score", async () => {
  const { lb, section } = lbSetup();
  expect(section.id).toBe("leaderboard");
  await lb.submit("a", 50);
  await lb.submit("b", 70);
  const st = await section.status!(local);
  const stat = (label: string) => st.stats!.find((x) => x.label === label)!;
  expect(stat("Current period").value).toBe("2026-W42");
  expect(stat("Entries this period").value).toBe(2);
  expect(stat("Top score").value).toBe(70);
  expect(JSON.stringify(st)).not.toContain("client-secret");
});

test("leaderboard entries list pages in rank order with shared ranks and searches by player", async () => {
  const { lb, list, clock } = lbSetup();
  await lb.submit("a", 50);
  clock.advance(1);
  await lb.submit("b", 70);
  clock.advance(1);
  await lb.submit("c", 70);
  const p1 = await list.list({ limit: 2 }, local);
  expect(p1.rows.map((r) => [r.rank, r.playerId, r.score])).toEqual([
    [1, "b", 70],
    [1, "c", 70],
  ]);
  const p2 = await list.list({ limit: 2, cursor: p1.next }, local);
  expect(p2.rows.map((r) => [r.rank, r.playerId])).toEqual([[3, "a"]]);
  expect(p2.next).toBeUndefined();
  expect((await list.list({ limit: 10, search: "c" }, local)).rows.map((r) => r.playerId)).toEqual(["c"]);
  expect((await list.list({ limit: 500 }, local)).rows.length).toBe(3);
});

test("leaderboard row action remove deletes one entry (danger, idempotent)", async () => {
  const { lb, list } = lbSetup();
  await lb.submit("a", 50);
  await lb.submit("b", 70);
  const remove = action(list.rowActions, "remove");
  expect(remove.danger).toBe(true);
  expect(String(await remove.run({ id: "b" }, local))).toContain("Removed");
  expect(await lb.rank("b")).toBeNull();
  expect(await lb.rank("a")).toMatchObject({ rank: 1 });
  expect(String(await remove.run({ id: "b" }, local))).toContain("no entry");
});

test("leaderboard action reset clears a period (current by default) and validates the period", async () => {
  const { lb, section, clock } = lbSetup();
  await lb.submit("a", 50);
  clock.advance(7 * 86_400_000);
  await lb.submit("b", 70); // next week
  const reset = action(section.actions, "reset");
  expect(reset.danger).toBe(true);
  expect(validate(reset.input!, { period: "'; DROP TABLE x" }).ok).toBe(false);
  expect(validate(reset.input!, {}).ok).toBe(true);
  expect(String(await reset.run({ period: "2026-W42" }, local))).toContain("Removed 1");
  expect(await lb.top(10, { period: "2026-W42" })).toEqual([]);
  expect(String(await reset.run({}, local))).toContain("Removed 1");
  expect(await lb.top(10)).toEqual([]);
  expect(String(await reset.run({}, local))).toContain("Removed 0");
});
