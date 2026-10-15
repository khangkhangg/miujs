import { expect, test } from "bun:test";
import { setup } from "./helpers.ts";
import type { Hotspot } from "../../src/tour/index.ts";
import type { Repository } from "../../src/batteries/data/index.ts";

async function published(s: ReturnType<typeof setup>) {
  const { tour, scenes } = await s.seed("alice", 2);
  const api = s.as("alice");
  const link = (await (await api.post(`/api/scenes/${scenes[0]!.id}/hotspots`, { kind: "link", yaw: 10, pitch: 0, targetSceneId: scenes[1]!.id })).json()) as Hotspot;
  expect((await api.post(`/api/tours/${tour.id}/publish`)).status).toBe(200);
  return { tour, scenes, link, api };
}

const bundle = async (s: ReturnType<typeof setup>, slug: string) =>
  (await (await s.app.request(`/api/public/tours/${slug}`)).json()) as { hotspots: Hotspot[]; scenes: { title: string }[] };

test("repeat public bundle requests do not re-query scenes and hotspots", async () => {
  const s = setup();
  const { tour } = await published(s);
  let lists = 0;
  const spy = <T extends { id: string }>(repo: Repository<T>) => {
    const inner = repo.list.bind(repo);
    repo.list = (q) => (lists++, inner(q));
  };
  spy(s.scenes);
  spy(s.hotspots);
  await bundle(s, tour.slug);
  const afterFirst = lists;
  await bundle(s, tour.slug);
  await bundle(s, tour.slug);
  expect(afterFirst).toBe(2);
  expect(lists).toBe(2);
});

test("edits through the kit show up in the public bundle immediately", async () => {
  const s = setup();
  const { tour, link, api } = await published(s);
  expect((await bundle(s, tour.slug)).hotspots[0]!.yaw).toBe(10);
  expect((await api.patch(`/api/hotspots/${link.id}`, { yaw: 42 })).status).toBe(200);
  expect((await bundle(s, tour.slug)).hotspots[0]!.yaw).toBe(42);
});

test("writes that bypass the kit appear within bundleCacheMs", async () => {
  const s = setup({ bundleCacheMs: 30 });
  const { tour, scenes } = await published(s);
  expect((await bundle(s, tour.slug)).scenes[0]!.title).toBe("Room 1");
  await s.scenes.update(scenes[0]!.id, { title: "Renamed directly" });
  await Bun.sleep(40);
  expect((await bundle(s, tour.slug)).scenes[0]!.title).toBe("Renamed directly");
});
