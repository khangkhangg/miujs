import { describe, expect, test } from "bun:test";
import { call, editor, jpegBytes, json, reader, seedTour, setup } from "./helpers.ts";

async function publishedTour(over: Record<string, unknown> = {}, opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  const seeded = await seedTour(ctx.app);
  const { tour, s1, s2 } = seeded;
  await call(ctx.app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "link", position: { yaw: 30, pitch: -10 }, targetSceneId: s2.id }, editor));
  await call(ctx.app, `/tours/${tour.id}/scenes/${s2.id}/hotspots`, json("POST", { kind: "info", position: { yaw: 0, pitch: 0 }, title: "Oven <b>", body: "**Gas** <script>alert(1)</script>" }, editor));
  await call(ctx.app, `/tours/${tour.id}/floorplans/0`, json("PUT", { title: "Ground", imageKey: "plans/ground.png", markers: [{ sceneId: s1.id, x: 0.25, y: 0.5 }] }, editor));
  await ctx.store.put("plans/ground.png", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]).stream(), { contentType: "image/png" });
  await call(ctx.app, `/tours/${tour.id}/scenes/${s1.id}/upload`, { method: "POST", headers: { "content-type": "image/jpeg", ...editor }, body: jpegBytes() });
  await ctx.q.drain();
  await call(ctx.app, `/tours/${tour.id}`, json("PATCH", { status: "published", visibility: "public", watermark: "Acme Realty", ...over }, editor));
  return { ...ctx, ...seeded };
}

const decode = (b64: string) => JSON.parse(atob(b64.replace(/-/g, "+").replace(/_/g, "/")));

