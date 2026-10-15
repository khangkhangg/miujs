import { describe, expect, test } from "bun:test";
import { sqlite } from "@miujs/db";
import { call, editor, json, reader, seedTour, setup } from "./helpers.ts";

const T0 = Date.UTC(2026, 9, 14, 12);
const SID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

async function published(over: Record<string, unknown> = {}, opts: Parameters<typeof setup>[0] = {}) {
  const clock = { now: T0 };
  const database = sqlite(":memory:");
  const ctx = setup({ now: () => clock.now, database, trustProxy: { header: "x-real-ip" }, ...opts });
  const seeded = await seedTour(ctx.app);
  const { tour, s1 } = seeded;
  const hs = (await call(ctx.app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "info", title: "Oven", position: { yaw: 1, pitch: 1 } }, editor))).body;
  await call(ctx.app, `/tours/${tour.id}`, json("PATCH", { status: "published", visibility: "public", ...over }, editor));
  return { ...ctx, ...seeded, hs, clock, database };
}

function beacon(body: unknown, ip = "203.0.113.77", type = "application/json"): RequestInit {
  return { method: "POST", headers: { "content-type": type, "x-real-ip": ip }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("POST /tours/:tour/events", () => {
  test("stores events without PII; the IP is truncated", async () => {
    const { app, s1, hs, database } = await published();
    const r = await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }, { type: "scene", sceneId: s1.id, dwellMs: 4200 }, { type: "hotspot", sceneId: s1.id, hotspotId: hs.id }] }));
    expect(r.status).toBe(204);
    const { results } = await database.prepare("SELECT day, session_id, type, scene_id, hotspot_id, dwell_ms, ip_prefix FROM miu_tour_events ORDER BY rowid").all<any>();
    expect(results).toEqual([
      { day: "2026-10-14", session_id: SID, type: "view", scene_id: null, hotspot_id: null, dwell_ms: null, ip_prefix: "203.0.113.0/24" },
      { day: "2026-10-14", session_id: SID, type: "scene", scene_id: s1.id, hotspot_id: null, dwell_ms: 4200, ip_prefix: "203.0.113.0/24" },
      { day: "2026-10-14", session_id: SID, type: "hotspot", scene_id: s1.id, hotspot_id: hs.id, dwell_ms: null, ip_prefix: "203.0.113.0/24" },
    ]);
  });

  test('privacy "strict" stores no IP at all', async () => {
    const { app, database } = await published({ privacy: "strict" });
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }, "2001:db8:1234:5678::1"));
    expect(await database.prepare("SELECT ip_prefix FROM miu_tour_events").first("ip_prefix")).toBeNull();
  });

  test("IPv6 is truncated to /48", async () => {
    const { app, database } = await published();
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }, "2001:db8:1234:5678::1"));
    expect(await database.prepare("SELECT ip_prefix FROM miu_tour_events").first("ip_prefix")).toBe("2001:db8:1234::/48");
  });

  test("sendBeacon's text/plain bodies are accepted", async () => {
    const { app } = await published();
    expect((await call(app, "/tours/12-elm-st/events", beacon(JSON.stringify({ sessionId: SID, events: [{ type: "view" }] }), undefined, "text/plain;charset=UTF-8"))).status).toBe(204);
  });

  test("session ids must be random tokens, not emails or names", async () => {
    const { app } = await published();
    for (const sessionId of ["me@example.com", "short", "x".repeat(200)]) {
      expect((await call(app, "/tours/12-elm-st/events", beacon({ sessionId, events: [{ type: "view" }] }))).status).toBe(400);
    }
  });

  test("batches are capped, unknown ids are dropped, dwell is clamped", async () => {
    const { app, s1, database } = await published();
    expect((await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: Array.from({ length: 51 }, () => ({ type: "view" })) }))).status).toBe(400);
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "scene", sceneId: "scn_other" }, { type: "hotspot", sceneId: s1.id, hotspotId: "hs_other" }, { type: "scene", sceneId: s1.id, dwellMs: 99_999_999 }] }));
    const { results } = await database.prepare("SELECT type, scene_id, dwell_ms FROM miu_tour_events").all<any>();
    expect(results).toEqual([{ type: "scene", scene_id: s1.id, dwell_ms: 6 * 3600 * 1000 }]);
  });

  test("rate limited per client", async () => {
    const { app } = await published({}, { analytics: { perMinute: 6, burst: 3 } });
    const send = () => call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }));
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(204);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("MIU_E_TOUR_RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toBe("10");
    expect((await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }, "198.51.100.1"))).status).toBe(204);
  });

  test("drafts and protected tours do not take anonymous events", async () => {
    const draft = await published({ status: "draft" });
    expect((await call(draft.app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }))).status).toBe(404);
    const priv = await published({ visibility: "private" });
    expect((await call(priv.app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }))).status).toBe(401);
    const share = (await call(priv.app, `/tours/${priv.tour.id}/share`, json("POST", {}, editor))).body;
    expect((await call(priv.app, `/tours/12-elm-st/events?share=${share.token}`, beacon({ sessionId: SID, events: [{ type: "view" }] }))).status).toBe(204);
    const m = (await call(priv.app, `/tours/12-elm-st/manifest.json?share=${share.token}`)).body;
    expect(m.analytics.url).toBe(`http://localhost/tours/12-elm-st/events?share=${share.token}`);
  });

  test("analytics: false turns the route off and leaves it out of the manifest", async () => {
    const { app } = await published({}, { analytics: false });
    const r = await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("MIU_E_TOUR_ANALYTICS_DISABLED");
    expect((await call(app, "/tours/12-elm-st/manifest.json")).body.analytics).toBeNull();
  });
});

