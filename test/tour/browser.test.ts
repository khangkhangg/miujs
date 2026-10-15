/**
 * Real-browser test of the tour viewer and editor (headless Chromium via playwright-core, WebGL on SwiftShader).
 * Setup (once): cd test/tour/browser && bun install. Chromium: $MIU_CHROMIUM, else /opt/pw-browsers, else
 * Playwright's default location. Skips with a message when either is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { Miu } from "../../src/core/app.ts";
import { memoryRepository } from "../../src/batteries/data/index.ts";
import { memoryBlobStore } from "../../src/batteries/files/index.ts";
import { tourKit, type Hotspot, type Scene, type Tour } from "../../src/tour/index.ts";
import { makePanorama, SAMPLE_ROOMS } from "../../examples/tour/panorama.ts";

const pwEntry = new URL("./browser/node_modules/playwright-core/index.mjs", import.meta.url).pathname;

function findChromium(): string | undefined {
  if (process.env.MIU_CHROMIUM && existsSync(process.env.MIU_CHROMIUM)) return process.env.MIU_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = `${root}/${dir}/chrome-linux/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const chromium = findChromium();
/** Set MIU_SCREENSHOTS=<dir> to keep screenshots of the viewer and editor for a visual check. */
const shots = process.env.MIU_SCREENSHOTS;
const skipReason = !existsSync(pwEntry)
  ? "playwright-core not installed (cd test/tour/browser && bun install)"
  : !chromium
    ? "no Chromium found (set MIU_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH)"
    : "";
if (skipReason) console.warn(`[tour browser test] skipped: ${skipReason}`);

