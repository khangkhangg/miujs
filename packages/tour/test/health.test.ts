// Memory and exit health of the tour package: analytics beacon bursts, live guided-tour rooms
// and manifest generation. Each leak check runs many requests with forced GC and fails if live
// memory keeps growing after warm-up.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sqlite } from "@miujs/db";
import { FakeClock, rooms } from "@miujs/realtime";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { guidedTour } from "../src/index.ts";
import { call, editor, fakeSocket, json, seedTour, setup } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");
const SID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

async function published(opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup({ database: sqlite(":memory:"), trustProxy: { header: "x-real-ip" }, analytics: { perMinute: 1e6, burst: 1e6 }, ...opts });
  const seeded = await seedTour(ctx.app);
  const { tour, s1 } = seeded;
  const hs = (await call(ctx.app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "info", title: "Oven", position: { yaw: 1, pitch: 1 } }, editor))).body;
  await call(ctx.app, `/tours/${tour.id}`, json("PATCH", { status: "published", visibility: "public" }, editor));
  return { ...ctx, ...seeded, hs };
}

describe("tour does not leak", () => {
  test("analytics beacon bursts from many visitors", async () => {
    const { app, s1, hs } = await published();
    const body = JSON.stringify({ sessionId: SID, events: [{ type: "view" }, { type: "scene", sceneId: s1.id, dwellMs: 1200 }, { type: "hotspot", sceneId: s1.id, hotspotId: hs.id }] });
    const r = await leakCheck("analytics beacons", async (i) => {
      const res = await app.request("/tours/12-elm-st/events", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `203.0.${i % 200}.7` }, body });
      if (res.status !== 204) throw new Error(`beacon: ${res.status} ${await res.text()}`);
    }, { warmup: 500, perRound: 1500, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("manifest generation", async () => {
    const { app } = await published();
    const r = await leakCheck("manifest", async () => {
      const res = await app.request("/tours/12-elm-st/manifest.json");
      if (res.status !== 200) throw new Error(`manifest: ${res.status}`);
      await res.arrayBuffer();
    }, { warmup: 500, perRound: 1500, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
  }, 120_000);

  test("live guided tours: start, guide + follower, camera burst, end, disposal", async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 14, 12));
    const live = rooms({ rooms: [guidedTour], clock, emptyMs: 1_000 });
    const { app, tour } = await published({ live, plugins: [live] });
    const r = await leakCheck("live tours", async (i) => {
      const started = await call(app, `/tours/${tour.id}/live`, json("POST", {}, editor));
      if (started.status !== 201) throw new Error(`live: ${started.text}`);
      const token = String(started.body.guideUrl).split("#guide=")[1];
      const inst = live.registry.get("guidedTour", started.body.roomId)!;
      const g = fakeSocket();
      const f = fakeSocket();
      g.send = f.send = () => {};
      inst.connect(g, { name: "Guide", params: { guide: token } });
      inst.connect(f, { name: "Fan", role: "spectator" });
      for (let k = 0; k < 5; k++) inst.receive(g, JSON.stringify({ t: "msg", type: "camera", data: { scene: "a", yaw: k + i, pitch: 0, fov: 70 } }));
      clock.advance(200);
      if (i % 2) inst.receive(g, JSON.stringify({ t: "msg", type: "end", data: {} }));
      live.registry.disconnected(inst, g);
      live.registry.disconnected(inst, f);
      clock.advance(31_000); // reconnect grace
      clock.advance(1_000); // emptyMs
    }, { warmup: 300, perRound: 1000, rounds: 5 });
    expect(r.leaking, describeLeak(r)).toBe(false);
    expect(live.registry.list()).toEqual([]);
    expect(clock.pending).toBe(0);
  }, 120_000);
});

describe("tour lets the process exit", () => {
  test("an app with the tour and live rooms plugins, after ready() and a live room", async () => {
    const r = await exitCheck(`
      import { miu } from "miujs";
      import { sqlite } from "@miujs/db";
      import { rooms } from "@miujs/realtime";
      import { guidedTour, tour } from "../src/index.ts";
      const live = rooms({ rooms: [guidedTour] });
      const tours = tour({ database: sqlite(":memory:"), secret: "${"x".repeat(40)}", live });
      const app = miu({ logLevel: "silent", plugins: [live, tours] });
      await app.ready();
      await live.createRoom(guidedTour.type, { data: { tourId: "t1", guideToken: "tok" } });
      await (await app.request("/tours/nope/manifest.json")).text();
    `, 3000, PKG);
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 10_000);
});