describe("manifest", () => {
  test("a public tour's manifest has everything the viewer needs", async () => {
    const { app, tour, s1, s2 } = await publishedTour();
    const r = await call(app, `/tours/12-elm-st/manifest.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    const m = r.body;
    expect(m.version).toBe(1);
    expect(m.tour).toMatchObject({ id: tour.id, slug: "12-elm-st", title: "12 Elm St", watermark: "Acme Realty", startSceneId: s1.id, privacy: "standard" });
    expect(m.scenes.map((s: any) => s.id)).toEqual([s1.id, s2.id]);
    expect(m.scenes[1].initialView).toEqual({ yaw: 90, pitch: 0, fov: 70 });
    expect(m.scenes[0].hotspots[0]).toMatchObject({ kind: "link", position: { yaw: 30, pitch: -10 }, targetSceneId: s2.id });
    const info = m.scenes[1].hotspots[0];
    expect(info.title).toBe("Oven <b>");
    expect(info.bodyHtml).toBe("<p><strong>Gas</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(m.floorPlans[0]).toMatchObject({ floor: 0, title: "Ground", markers: [{ sceneId: s1.id, x: 0.25, y: 0.5 }] });
    expect(m.floorPlans[0].image.url).toStartWith("http://localhost/_files/");
    expect(m.analytics).toEqual({ url: "http://localhost/tours/12-elm-st/events" });
    expect(m.scenes[1].asset).toBeNull();
    expect(JSON.stringify(m)).not.toContain("sourceKey");
  });

  test("ready panoramas get a tile URL template that serves the tiles", async () => {
    const { app, store } = await publishedTour();
    const m = (await call(app, `/tours/12-elm-st/manifest.json`)).body;
    const a = m.scenes[0].asset;
    expect(a).toMatchObject({ status: "ready", progress: 1, layout: "cube", tileSize: 512, faceSize: 512, levels: [{ size: 512 }] });
    expect(a.tiles).toMatch(/^http:\/\/localhost\/_files\/p\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/\{level\}\/\{face\}\/\{row\}_\{col\}\.jpg$/);
    const tile = await app.request(a.tiles.replace("{level}", "0").replace("{face}", "f").replace("{row}", "0").replace("{col}", "0"));
    expect(tile.status).toBe(200);
    expect(tile.headers.get("content-type")).toBe("image/jpeg");
    expect(tile.headers.get("cache-control")).toStartWith("public, max-age=");
    expect(new Uint8Array(await tile.arrayBuffer())).toEqual(jpegBytes().slice(0, 4));
    const preview = await app.request(a.preview);
    expect(preview.status).toBe(200);
    expect((await store.list({ prefix: "tours/" })).files.length).toBeGreaterThan(6);
  });

  test("tile URLs reject traversal, other paths and forged tokens", async () => {
    const { app } = await publishedTour();
    const a = (await call(app, `/tours/12-elm-st/manifest.json`)).body.scenes[0].asset;
    const base = a.tiles.split("/{level}")[0];
    expect((await app.request(`${base}/0/f/0_0.jpg`)).status).toBe(200);
    expect((await app.request(`${base}/../../src/x.jpg`)).status).not.toBe(200);
    expect((await app.request(`${base}/..%2F..%2Fsrc%2Fx.jpg`)).status).toBe(400);
    expect((await app.request(`${base}/0/f/0_0.jpg.exe`)).status).toBe(404);
    expect((await app.request(`${base}/0/f/9_9.jpg`)).status).toBe(404);
    // Tiles are @miujs/files prefix URLs scoped to this run's output folder.
    expect(base).toMatch(/^http:\/\/localhost\/_files\/p\//);
    const [body, sig] = base.split("/_files/p/")[1].split(".");
    const forged = base.replace(`${body}.${sig}`, `${body}x.${sig}`);
    expect((await app.request(`${forged}/0/f/0_0.jpg`)).status).toBe(403);
  });

  test("public URLs are stable between requests, so they can be cached", async () => {
    const { app } = await publishedTour();
    const a = (await call(app, `/tours/12-elm-st/manifest.json`)).text;
    const b = (await call(app, `/tours/12-elm-st/manifest.json`)).text;
    expect(a).toBe(b);
  });

  test("unlisted tours get short-lived, uncached URLs", async () => {
    const { app } = await publishedTour({ visibility: "unlisted" });
    const r = await call(app, `/tours/12-elm-st/manifest.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const token = r.body.scenes[0].asset.tiles.split("/_files/p/")[1].split("/")[0];
    const exp = decode(token.split(".")[0]).e;
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
    const tile = await app.request(r.body.scenes[0].asset.tiles.replace("{level}", "0").replace("{face}", "f").replace("{row}", "0").replace("{col}", "0"));
    expect(tile.status).toBe(200);
    expect(tile.headers.get("cache-control")).toMatch(/^private, max-age=(\d+)$/);
    expect(Number(/max-age=(\d+)/.exec(tile.headers.get("cache-control")!)![1])).toBeLessThanOrEqual(600);
    const fileExp = decode(r.body.floorPlans[0].image.url.split("/_files/")[1].split(".")[0]).e;
    expect(fileExp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
  });

  test("drafts are hidden from viewers but previewable by editors", async () => {
    const { app } = await publishedTour({ status: "draft" });
    const anon = await call(app, `/tours/12-elm-st/manifest.json`);
    expect(anon.status).toBe(404);
    expect(anon.body.error.code).toBe("MIU_E_TOUR_NOT_FOUND");
    const preview = await call(app, `/tours/12-elm-st/manifest.json`, { headers: reader });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
  });

  test("editors of another org cannot preview", async () => {
    const { app } = await publishedTour({ status: "draft" });
    expect((await call(app, `/tours/12-elm-st/manifest.json`, { headers: { ...reader, "x-org": "org_x" } })).status).toBe(404);
  });
});

describe("private tours, share links and passwords", () => {
  test("a private tour needs a share link; links expire and can be revoked", async () => {
    let now = Date.now();
    const { app, tour } = await publishedTour({ visibility: "private" }, { now: () => now });
    const locked = await call(app, `/tours/12-elm-st/manifest.json`);
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe("MIU_E_TOUR_LOCKED");
    expect((await call(app, `/tours/${tour.id}/share`, json("POST", { expiresIn: 3600 }, reader))).status).toBe(403);
    const share = await call(app, `/tours/${tour.id}/share`, json("POST", { expiresIn: 3600 }, editor));
    expect(share.status).toBe(201);
    expect(share.body.url).toStartWith("http://localhost/tours/12-elm-st/view?share=");
    expect(share.body.expiresAt).toBe(Math.floor(now / 1000) + 3600);
    const ok = await call(app, `/tours/12-elm-st/manifest.json?share=${share.body.token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    now += 3601 * 1000;
    expect((await call(app, `/tours/12-elm-st/manifest.json?share=${share.body.token}`)).body.error.code).toBe("MIU_E_TOUR_TOKEN_EXPIRED");
    now -= 3601 * 1000;
    await call(app, `/tours/${tour.id}/share/revoke`, { method: "POST", headers: editor });
    expect((await call(app, `/tours/12-elm-st/manifest.json?share=${share.body.token}`)).body.error.code).toBe("MIU_E_TOUR_TOKEN_INVALID");
  });

  test("a share link for one tour does not open another", async () => {
    const { app, tour } = await publishedTour({ visibility: "private" });
    const other = (await call(app, "/tours", json("POST", { title: "B", slug: "b", status: "published", visibility: "private" }, editor))).body;
    const share = (await call(app, `/tours/${tour.id}/share`, json("POST", {}, editor))).body;
    expect((await call(app, `/tours/${other.slug}/manifest.json?share=${share.token}`)).status).toBe(403);
  });

  test("a password unlocks the tour with a cookie; changing it locks again", async () => {
    const { app, tour } = await publishedTour({ password: "hunter22" });
    expect((await call(app, `/tours/12-elm-st/manifest.json`)).status).toBe(401);
    const wrong = await call(app, `/tours/12-elm-st/unlock`, json("POST", { password: "nope" }));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe("MIU_E_TOUR_PASSWORD_WRONG");
    const right = await call(app, `/tours/12-elm-st/unlock`, json("POST", { password: "hunter22" }));
    expect(right.status).toBe(200);
    const setCookie = right.headers.get("set-cookie")!;
    expect(setCookie).toContain(`miu_tour_${tour.id}=`);
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0];
    const m = await call(app, `/tours/12-elm-st/manifest.json`, { headers: { cookie } });
    expect(m.status).toBe(200);
    expect(m.headers.get("cache-control")).toBe("private, no-store");
    await call(app, `/tours/${tour.id}`, json("PATCH", { password: "another1" }, editor));
    expect((await call(app, `/tours/12-elm-st/manifest.json`, { headers: { cookie } })).status).toBe(401);
  });

  test("password attempts are rate limited", async () => {
    const { app } = await publishedTour({ password: "hunter22" });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(app, `/tours/12-elm-st/unlock`, json("POST", { password: "nope" }))).status;
    expect(last).toBe(429);
  });
});
