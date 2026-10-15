import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miu } from "../../src/core/app.ts";
import { auth } from "../../src/batteries/auth/auth.ts";
import { memoryRepository } from "../../src/batteries/data/index.ts";
import { memoryBlobStore } from "../../src/batteries/files/index.ts";
import { generateAssets } from "../../src/tour/client/embed.ts";
import { tourKit, validateTourGraph, type Hotspot, type Scene, type Tour } from "../../src/tour/index.ts";

describe("embedded client assets", () => {
  test("assets.generated.ts is up to date (run `bun src/tour/client/embed.ts`)", () => {
    const current = readFileSync(new URL("../../src/tour/client/assets.generated.ts", import.meta.url), "utf8");
    expect(current === generateAssets()).toBe(true);
  });

  test("client modules parse as ES modules and import each other by content hash", async () => {
    const { ASSETS } = await import("../../src/tour/client/assets.generated.ts");
    expect(ASSETS["viewer.js"]!.body).toContain(`from "./math.js?v=${ASSETS["math.js"]!.hash}"`);
    expect(ASSETS["editor.js"]!.body).toContain(`from "./viewer.js?v=${ASSETS["viewer.js"]!.hash}"`);
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const a of Object.values(ASSETS)) expect(() => transpiler.scan(a.body)).not.toThrow();
  });
});

describe("validateTourGraph", () => {
  test("reports each problem with ids", () => {
    const scenes = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
    expect(validateTourGraph({ startSceneId: "a" }, scenes, [])).toEqual([]);
    const p = validateTourGraph({ startSceneId: "zz" }, scenes, [
      { id: "h1", sceneId: "a", kind: "link", targetSceneId: "a", title: "Loop" },
      { id: "h2", sceneId: "b", kind: "info" },
    ]);
    expect(p.map((x) => x.code)).toEqual(["start_scene_not_in_tour", "link_to_self"]);
    expect(p[1]).toMatchObject({ hotspotId: "h1", sceneId: "a" });
    expect(p[1]!.message).toContain(`"Loop"`);
  });
});

describe("default authorization", () => {
  test("uses currentUser() from the auth() middleware (e.g. bearer tokens)", async () => {
    const kit = tourKit({
      tours: memoryRepository<Tour>(), scenes: memoryRepository<Scene>(), hotspots: memoryRepository<Hotspot>(), files: memoryBlobStore(),
    });
    const app = new Miu({ logger: false })
      .use(auth({ loadUser: async () => undefined, bearer: async (tok) => (tok === "k1" ? { id: 7 } : undefined) }))
      .route("/", kit);
    expect((await app.request("/api/tours")).status).toBe(401);
    const res = await app.request("/api/tours", {
      method: "POST",
      headers: { authorization: "Bearer k1", "content-type": "application/json" },
      body: JSON.stringify({ title: "Bearer tour" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Tour).ownerId).toBe("7");
  });
});
