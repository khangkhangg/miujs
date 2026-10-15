import { describe, expect, test } from "bun:test";
import { validate } from "../../src/core/schema.ts";
import {
  TourSchema, SceneSchema, HotspotSchema, CreateTourBody, CreateHotspotBody, UpdateSceneBody, slugify, SLUG_PATTERN,
} from "../../src/tour/schema.ts";

const now = new Date().toISOString();
const tour = {
  id: "t1", ownerId: "u1", title: "Villa", slug: "villa-1", status: "draft", createdAt: now, updatedAt: now,
};
const scene = {
  id: "s1", tourId: "t1", title: "Lobby", panoramaKey: "tours/t1/a.png", width: 2048, height: 1024,
  initialView: { yaw: 0, pitch: 0, fov: 75 }, order: 0,
};

describe("tour schemas", () => {
  test("accept valid documents", () => {
    expect(validate(TourSchema, tour).ok).toBe(true);
    expect(validate(SceneSchema, scene).ok).toBe(true);
    expect(validate(HotspotSchema, { id: "h1", tourId: "t1", sceneId: "s1", kind: "link", yaw: 10, pitch: -5, targetSceneId: "s2" }).ok).toBe(true);
  });

  test("validate yaw/pitch/fov ranges", () => {
    const bad = (v: Record<string, number>) => validate(SceneSchema, { ...scene, initialView: { yaw: 0, pitch: 0, fov: 75, ...v } }).ok;
    expect(bad({ yaw: 181 })).toBe(false);
    expect(bad({ yaw: -181 })).toBe(false);
    expect(bad({ pitch: 91 })).toBe(false);
    expect(bad({ fov: 29 })).toBe(false);
    expect(bad({ fov: 121 })).toBe(false);
    expect(bad({ yaw: 180, pitch: -90, fov: 120 })).toBe(true);
    expect(validate(CreateHotspotBody, { kind: "info", yaw: 0, pitch: 95, title: "x" }).ok).toBe(false);
  });

  test("slug is url-safe and status is an enum", () => {
    for (const s of ["Villa", "a b", "-a", "a-", "a_b", "ä", "", "x".repeat(65)]) {
      expect(validate(TourSchema, { ...tour, slug: s }).ok).toBe(false);
    }
    expect(new RegExp(SLUG_PATTERN).test("villa-2024")).toBe(true);
    expect(validate(TourSchema, { ...tour, status: "archived" }).ok).toBe(false);
  });

  test("text lengths and hotspot urls are bounded", () => {
    expect(validate(CreateTourBody, { title: "" }).ok).toBe(false);
    expect(validate(CreateTourBody, { title: "x".repeat(121) }).ok).toBe(false);
    expect(validate(CreateTourBody, { title: "ok", description: "x".repeat(2001) }).ok).toBe(false);
    expect(validate(CreateHotspotBody, { kind: "info", yaw: 0, pitch: 0, text: "x".repeat(2001) }).ok).toBe(false);
    expect(validate(CreateHotspotBody, { kind: "info", yaw: 0, pitch: 0, url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validate(CreateHotspotBody, { kind: "info", yaw: 0, pitch: 0, url: "https://example.com/x" }).ok).toBe(true);
    expect(validate(UpdateSceneBody, { title: "y".repeat(121) }).ok).toBe(false);
  });

  test("slugify makes a url-safe slug from a title", () => {
    expect(slugify("Ocean View Villa!")).toBe("ocean-view-villa");
    expect(slugify("  Café  Ünïcode -- Tour ")).toBe("cafe-unicode-tour");
    expect(slugify("!!!")).toBe("tour");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(64);
    expect(new RegExp(SLUG_PATTERN).test(slugify("x".repeat(63) + "-y"))).toBe(true);
  });
});
