/**
 * Tour Studio in a real browser (headless Chromium via playwright-core; WebGL on SwiftShader).
 * Reuses the pinned playwright-core installed for the tour kit: cd test/tour/browser && bun install.
 * Chromium: $MIU_CHROMIUM, else $PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers. Skips with a message when missing.
 *
 * The app runs in development mode here (DevTools features on); a second, production server checks that the
 * inspector is gone there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { ADMIN_EMAIL, ADMIN_PASSWORD, INSPECTOR_TOKEN, panorama, panorama2, startServer, unique, type Server } from "./helpers.ts";

const pwEntry = new URL("../../tour/browser/node_modules/playwright-core/index.mjs", import.meta.url).pathname;

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
const skipReason = !existsSync(pwEntry)
  ? "playwright-core not installed (cd test/tour/browser && bun install)"
  : !chromium
    ? "no Chromium found (set MIU_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH)"
    : "";
if (skipReason) console.warn(`[tour-studio browser test] skipped: ${skipReason}`);
const shots = process.env.MIU_SCREENSHOTS;

describe.skipIf(!!skipReason)("Tour Studio in Chromium", () => {
  let dev: Server;
  let prod: Server;
  let browser: any;
  let base = "";

  beforeAll(async () => {
    [dev, prod] = await Promise.all([startServer({ env: { MIU_ENV: "development", NODE_ENV: "development" } }), startServer()]);
    base = dev.url;
    const pw = await import(pwEntry);
    browser = await pw.chromium.launch({
      executablePath: chromium,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await dev?.stop();
    await prod?.stop();
  });

  /** A fresh context; collects page errors, console errors and CSP violations. */
  const open = async (viewport = { width: 1100, height: 700 }) => {
    const context = await browser.newContext({ viewport });
    const problems: string[] = [];
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m: any) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} (${m.location()?.url ?? ""})`);
    });
    return { context, page, problems };
  };

  test("visitor: the demo tour renders, a link hotspot changes scene, the deep link survives reload", async () => {
    const { context, page, problems } = await open();
    await page.goto(`${base}/`);
    await page.getByRole("link", { name: "Demo house" }).click();
    await page.waitForURL(`${base}/t/demo-house`);
    await page.waitForFunction(() => (window as any).miuTour?.scene);
    await page.evaluate(() => (window as any).miuTour.ready);
    expect(await page.evaluate(() => (window as any).miuTour.viewer.webgl)).toBe(true);
    const stats = await page.evaluate(() => (window as any).miuTour.viewer.pixelStats());
    expect(stats.nonBlack).toBeGreaterThan(1000);
    expect(stats.distinct).toBeGreaterThan(10);
    if (shots) await page.screenshot({ path: `${shots}/studio-viewer.png` });

    const start = await page.evaluate(() => (window as any).miuTour.scene);
    // The kitchen door is at yaw 60: turn right with the keyboard (5° per key press) until it is in view.
    await page.focus("#miu-tour");
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
    const kitchen = page.locator(`.miu-hotspot[aria-label="Kitchen"]`);
    await kitchen.waitFor({ state: "visible" });
    await kitchen.click();
    await page.waitForFunction((id: string) => (window as any).miuTour.scene && (window as any).miuTour.scene !== id, start);
    const now = await page.evaluate(() => (window as any).miuTour.sceneData.title);
    expect(now).toBe("Kitchen");
    const sceneId = await page.evaluate(() => (window as any).miuTour.scene);
    await page.waitForFunction((id: string) => location.hash.includes(`scene=${id}`), sceneId);
    await page.reload();
    await page.waitForFunction((id: string) => (window as any).miuTour?.scene === id, sceneId);
    await page.evaluate(() => (window as any).miuTour.ready);
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);

  test("creator: sign up, create a tour, upload panoramas, place a hotspot by clicking, publish, open it", async () => {
    const { context, page, problems } = await open();
    const me = unique("browser");
    await context.setExtraHTTPHeaders({ "x-forwarded-for": me.ip });
    await page.goto(`${base}/`);
    await page.getByRole("link", { name: "Sign up", exact: true }).click();
    await page.getByLabel("Name").fill("Bea Browser");
    await page.getByLabel("Email").fill(me.email);
    await page.getByLabel("Password").fill("browser-password");
    await Promise.all([page.waitForURL(`${base}/editor`), page.getByRole("button", { name: "Sign up" }).click()]);

    // Create a tour in the editor UI.
    await page.getByLabel("New tour title").fill("Browser Bungalow");
    await Promise.all([page.waitForURL(/\/editor\/[A-Za-z0-9_-]+$/), page.getByRole("button", { name: "Create tour" }).click()]);
    const tourId = page.url().split("/").pop()!;

    // Upload two panoramas through the file input.
    const upload = async (bytes: Uint8Array, name: string, title: string) => {
      await page.getByLabel("Panorama image").setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(bytes) });
      await page.getByLabel("New scene title").fill(title);
      await page.getByRole("button", { name: "Upload panorama" }).click();
      await page.waitForFunction((t: string) => document.querySelector(".miu-status")?.textContent === "Panorama uploaded" && (window as any).miuEditor?.viewer.scene?.title === t, title);
    };
    // The editor exposes window.miuEditor once a tour has scenes; the first upload creates the first scene.
    await upload(await panorama(), "porch.png", "Porch");
    await upload(await panorama2(), "hall.png", "Hall");
    await page.waitForFunction(() => (window as any).miuEditor?.state.scenes.length === 2);
    // Go back to the first scene and click the panorama to place a hotspot (a link to the other scene).
    await page.locator(".miu-scene-open", { hasText: "Porch" }).click();
    await page.waitForFunction(() => (window as any).miuEditor.viewer.scene?.title === "Porch");
    const stage = page.locator("#miu-tour");
    const box = await stage.boundingBox();
    await stage.click({ position: { x: box.width * 0.3, y: box.height * 0.5 } });
    await page.waitForFunction(() => (window as any).miuEditor.state.hotspots.length === 1);
    const hs = await page.evaluate(() => (window as any).miuEditor.state.hotspots[0]);
    expect(hs.kind).toBe("link");
    await page.locator(".miu-hotspot-panel h2").waitFor();

    // Publish and open the public page.
    await page.locator(".miu-publish button", { hasText: "Publish" }).click();
    await page.waitForFunction(() => document.querySelector(".miu-status")?.textContent === "Tour published!");
    if (shots) await page.screenshot({ path: `${shots}/studio-editor.png` });
    const slug = await page.evaluate(() => (window as any).miuEditor.state.tour.slug);
    expect(slug).toBe("browser-bungalow");
    const pub = await context.newPage();
    pub.on("pageerror", (e: Error) => problems.push(`pageerror: ${e.message}`));
    await pub.goto(`${base}/t/${slug}`);
    await pub.waitForFunction(() => (window as any).miuTour?.scene);
    await pub.evaluate(() => (window as any).miuTour.ready);
    expect(await pub.evaluate(() => (window as any).miuTour.tour.id)).toBe(tourId);
    expect(await pub.locator(`.miu-hotspot[data-hotspot-id="${hs.id}"]`).count()).toBe(1);
    expect(problems).toEqual([]);
    await context.close();
  }, 90_000);

  test("admin: sign in, see users and tours, edit a tour title", async () => {
    const { context, page, problems } = await open({ width: 1200, height: 800 });
    await context.setExtraHTTPHeaders({ "x-forwarded-for": unique().ip });
    await page.goto(`${base}/admin`);
    await page.waitForURL(/\/login\?next=%2Fadmin/);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await Promise.all([page.waitForURL(`${base}/admin**`), page.getByRole("button", { name: "Log in" }).click()]);

    await page.getByRole("link", { name: "Users" }).click();
    await page.getByRole("cell", { name: ADMIN_EMAIL, exact: true }).waitFor();
    await page.getByRole("link", { name: "Tours" }).click();
    const row = page.getByRole("row", { name: /Demo house/ });
    await row.waitFor();
    await row.getByRole("link", { name: /^Edit Demo house/ }).click();
    await page.getByLabel("Title").waitFor();
    await page.getByLabel("Title").fill("Demo house — edited in the admin");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("row", { name: /edited in the admin/ }).waitFor();
    const pub = await (await fetch(`${base}/api/public/tours/demo-house`)).json();
    expect(pub.tour.title).toBe("Demo house — edited in the admin");
    // The admin page declares no icon, so Chromium's automatic /favicon.ico request 404s (a framework rough edge).
    expect(problems.filter((p) => !p.includes("/favicon.ico"))).toEqual([]);
    await context.close();
  }, 60_000);

  test("DevTools: Server-Timing in dev, the request shows up in /__miu; production has no /__miu", async () => {
    const { context, page, problems } = await open();
    const res = await page.goto(`${base}/api/public/tours/demo-house?devtools-probe=1`);
    expect(res.headers()["server-timing"]).toMatch(/total;dur=[\d.]+/);
    // Server-Timing is visible to the page too (same origin), as DevTools shows it in the Network tab.
    const fromPerf = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as any).serverTiming.map((t: any) => t.name));
    expect(fromPerf).toContain("total");

    const inspector = await page.goto(`${base}/__miu?token=${INSPECTOR_TOKEN}`);
    expect(inspector.status()).toBe(200);
    expect(new URL(page.url()).search).toBe(""); // token traded for a cookie and removed from the URL
    const list = await page.evaluate(async () => (await fetch("/__miu/api/requests")).json());
    const probe = list.requests.find((r: any) => r.query.includes("devtools-probe"));
    expect(probe).toMatchObject({ method: "GET", path: "/api/public/tours/demo-house", status: 200, route: "/api/public/tours/:slug" });
    expect(probe.timing.length).toBeGreaterThan(0);
    // Without the token: 401 (from loopback); the page never contains the token.
    expect((await fetch(`${base}/__miu/api/requests`)).status).toBe(401);
    expect(await page.content()).not.toContain(INSPECTOR_TOKEN);

    const prodRes = await page.goto(`${prod.url}/__miu?token=${INSPECTOR_TOKEN}`);
    expect(prodRes.status()).toBe(404);
    const prodApi = await page.goto(`${prod.url}/api/public/tours/demo-house`);
    expect(prodApi.headers()["server-timing"]).toBeUndefined();
    expect(problems.filter((p) => !p.includes("404"))).toEqual([]);
    await context.close();
  }, 60_000);
});
