/**
 * Seed Tour Studio: the admin account and a published demo tour (3 linked rooms with generated panoramas).
 * Idempotent: existing records are left alone. Runs on start (unless SEED=0), or on its own:
 *
 *   DATA_DIR=./data ADMIN_PASSWORD=... bun apps/tour-studio/seed.ts
 */
import { hashPassword } from "../../src/index.ts";
import type { Tour } from "../../src/tour/index.ts";
import { makePanorama, SAMPLE_ROOMS } from "../../examples/tour/panorama.ts";
import { findUserByEmail, openData, type Data } from "./app.ts";
import { loadConfig } from "./config.ts";

export const DEMO_SLUG = "demo-house";
export const DEMO_CREATOR_EMAIL = "demo@example.com";

export interface SeedOptions {
  adminEmail: string;
  adminPassword: string;
  /** Width of the generated panoramas (2:1). Default 2048. */
  panoramaWidth?: number;
  log?: (line: string) => void;
}

export async function seed(data: Data, o: SeedOptions): Promise<{ adminId: string; tourId: string }> {
  const { users, tours, scenes, hotspots, files } = data;
  const log = o.log ?? (() => {});

  let admin = await findUserByEmail(users, o.adminEmail);
  if (!admin) {
    admin = await users.create({ email: o.adminEmail, name: "Admin", roles: ["admin"], passwordHash: await hashPassword(o.adminPassword) });
    log(`[seed] admin ${o.adminEmail}`);
  }

  const existing = (await tours.list({ where: { slug: DEMO_SLUG }, limit: 1 })).items[0];
  if (existing) return { adminId: admin.id, tourId: existing.id };

  // The demo tour belongs to a separate demo creator (no password: it cannot log in).
  let creator = await findUserByEmail(users, DEMO_CREATOR_EMAIL);
  creator ??= await users.create({ email: DEMO_CREATOR_EMAIL, name: "Demo creator", roles: ["creator"], passwordHash: "!" });

  const width = o.panoramaWidth ?? 2048;
  const tour = await tours.create({
    ownerId: creator.id, title: "Demo house", slug: DEMO_SLUG, status: "draft",
    description: "Three generated rooms: drag to look around, click the doors to move.",
  } as Omit<Tour, "id" | "createdAt" | "updatedAt">);
  const ids: string[] = [];
  for (const [order, room] of SAMPLE_ROOMS.entries()) {
    const key = `tours/${tour.id}/${room.file}`;
    await files.put(key, await makePanorama({ ...room, width }), { contentType: "image/png" });
    const s = await scenes.create({ tourId: tour.id, title: room.label, panoramaKey: key, width, height: width / 2, initialView: { yaw: 0, pitch: 0, fov: 80 }, order });
    ids.push(s.id);
  }
  const [lobby, kitchen, garden] = ids as [string, string, string];
  const link = (sceneId: string, yaw: number, targetSceneId: string, title: string) =>
    hotspots.create({ tourId: tour.id, sceneId, kind: "link", yaw, pitch: -8, targetSceneId, title });
  await link(lobby, 60, kitchen, "Kitchen");
  await link(lobby, -90, garden, "Garden");
  await link(kitchen, -120, lobby, "Back to the lobby");
  await link(garden, 90, lobby, "Back to the lobby");
  await hotspots.create({ tourId: tour.id, sceneId: lobby, kind: "info", yaw: 0, pitch: 10, title: "Welcome", text: "Drag to look around, click the doors to move between rooms." });
  await tours.update(tour.id, { startSceneId: lobby, coverKey: `tours/${tour.id}/${SAMPLE_ROOMS[0]!.file}`, status: "published" });
  log(`[seed] demo tour /t/${DEMO_SLUG} (${width}px panoramas)`);
  return { adminId: admin.id, tourId: tour.id };
}

// CLI: bun apps/tour-studio/seed.ts  (or node --experimental-strip-types)
const self = new URL(import.meta.url).pathname;
if (process.argv[1] && (process.argv[1] === self || process.argv[1].endsWith("/tour-studio/seed.ts"))) {
  const config = loadConfig();
  const data = await openData(config.dataDir);
  await seed(data, { adminEmail: config.adminEmail, adminPassword: config.adminPassword, panoramaWidth: config.seedPanoramaWidth, log: console.log });
  data.db.close();
}