describe.skipIf(!!skipReason)("tour viewer & editor in Chromium", () => {
  const tours = memoryRepository<Tour>();
  const scenes = memoryRepository<Scene>();
  const hotspots = memoryRepository<Hotspot>();
  const files = memoryBlobStore();
  // Cookie-based fake auth, so the editor exercises the CSRF guard exactly like a session cookie would.
  const kit = tourKit({ tours, scenes, hotspots, files, authorize: (c) => (c.cookie("test_user") === "alice" ? { id: "alice" } : undefined) });
  const app = new Miu({ logger: false }).route("/", kit);
  let server: { port?: number; stop: (force?: boolean) => void };
  let browser: any;
  let origin = "";
  let tour: Tour;
  let lobby: Scene;
  let kitchen: Scene;
  const errors: string[] = [];

  beforeAll(async () => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
    origin = `http://127.0.0.1:${server.port}`;
    tour = await tours.create({ ownerId: "alice", title: "Demo house", slug: "demo-house", status: "draft" } as Omit<Tour, "id">);
    const mk = async (i: number, order: number) => {
      const room = SAMPLE_ROOMS[i]!;
      const key = `tours/${tour.id}/${room.file}`;
      await files.put(key, await makePanorama({ ...room, width: 1024 }), { contentType: "image/png" });
      return scenes.create({ tourId: tour.id, title: room.label, panoramaKey: key, width: 1024, height: 512, initialView: { yaw: 0, pitch: 0, fov: 75 }, order });
    };
    lobby = await mk(0, 0);
    kitchen = await mk(1, 1);
    await hotspots.create({ tourId: tour.id, sceneId: lobby.id, kind: "link", yaw: 20, pitch: -5, targetSceneId: kitchen.id, title: "Kitchen" });
    await hotspots.create({ tourId: tour.id, sceneId: kitchen.id, kind: "link", yaw: -20, pitch: -5, targetSceneId: lobby.id, title: "Lobby" });
    await tours.update(tour.id, { startSceneId: lobby.id, status: "published" });

    const pw = await import(pwEntry);
    browser = await pw.chromium.launch({
      executablePath: chromium,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const newPage = async (loggedIn: boolean) => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 640 } });
    if (loggedIn) await context.addCookies([{ name: "test_user", value: "alice", url: origin }]);
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m: any) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    return page;
  };

  test("public viewer renders the panorama and link hotspots change scene", async () => {
    const page = await newPage(false);
    await page.goto(`${origin}/t/demo-house`);
    await page.waitForFunction(() => (window as any).miuTour?.scene);
    await page.evaluate(() => (window as any).miuTour.ready);
    expect(await page.evaluate(() => (window as any).miuTour.viewer.webgl)).toBe(true);

    const stats = await page.evaluate(() => (window as any).miuTour.viewer.pixelStats());
    expect(stats.width).toBeGreaterThan(0);
    expect(stats.nonBlack).toBeGreaterThan(1000);
    expect(stats.distinct).toBeGreaterThan(10); // a real image, not a clear colour
    const shot: Uint8Array = await page.screenshot(shots ? { path: `${shots}/viewer.png` } : {});
    expect(shot.byteLength).toBeGreaterThan(10_000);

    expect(await page.evaluate(() => (window as any).miuTour.scene)).toBe(lobby.id);
    const marker = page.locator(`.miu-hotspot[data-hotspot-id]`).first();
    await marker.waitFor({ state: "visible" });
    expect(await marker.getAttribute("aria-label")).toBe("Kitchen");
    await marker.click();
    await page.waitForFunction((id: string) => (window as any).miuTour.scene === id, kitchen.id);
    // deep link reflects the new scene; reloading with it restores the scene
    await page.waitForFunction((id: string) => location.hash.includes(`scene=${id}`), kitchen.id);
    await page.reload();
    await page.waitForFunction((id: string) => (window as any).miuTour?.scene === id, kitchen.id);
    // keyboard look-around
    await page.focus("#miu-tour");
    const before = await page.evaluate(() => (window as any).miuTour.camera.yaw);
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => (window as any).miuTour.camera.yaw)).toBeCloseTo(before + 5, 5);
    // goto() from DevTools
    await page.evaluate((id: string) => (window as any).miuTour.goto(id), lobby.id);
    expect(await page.evaluate(() => (window as any).miuTour.scene)).toBe(lobby.id);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 30_000);

  test("editor: clicking the panorama creates a hotspot via the API; dragging moves it", async () => {
    const page = await newPage(true);
    await page.goto(`${origin}/editor/${tour.id}`);
    await page.waitForFunction(() => (window as any).miuEditor?.viewer.scene);
    const count = async () => (await hotspots.list({ where: { sceneId: lobby.id } })).total;
    expect(await count()).toBe(1);

    const stage = page.locator("#miu-tour");
    const box = await stage.boundingBox();
    const at = { x: box.width * 0.25, y: box.height * 0.45 };
    const expected = await page.evaluate(({ x, y }: { x: number; y: number }) => (window as any).miuEditor.viewer.screenToYawPitch(x, y), at);
    await stage.click({ position: at });
    await page.waitForFunction(() => (window as any).miuEditor.state.hotspots.length === 3);
    expect(await count()).toBe(2);
    const created = (await hotspots.list({ where: { sceneId: lobby.id } })).items.find((h) => h.title !== "Kitchen")!;
    expect(created.kind).toBe("link");
    expect(created.targetSceneId).toBe(kitchen.id);
    expect(Math.abs(created.yaw - expected.yaw)).toBeLessThan(0.5);
    expect(Math.abs(created.pitch - expected.pitch)).toBeLessThan(0.5);
    // the inspector opened for the new hotspot
    await page.locator(".miu-hotspot-panel h2").waitFor();

    // drag the new marker to the right; the API receives the new yaw
    const marker = page.locator(`.miu-hotspot[data-hotspot-id="${created.id}"]`);
    const mb = await marker.boundingBox();
    const cx = mb.x + mb.width / 2;
    const cy = mb.y + mb.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 6 });
    await page.mouse.move(cx + 120, cy, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector(".miu-status")?.textContent === "Hotspot moved");
    if (shots) await page.screenshot({ path: `${shots}/editor.png` });
    const moved = (await hotspots.get(created.id))!;
    expect(moved.yaw).toBeGreaterThan(created.yaw + 5);

    // publish validation shows problems from the API (an info hotspot without problems is fine; break a link)
    await hotspots.update(created.id, { targetSceneId: undefined });
    await page.reload();
    await page.waitForFunction(() => (window as any).miuEditor?.viewer.scene);
    await page.locator(".miu-publish button").click(); // currently published -> unpublish
    await page.locator(".miu-publish button", { hasText: "Publish" }).click();
    await page.locator(".miu-problems li").first().waitFor();
    expect(await page.locator(".miu-problems li").first().textContent()).toContain("no target scene");
    expect(errors.filter((e) => !e.includes("422"))).toEqual([]);
    await page.context().close();
  }, 30_000);
});
