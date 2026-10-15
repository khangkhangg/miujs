import { describe, expect, test } from "bun:test";
import { FakeClock, createRoomInstance, rooms } from "@miujs/realtime";
import { guidedTour } from "../src/index.ts";
import { call, editor, fakeSocket, json, seedTour, setup, type FakeSocket } from "./helpers.ts";

function room(token = "guide-secret-token") {
  const clock = new FakeClock(10_000);
  const inst = createRoomInstance(guidedTour, { id: "R1", clock, data: { tourId: "tour_1", guideToken: token }, hooks: { onError: () => {} } });
  const msg = (s: FakeSocket, type: string, data: unknown = {}) => inst.receive(s, JSON.stringify({ t: "msg", type, data }));
  const join = (name: string, role: string) => {
    const s = fakeSocket();
    inst.connect(s, { name, role });
    return s;
  };
  return { clock, inst, msg, join };
}

const events = (s: FakeSocket, name: string) => s.frames.filter((f) => f.t === "event" && f.event === name);
const cam = (yaw: number) => ({ scene: "scn_a", yaw, pitch: 0, fov: 70 });

describe("guidedTour room", () => {
  test("the guide claims with the token and becomes host; followers learn who guides", async () => {
    const { inst, msg, join } = room();
    const guide = join("Ann", "player");
    const f1 = join("Bob", "spectator");
    await msg(guide, "claim", { token: "guide-secret-token" });
    expect(inst.room.state.guide).toEqual({ id: guide.last("welcome").me.id, name: "Ann" });
    expect(inst.room.player(guide.last("welcome").me.id)!.role).toBe("host");
    expect(f1.last("event", "guide").data).toMatchObject({ name: "Ann", followers: 1 });
  });

  test("a wrong token is refused and a host who never claimed has no guide powers", async () => {
    const { inst, msg, join } = room();
    const impostor = join("Eve", "player"); // first non-spectator: host by the engine's rule
    const f1 = join("Bob", "spectator");
    await msg(impostor, "claim", { token: "nope" });
    expect(impostor.last("error").code).toBe("MIU_E_TOUR_GUIDE_TOKEN");
    await msg(impostor, "camera", cam(10));
    expect(impostor.last("error").code).toBe("MIU_E_TOUR_GUIDE_ONLY");
    expect(events(f1, "camera")).toEqual([]);
    // The real guide claims later and the impostor loses the host seat.
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    expect(inst.room.player(impostor.last("welcome").me.id)!.role).toBe("spectator");
    expect(inst.room.state.guide!.name).toBe("Ann");
  });

  test("followers cannot drive the camera, point or end the tour", async () => {
    const { msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    const f1 = join("Bob", "spectator");
    for (const type of ["camera", "pointer", "end"]) {
      await msg(f1, type, type === "end" ? {} : cam(1));
      expect(f1.last("error").code).toBe("MIU_E_TOUR_GUIDE_ONLY");
    }
  });

  test("the camera reaches followers at most 10 times a second, latest value last", async () => {
    const { clock, inst, msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    const f1 = join("Bob", "spectator");
    for (let i = 0; i < 10; i++) {
      await msg(guide, "camera", cam(i));
      clock.advance(10);
    }
    // t=+100ms: one immediate update, one flushed with the latest value.
    clock.advance(10);
    const got = events(f1, "camera").map((e) => e.data.yaw);
    expect(got).toEqual([0, 9]);
    expect(inst.room.state.camera).toMatchObject({ scene: "scn_a", yaw: 9 });
    expect(events(guide, "camera")).toEqual([]);
  });

  test("the room rate limit drops floods from any client", async () => {
    const { msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    for (let i = 0; i < 40; i++) await msg(guide, "camera", cam(i));
    expect(guide.frames.some((f) => f.t === "error" && f.code === "MIU_E_ROOM_RATE_LIMITED")).toBe(true);
  });

  test("late joiners get the current camera; sync re-sends it", async () => {
    const { msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    await msg(guide, "camera", cam(42));
    const late = join("Cat", "spectator");
    expect(late.last("event", "camera").data).toMatchObject({ yaw: 42 });
    late.take();
    await msg(late, "sync");
    expect(late.last("event", "camera").data).toMatchObject({ yaw: 42 });
  });

  test("raise hand queue: followers raise and lower; the guide sees the queue and answers", async () => {
    const { inst, msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    const bob = join("Bob", "spectator");
    const cat = join("Cat", "spectator");
    await msg(bob, "raise");
    await msg(cat, "raise");
    await msg(bob, "raise");
    expect(guide.last("event", "hands").data.map((h: any) => h.name)).toEqual(["Bob", "Cat"]);
    await msg(cat, "lower");
    expect(guide.last("event", "hands").data.map((h: any) => h.name)).toEqual(["Bob"]);
    const bobId = bob.last("welcome").me.id;
    await msg(guide, "ack", { playerId: bobId });
    expect(bob.last("event", "handAck")).toBeDefined();
    expect(inst.room.state.hands).toEqual([]);
    expect(events(cat, "hands")).toEqual([]);
  });

  test("pointer highlights go to followers; ending closes the room", async () => {
    const { inst, msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    const bob = join("Bob", "spectator");
    await msg(guide, "pointer", { scene: "scn_a", yaw: 12, pitch: -3 });
    expect(bob.last("event", "pointer").data).toEqual({ scene: "scn_a", yaw: 12, pitch: -3 });
    await msg(guide, "end");
    expect(bob.last("event", "ended")).toBeDefined();
    expect(inst.isClosed).toBe(true);
  });

  test("camera values are validated", async () => {
    const { msg, join } = room();
    const guide = join("Ann", "player");
    await msg(guide, "claim", { token: "guide-secret-token" });
    await msg(guide, "camera", { scene: "scn_a", yaw: 999, pitch: 0, fov: 70 });
    expect(guide.last("error").code).toBe("MIU_E_ROOM_MESSAGE_INVALID");
  });
});

describe("POST /tours/:tour/live", () => {
  test("creates a room with a join code and guide/follow links", async () => {
    const live = rooms({ rooms: [guidedTour] });
    const { app } = setup({ live, plugins: [live] });
    const { tour } = await seedTour(app);
    await call(app, `/tours/${tour.id}`, json("PATCH", { status: "published", visibility: "public" }, editor));
    expect((await call(app, `/tours/${tour.id}/live`, { method: "POST", headers: { "x-perms": "tours:read" } })).status).toBe(403);
    const r = await call(app, `/tours/${tour.id}/live`, { method: "POST", headers: editor });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^\d{6}$/);
    expect(r.body.followUrl).toBe(`http://localhost/tours/12-elm-st/view?live=${r.body.code}`);
    expect(r.body.guideUrl).toStartWith(`http://localhost/tours/12-elm-st/view?live=${r.body.code}#guide=`);
    const resolved = await call(app, `/rooms/code/${r.body.code}`);
    expect(resolved.body).toEqual({ type: "guidedTour", id: r.body.roomId });
    // The token in the guide link claims the room.
    const inst = live.registry.open("guidedTour", r.body.roomId)!;
    const s = fakeSocket();
    inst.connect(s, { name: "Ann", role: "player" });
    await inst.receive(s, JSON.stringify({ t: "msg", type: "claim", data: { token: r.body.guideUrl.split("#guide=")[1] } }));
    expect(inst.room.state.guide?.name).toBe("Ann");
  });

  test("private tours get a share link in the follow URL", async () => {
    const live = rooms({ rooms: [guidedTour] });
    const { app } = setup({ live, plugins: [live] });
    const { tour } = await seedTour(app);
    await call(app, `/tours/${tour.id}`, json("PATCH", { status: "published", visibility: "private" }, editor));
    const r = await call(app, `/tours/${tour.id}/live`, { method: "POST", headers: editor });
    const url = new URL(r.body.followUrl);
    expect(url.searchParams.get("share")).toBeString();
    expect((await call(app, `/tours/12-elm-st/manifest.json?share=${url.searchParams.get("share")}`)).status).toBe(200);
  });

  test("without the rooms plugin the error says what to add", async () => {
    const { app } = setup();
    const { tour } = await seedTour(app);
    const r = await call(app, `/tours/${tour.id}/live`, { method: "POST", headers: editor });
    expect(r.body.error.code).toBe("MIU_E_TOUR_LIVE_MISSING");
  });
});