describe("GET /tours/:tour/stats", () => {
  test("daily views, unique sessions, average dwell per scene and top hotspots", async () => {
    const { app, tour, s1, s2, hs, clock } = await published();
    const other = "f".repeat(32);
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }, { type: "scene", sceneId: s1.id, dwellMs: 1000 }, { type: "scene", sceneId: s2.id, dwellMs: 3000 }, { type: "hotspot", sceneId: s1.id, hotspotId: hs.id }] }));
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: other, events: [{ type: "view" }, { type: "scene", sceneId: s1.id, dwellMs: 3000 }, { type: "hotspot", sceneId: s1.id, hotspotId: hs.id }] }, "198.51.100.2"));
    clock.now += 86_400_000;
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }, "198.51.100.3"));
    expect((await call(app, `/tours/${tour.id}/stats`)).status).toBe(401);
    const r = await call(app, `/tours/${tour.id}/stats?from=2026-10-01&to=2026-10-31`, { headers: reader });
    expect(r.status).toBe(200);
    expect(r.body.days).toEqual([
      { day: "2026-10-14", views: 2, sessions: 2 },
      { day: "2026-10-15", views: 1, sessions: 1 },
    ]);
    expect(r.body.totals).toEqual({ views: 3, sessions: 3 });
    expect(r.body.scenes).toEqual([
      { sceneId: s1.id, title: "Hall", views: 2, avgDwellMs: 2000 },
      { sceneId: s2.id, title: "Kitchen", views: 1, avgDwellMs: 3000 },
    ]);
    expect(r.body.hotspots).toEqual([{ hotspotId: hs.id, title: "Oven", clicks: 2 }]);
    const oneDay = await call(app, `/tours/${tour.id}/stats?from=2026-10-15&to=2026-10-15`, { headers: reader });
    expect(oneDay.body.totals).toEqual({ views: 1, sessions: 1 });
  });

  test("aggregation is idempotent and keeps totals after raw events are pruned", async () => {
    const { app, tour, plugin, clock, database } = await published({}, { analytics: { retentionDays: 30 } });
    await call(app, "/tours/12-elm-st/events", beacon({ sessionId: SID, events: [{ type: "view" }] }));
    await plugin.aggregate({});
    await plugin.aggregate({});
    clock.now += 40 * 86_400_000;
    const result = await plugin.aggregate({});
    expect(result.pruned).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) AS n FROM miu_tour_events").first("n")).toBe(0);
    const r = await call(app, `/tours/${tour.id}/stats?from=2026-10-01&to=2026-12-31`, { headers: reader });
    expect(r.body.days).toEqual([{ day: "2026-10-14", views: 1, sessions: 1 }]);
  });

  test("the aggregate job is registered with the queue", async () => {
    const { plugin, q } = await published();
    expect(plugin.jobs.all.map((j) => j.name)).toContain("tour-aggregate-stats");
    await q.drain();
  });

  test("bad ranges are rejected", async () => {
    const { app, tour } = await published();
    expect((await call(app, `/tours/${tour.id}/stats?from=2026-10-31&to=2026-10-01`, { headers: reader })).status).toBe(400);
    expect((await call(app, `/tours/${tour.id}/stats?from=yesterday`, { headers: reader })).status).toBe(400);
  });
});
