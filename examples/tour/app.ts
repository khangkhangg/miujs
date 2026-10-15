/**
 * Minimal virtual-tour demo:  MIU_ENV=development bun examples/tour/app.ts  ->  http://localhost:3000
 *
 *   /t/demo-house      public viewer (3 linked rooms, generated panoramas)
 *   /login             dev-only: signs you in as the demo creator, then opens the editor
 *   /editor            your tours; /editor/<id> the editor (upload panoramas, click to place hotspots)
 *   /mcp, /openapi.json  every creator route is an agent tool
 *
 * Everything is in memory; swap the repositories/blob store for SQLite/D1 + disk/R2 drivers to persist.
 */
import {
  Miu, auth, isDev, login, mcp, memoryBlobStore, memoryRepository, memoryStore, openapi, secureHeaders, sessions,
} from "../../src/index.ts";
import { tourKit, type Hotspot, type Scene, type Tour } from "../../src/tour/index.ts";
import { makePanorama, SAMPLE_ROOMS } from "./panorama.ts";

const tours = memoryRepository<Tour>();
const scenes = memoryRepository<Scene>();
const hotspots = memoryRepository<Hotspot>();
const files = memoryBlobStore();
const DEMO_USER = { id: "demo", name: "Demo creator" };

// Seed the demo house: lobby <-> kitchen, lobby <-> garden, plus an info point.
const tour = await tours.create({ ownerId: DEMO_USER.id, title: "Demo house", slug: "demo-house", status: "draft", description: "Three generated rooms" } as Omit<Tour, "id">);
const ids: string[] = [];
for (const [order, room] of SAMPLE_ROOMS.entries()) {
  const key = `tours/${tour.id}/${room.file}`;
  await files.put(key, await makePanorama({ ...room, width: 2048 }), { contentType: "image/png" });
  const s = await scenes.create({ tourId: tour.id, title: room.label, panoramaKey: key, width: 2048, height: 1024, initialView: { yaw: 0, pitch: 0, fov: 80 }, order });
  ids.push(s.id);
}
const [lobby, kitchen, garden] = ids as [string, string, string];
const link = (sceneId: string, yaw: number, targetSceneId: string, title: string) =>
  hotspots.create({ tourId: tour.id, sceneId, kind: "link", yaw, pitch: -8, targetSceneId, title });
await link(lobby, 60, kitchen, "Kitchen");
await link(lobby, -90, garden, "Garden");
await link(kitchen, -120, lobby, "Back to the lobby");
await link(garden, 90, lobby, "Back to the lobby");
await hotspots.create({ tourId: tour.id, sceneId: lobby, kind: "info", yaw: 0, pitch: 10, title: "Welcome", text: "Drag to look around, click the blue doors to move between rooms." });
await tours.update(tour.id, { startSceneId: lobby, status: "published" });

const app = new Miu({ name: "tour-demo", version: "0.1.0" })
  .use(secureHeaders())
  .use(sessions({ store: memoryStore(), secret: process.env.SESSION_SECRET ?? "dev-only-secret-change-me-0123456789abcdef" }))
  .use(auth({ loadUser: async (id) => (id === DEMO_USER.id ? DEMO_USER : undefined) }))
  .use(openapi())
  .use(mcp())
  .route("/", tourKit({ tours, scenes, hotspots, files, loginPath: "/login" }))
  .get("/", { tool: false, hidden: true }, (c) => c.redirect("/t/demo-house"))
  .get("/login", { tool: false, hidden: true }, async (c) => {
    // Demo login: impossible outside an explicit development environment.
    if (!isDev()) return c.text("Demo login is disabled outside MIU_ENV=development", 404);
    await login(c, DEMO_USER);
    const next = c.query.next;
    return c.redirect(typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/editor");
  });

const server = app.listen(Number(process.env.PORT ?? 3000));
console.log(`Tour demo on http://localhost:${server.port}/t/demo-house  (editor: /login)`);
