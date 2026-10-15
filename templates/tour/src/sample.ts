import type { Tour } from "miujs/tour";
import type { Data } from "./data.ts";
import { makePanorama, SAMPLE_ROOMS } from "./panorama.ts";

/**
 * Create (once) and publish "Sample house": three rooms with generated 2:1 panoramas, linked by hotspots.
 * Returns the existing tour when the slug is already taken.
 */
export async function seedSampleTour(data: Data, ownerId: string, opts: { width?: number; slug?: string } = {}): Promise<Tour> {
  const { tours, scenes, hotspots, files } = data;
  const slug = opts.slug ?? "sample-house";
  const existing = (await tours.list({ where: { slug }, limit: 1 })).items[0];
  if (existing) return existing;

  const width = opts.width ?? 2048;
  const tour = await tours.create({
    ownerId, title: "Sample house", slug, status: "draft", description: "Three generated rooms linked by hotspots",
  } as Omit<Tour, "id" | "createdAt" | "updatedAt">);
  const ids: string[] = [];
  for (const [order, room] of SAMPLE_ROOMS.entries()) {
    const key = `tours/${tour.id}/${room.file}`;
    await files.put(key, await makePanorama({ ...room, width }), { contentType: "image/png" });
    const scene = await scenes.create({
      tourId: tour.id, title: room.label, panoramaKey: key, width, height: width / 2, initialView: { yaw: 0, pitch: 0, fov: 80 }, order,
    });
    ids.push(scene.id);
  }
  const [lobby, kitchen, garden] = ids as [string, string, string];
  const link = (sceneId: string, yaw: number, targetSceneId: string, title: string) =>
    hotspots.create({ tourId: tour.id, sceneId, kind: "link", yaw, pitch: -8, targetSceneId, title });
  await link(lobby, 60, kitchen, "Kitchen");
  await link(lobby, -90, garden, "Garden");
  await link(kitchen, -120, lobby, "Back to the lobby");
  await link(garden, 90, lobby, "Back to the lobby");
  await hotspots.create({
    tourId: tour.id, sceneId: lobby, kind: "info", yaw: 0, pitch: 10, title: "Welcome",
    text: "Drag to look around; click the doors to move between rooms.",
  });
  return (await tours.update(tour.id, { startSceneId: lobby, coverKey: (await scenes.get(lobby))!.panoramaKey, status: "published" }))!;
}
