import { describe, expect, test } from "bun:test";
import { tourCsp, tourPage, VIEWER_ASSETS } from "../src/index.ts";
import type { Manifest } from "../src/manifest.ts";

const NONCE = "bm9uY2Utbm9uY2U=";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    tour: { id: "tour_1", slug: "elm", title: "12 Elm St", description: null, watermark: null, privacy: "standard", startSceneId: "scn_a" },
    scenes: [
      { id: "scn_a", title: "Hall", type: "pano360", floor: 0, initialView: { yaw: 0, pitch: 0, fov: 75 }, asset: null, hotspots: [{ id: "hs_1", kind: "info", position: { yaw: 1, pitch: 2 }, title: "Oven", bodyHtml: "<p>Gas</p>" }] },
      { id: "scn_b", title: "Kitchen", type: "pano360", floor: 0, initialView: { yaw: 0, pitch: 0, fov: 75 }, asset: null, hotspots: [] },
    ],
    floorPlans: [{ floor: 0, title: "Ground", image: { url: "https://files.example.com/_files/abc.def" }, markers: [{ sceneId: "scn_a", x: 0.25, y: 0.5 }, { sceneId: "scn_b", x: 0.75, y: 0.5 }] }],
    analytics: { url: "/tours/elm/events" },
    live: null,
    expiresAt: 1,
    ...over,
  };
}

const scripts = (html: string) => [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);

