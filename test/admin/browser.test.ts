/**
 * End-to-end test of the admin UI in headless Chromium (playwright-core, installed only under
 * test/admin/browser/ so the root package stays dependency-free). Skips with a message when unavailable:
 *   cd test/admin/browser && npm install
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeApp, png } from "./helpers.ts";

const PW = new URL("./browser/node_modules/playwright-core/index.mjs", import.meta.url).pathname;
let chromium: any;
let skipReason = "";
if (!existsSync(PW)) skipReason = "playwright-core not installed (cd test/admin/browser && npm install)";
else {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";
  chromium = (await import(PW)).chromium;
  if (!existsSync(chromium.executablePath())) skipReason = `Chromium not found at ${chromium.executablePath()}`;
}
if (skipReason) console.warn(`[admin browser test] skipped: ${skipReason}`);

describe.skipIf(!!skipReason)("admin UI in a real browser", () => {
  let server: { port: number; stop: (force?: boolean) => void };
  let browser: any;
  let base = "";
  const env = makeApp({ loginUrl: "/signin", title: "Tour Admin" });

  beforeAll(async () => {
    server = env.app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("sign in, create (with validation error, relation and image), list, edit, delete", async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e: Error) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m: any) => {
      // The deliberate validation failure logs its 422; anything else (CSP violations, script errors) fails the test.
      if (m.type() === "error" && !/favicon/.test(m.location()?.url ?? "") && !/status of 422/.test(m.text())) problems.push(`console: ${m.text()}`);
    });

    // Signed out: redirected to the sign-in page, then back to the admin.
    await page.goto(`${base}/admin`);
    expect(new URL(page.url()).pathname).toBe("/signin");
    await page.fill("#user", "admin");
    await Promise.all([page.waitForURL(`${base}/admin**`), page.click("button[type=submit]")]);
    await page.getByRole("link", { name: "Tours" }).waitFor();
    expect(await page.textContent(".who")).toBe("Ada");

    // A category for the relation picker.
    await page.getByRole("link", { name: "Categories" }).click();
    await page.getByRole("link", { name: "Create the first one" }).click();
    await page.getByLabel("Name").fill("Landmarks");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("cell", { name: "Landmarks", exact: true }).waitFor();

    // Tours: empty state, then a create that first fails validation.
    await page.getByRole("link", { name: "Tours" }).click();
    await page.getByText("No tours yet.").waitFor();
    await page.getByRole("link", { name: "New tour" }).first().click();
    await page.getByRole("button", { name: "Create" }).click();
    const titleErr = page.locator("#f-title-err");
    await titleErr.waitFor({ state: "visible" });
    expect(await titleErr.textContent()).toBe("Required");
    expect(await page.getAttribute("#f-title", "aria-invalid")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("f-title");

    await page.getByLabel("Title").fill("Eiffel Tower");
    await page.getByLabel("Status").selectOption("published");
    await page.getByLabel("Featured").check();
    await page.getByLabel("Category Id").selectOption({ label: "Landmarks" });
    await page.setInputFiles("#f-cover", { name: "cover.png", mimeType: "image/png", buffer: Buffer.from(png(16, 8)) });
    await page.locator(".preview img").waitFor(); // local preview before upload
    await page.getByRole("button", { name: "Create" }).click();

    // Back on the list with the new row.
    const row = page.getByRole("row", { name: /Eiffel Tower/ });
    await row.waitFor();
    const stored = (await env.tours.list()).items[0];
    expect(stored).toMatchObject({ title: "Eiffel Tower", status: "published", featured: true });
    expect(String(stored.cover)).toStartWith("tours/cover/");
    expect(stored.categoryId).toBe((await env.categories.list()).items[0]!.id);

    // Edit.
    await row.getByRole("link", { name: "Edit Eiffel Tower" }).click();
    await page.getByLabel("Title").waitFor();
    expect(await page.inputValue("#f-categoryId")).toBe(stored.categoryId);
    // The stored image is shown through the authorized file URL and served as image/png.
    const src = await page.locator(".preview img").getAttribute("src");
    expect(src).toContain("/admin/api/tours/");
    const served = await page.evaluate(async (u: string) => {
      const r = await fetch(u);
      return [r.status, r.headers.get("content-type")];
    }, src!);
    expect(served).toEqual([200, "image/png"]);
    await page.getByLabel("Title").fill("Eiffel Tower (Paris)");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("row", { name: /Eiffel Tower \(Paris\)/ }).waitFor();

    // Sort by clicking a column header.
    await page.getByRole("button", { name: "Title" }).click();
    await page.waitForFunction(() => location.hash.includes("sort=title"));

    // Delete with the confirmation dialog.
    await page.getByRole("button", { name: "Delete Eiffel Tower (Paris)" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page.getByText("No tours yet.").waitFor();
    expect((await env.tours.list()).total).toBe(0);

    const audit = (await env.audit.list({ limit: 100 })).items.map((e) => `${e.resource}:${e.action}`);
    expect(audit).toEqual(["categories:create", "tours:create", "tours:upload", "tours:update", "tours:delete"]);
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);

  test("phone width: no horizontal scroll, menu toggles navigation, dark theme toggle", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 720 }, colorScheme: "light" });
    await context.request.post(`${base}/login?as=admin`);
    const page = await context.newPage();
    await page.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Tours" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await page.locator("#nav").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Show navigation" }).click();
    expect(await page.locator("#nav").isVisible()).toBe(true);
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    expect(await bg()).not.toBe(light);
    await context.close();
  }, 60_000);
});
