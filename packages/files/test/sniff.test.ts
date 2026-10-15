import { describe, expect, test } from "bun:test";
import { normalizeAllowed, sniff } from "../src/sniff.ts";
import { b, samples } from "./fixtures.ts";


describe("sniff", () => {
  test.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
    ["pdf", "application/pdf"],
    ["glb", "model/gltf-binary"],
    ["mp4", "video/mp4"],
    ["zip", "application/zip"],
  ] as const)("detects %s", (name, mime) => {
    expect(sniff(samples[name])).toBe(mime);
  });

  test.each([
    ["html", b("<!doctype html><script>")],
    ["svg", b("<svg xmlns=")],
    ["riff that is not webp (wav)", b("RIFF", 0, 0, 0, 0, "WAVE")],
    ["heic (ftyp but not mp4)", b(0, 0, 0, 0x18, "ftypheic")],
    ["too short", new Uint8Array([0x89, 0x50])],
    ["empty", new Uint8Array()],
  ])("returns null for %s", (_, bytes) => {
    expect(sniff(bytes)).toBeNull();
  });

  test("normalizeAllowed accepts short names and mime types", () => {
    expect(normalizeAllowed(["png", "image/jpeg", "GLB", "jpg"])).toEqual(["image/png", "image/jpeg", "model/gltf-binary"]);
  });

  test("normalizeAllowed rejects unknown types with a config error", () => {
    expect(() => normalizeAllowed(["text/html"])).toThrow(/text\/html/);
    expect(() => normalizeAllowed([])).toThrow();
  });
});
