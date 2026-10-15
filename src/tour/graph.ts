import type { Hotspot, Scene, Tour } from "./schema.ts";

export interface TourProblem {
  code: "no_scenes" | "no_start_scene" | "start_scene_not_in_tour" | "link_missing_target" | "link_target_not_in_tour" | "link_to_self";
  message: string;
  sceneId?: string;
  hotspotId?: string;
}

/**
 * Check that a tour can be published: it has scenes, a start scene of its own, and every link hotspot points
 * at another scene of the same tour. Returns every problem (empty = publishable).
 */
export function validateTourGraph(tour: Pick<Tour, "startSceneId">, scenes: Pick<Scene, "id" | "title">[], hotspots: Pick<Hotspot, "id" | "sceneId" | "kind" | "targetSceneId" | "title">[]): TourProblem[] {
  const problems: TourProblem[] = [];
  const byId = new Map(scenes.map((s) => [s.id, s]));
  if (!scenes.length) problems.push({ code: "no_scenes", message: "Add at least one scene (upload a panorama)." });
  if (!tour.startSceneId) {
    problems.push({ code: "no_start_scene", message: "Choose the scene the tour starts with." });
  } else if (!byId.has(tour.startSceneId)) {
    problems.push({ code: "start_scene_not_in_tour", message: "The start scene no longer exists in this tour; choose another.", sceneId: tour.startSceneId });
  }
  for (const h of hotspots) {
    if (h.kind !== "link") continue;
    const where = `Link hotspot${h.title ? ` "${h.title}"` : ""} in scene "${byId.get(h.sceneId)?.title ?? h.sceneId}"`;
    if (!h.targetSceneId) {
      problems.push({ code: "link_missing_target", message: `${where} has no target scene.`, sceneId: h.sceneId, hotspotId: h.id });
    } else if (h.targetSceneId === h.sceneId) {
      problems.push({ code: "link_to_self", message: `${where} links to its own scene.`, sceneId: h.sceneId, hotspotId: h.id });
    } else if (!byId.has(h.targetSceneId)) {
      problems.push({ code: "link_target_not_in_tour", message: `${where} targets a scene that is not part of this tour.`, sceneId: h.sceneId, hotspotId: h.id });
    }
  }
  return problems;
}