describe("tourPage", () => {
  test("a full HTML document with the viewer root, config and pinned CDN libraries", () => {
    const html = String(tourPage("/tours/elm/manifest.json", { nonce: NONCE, manifest: manifest() }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<div id="miu-tour" class="miu-tour"');
    expect(html).toContain('<title>12 Elm St</title>');
    expect(html).toContain('<script type="importmap"');
    expect(html).toContain("https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/core@5.15.1/index.module.js");
    expect(html).toContain("https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/virtual-tour-plugin@5.15.1/index.module.js");
    expect(html).toContain("https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js");
    // SRI for the import map's modules and for the stylesheets.
    expect(html).toContain(`"https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/core@5.15.1/index.module.js":"${VIEWER_ASSETS.psvCore.integrity}"`);
    expect(html).toMatch(/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@photo-sphere-viewer\/core@5\.15\.1\/index\.css" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous">/);
    expect(html).not.toContain("model-viewer.min.js");
  });

  test("every script carries the CSP nonce", () => {
    const html = String(tourPage("/m.json", { nonce: NONCE, manifest: manifest(), live: { code: "123456", roomsPath: "/rooms" } }));
    const tags = scripts(html);
    expect(tags.length).toBeGreaterThanOrEqual(4);
    for (const tag of tags) expect(tag).toContain(`nonce="${NONCE}"`);
  });

  test("model scenes load <model-viewer> with SRI and no panorama libraries", () => {
    const m = manifest({ scenes: [{ id: "scn_m", title: "Sofa", type: "model3d", floor: null, initialView: { yaw: 0, pitch: 0, fov: 45 }, asset: null, hotspots: [] }] });
    const html = String(tourPage("/m.json", { nonce: NONCE, manifest: m }));
    expect(html).toContain(`src="https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js" integrity="${VIEWER_ASSETS.modelViewer.integrity}" crossorigin="anonymous"`);
    expect(html).not.toContain('<script type="importmap"');
    expect(html).not.toContain("photo-sphere-viewer/core@");
  });

  test("without a manifest both viewers are available", () => {
    const html = String(tourPage("/m.json", { nonce: NONCE }));
    expect(html).toContain("photo-sphere-viewer");
    expect(html).toContain("model-viewer.min.js");
  });

  test("text from the tour is escaped everywhere", () => {
    const evil = "</title><script>alert(1)</script>";
    const m = manifest({ tour: { ...manifest().tour, title: evil, watermark: '<img src=x onerror="alert(2)">' } });
    m.scenes[0].title = "</script><script>alert(3)</script>";
    const html = String(tourPage('/m.json?x="><script>alert(4)</script>', { nonce: NONCE, manifest: m }));
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    // Inline JSON cannot close its <script> element.
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(3)");
  });

  test("the watermark is an overlay when set", () => {
    expect(String(tourPage("/m.json", { nonce: NONCE, manifest: manifest() }))).not.toContain("miu-tour-watermark\"");
    const html = String(tourPage("/m.json", { nonce: NONCE, manifest: manifest({ tour: { ...manifest().tour, watermark: "Acme Realty" } }) }));
    expect(html).toContain('<div class="miu-tour-watermark" aria-hidden="true">');
    expect(html).toContain("Acme Realty");
  });

  test("the floor plan and a scene list are rendered on the server", () => {
    const html = String(tourPage("/m.json", { nonce: NONCE, manifest: manifest() }));
    expect(html).toContain('<nav class="miu-tour-floorplan" aria-label="Floor plan">');
    expect(html).toContain('<img src="https://files.example.com/_files/abc.def" alt="Ground"');
    expect(html).toContain('<button type="button" class="miu-tour-marker" data-scene="scn_a" data-x="0.25" data-y="0.5" aria-label="Hall">');
    expect(html).toContain('<ul class="miu-tour-scenes">');
    expect(html).toContain('data-scene="scn_b">Kitchen</button>');
    // Info hotspots readable without WebGL.
    expect(html).toContain("<p>Gas</p>");
  });

  test("self-hosted assets never touch a CDN", () => {
    const html = String(tourPage("/m.json", { nonce: NONCE, assets: { basePath: "/vendor/tour" } }));
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("gstatic.com");
    expect(html).toContain('"three":"/vendor/tour/three/build/three.module.js"');
    expect(html).toContain('src="/vendor/tour/@google/model-viewer/dist/model-viewer.min.js"');
  });

  test("the live snippet is only included with a join code", () => {
    const without = String(tourPage("/m.json", { nonce: NONCE }));
    expect(without).not.toContain('id="miu-tour-live"');
    expect(without).not.toContain("guidedTour");
    const html = String(tourPage("/m.json", { nonce: NONCE, live: { code: "123456", roomsPath: "/rooms" } }));
    expect(html).toContain('<script type="application/json" id="miu-tour-live" nonce=');
    expect(html).toContain('"code":"123456"');
    expect(html).toContain("raise");
    // The rooms plugin's own client is used, not a private protocol implementation.
    expect(html).toContain('"clientUrl":"/rooms/_client.js"');
    expect(html).not.toContain("new WebSocket");
    expect(html).toContain("detach");
  });

  test("analytics code is left out when the manifest has analytics off", () => {
    const on = String(tourPage("/m.json", { nonce: NONCE, manifest: manifest() }));
    const off = String(tourPage("/m.json", { nonce: NONCE, manifest: manifest({ analytics: null }) }));
    expect(on).toContain('"analytics":{"url":"/tours/elm/events"}');
    expect(off).toContain('"analytics":null');
  });
});

describe("tourCsp", () => {
  test("nonce, pinned CDN and frame-ancestors", () => {
    const csp = tourCsp({ nonce: NONCE, frameAncestors: ["https://listings.example.com"] });
    expect(csp).toContain(`script-src 'self' 'nonce-${NONCE}' 'wasm-unsafe-eval' https://cdn.jsdelivr.net`);
    expect(csp).toContain("frame-ancestors https://listings.example.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("no embedding by default; self-hosted assets drop the CDN; asset origins are allowed", () => {
    const csp = tourCsp({ nonce: NONCE, assets: { basePath: "/v" }, assetOrigins: ["https://files.example.com"] });
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("jsdelivr");
    expect(csp).not.toContain("gstatic");
    expect(csp).toMatch(/img-src [^;]*https:\/\/files\.example\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/files\.example\.com/);
  });
});
