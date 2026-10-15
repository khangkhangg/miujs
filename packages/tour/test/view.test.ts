import { describe, expect, test } from "bun:test";
import { secureHeaders } from "@miujs/web";
import { call, editor, json, seedTour, setup } from "./helpers.ts";

async function published(over: Record<string, unknown> = {}, opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  const seeded = await seedTour(ctx.app);
  await call(ctx.app, `/tours/${seeded.tour.id}`, json("PATCH", { status: "published", visibility: "public", ...over }, editor));
  return { ...ctx, ...seeded };
}

const cspNonce = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
const scriptNonces = (html: string) => [...html.matchAll(/<script\b[^>]*\bnonce="([^"]+)"/g)].map((m) => m[1]);

describe("GET /tours/:tour/view", () => {
  test("serves the viewer page with its own CSP; every script uses the CSP nonce", async () => {
    const { app } = await published({ allowedEmbedOrigins: ["https://listings.example.com"] });
    const r = await call(app, "/tours/12-elm-st/view");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors https://listings.example.com");
    const nonce = cspNonce(csp)!;
    expect(nonce.length).toBeGreaterThan(10);
    const used = scriptNonces(r.text);
    expect(used.length).toBeGreaterThan(2);
    expect(new Set(used)).toEqual(new Set([nonce]));
    expect(r.text).toContain('"manifestUrl":"/tours/12-elm-st/manifest.json"');
    expect(r.text).toContain('id="miu-tour-manifest"');
  });

  test("a fresh nonce per request", async () => {
    const { app } = await published();
    const a = cspNonce((await call(app, "/tours/12-elm-st/view")).headers.get("content-security-policy")!);
    const b = cspNonce((await call(app, "/tours/12-elm-st/view")).headers.get("content-security-policy")!);
    expect(a).not.toBe(b);
  });

  test("not embeddable elsewhere by default", async () => {
    const { app } = await published();
    expect((await call(app, "/tours/12-elm-st/view")).headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  test("works with secureHeaders: reuses its nonce and keeps the tour's frame-ancestors", async () => {
    const { app } = await published({ allowedEmbedOrigins: ["https://listings.example.com"] }, { plugins: [secureHeaders({ csp: true })] });
    const r = await call(app, "/tours/12-elm-st/view");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors https://listings.example.com");
    expect(new Set(scriptNonces(r.text))).toEqual(new Set([cspNonce(csp)!]));
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test('privacy "strict" refuses CDN assets until the viewer is self-hosted', async () => {
    const { app } = await published({ privacy: "strict" });
    const r = await call(app, "/tours/12-elm-st/view");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("MIU_E_TOUR_STRICT_CDN");
    expect(r.body.error.fix).toContain("staticFiles");
    const self = await published({ privacy: "strict" }, { viewerAssets: { basePath: "/vendor/tour" } });
    const ok = await call(self.app, "/tours/12-elm-st/view");
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain("cdn.jsdelivr.net");
    expect(ok.headers.get("content-security-policy")).not.toContain("jsdelivr");
  });

  test("private tours show a lock page; share links open them without leaking the link", async () => {
    const { app, tour } = await published({ visibility: "private" });
    const locked = await call(app, "/tours/12-elm-st/view");
    expect(locked.status).toBe(401);
    expect(locked.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(locked.text).toContain("share link");
    expect(locked.text).not.toContain('name="password"');
    const share = (await call(app, `/tours/${tour.id}/share`, json("POST", {}, editor))).body;
    const r = await call(app, `/tours/12-elm-st/view?share=${share.token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.text).toContain(`"manifestUrl":"/tours/12-elm-st/manifest.json?share=${share.token}"`);
    expect(r.text).toContain('<meta name="robots" content="noindex">');
  });

  test("password tours show a password form under the same CSP nonce", async () => {
    const { app } = await published({ password: "hunter22" });
    const r = await call(app, "/tours/12-elm-st/view");
    expect(r.status).toBe(401);
    expect(r.text).toContain('<form class="miu-tour-unlock"');
    expect(r.text).toContain('name="password"');
    const nonce = cspNonce(r.headers.get("content-security-policy")!);
    expect(new Set(scriptNonces(r.text))).toEqual(new Set([nonce!]));
  });

  test("?live=<code> adds the guided tour client when live tours are on", async () => {
    const live = { createRoom: async () => ({ id: "r1", code: "123456" }), inspect: () => ({ path: "/rooms/:type/:id" }) };
    const { app } = await published({}, { live });
    const r = await call(app, "/tours/12-elm-st/view?live=123456");
    expect(r.text).toContain('"code":"123456","roomsPath":"/rooms"');
    expect((await call(app, "/tours/12-elm-st/view?live=12x456")).text).not.toContain('id="miu-tour-live"');
    const off = await published();
    expect((await call(off.app, "/tours/12-elm-st/view?live=123456")).text).not.toContain('id="miu-tour-live"');
  });

  test("asset origins from a separate files host are allowed by the CSP", async () => {
    const { app } = await published({}, { filesPublicUrl: "https://files.example.com" } as any);
    await call(app, `/tours/12-elm-st/floorplans/0`, json("PUT", { imageKey: "p.png", markers: [] }, editor));
    const csp = (await call(app, "/tours/12-elm-st/view")).headers.get("content-security-policy")!;
    expect(csp).toMatch(/img-src [^;]*https:\/\/files\.example\.com/);
  });

  test("drafts are not viewable", async () => {
    const { app } = await published({ status: "draft" });
    expect((await call(app, "/tours/12-elm-st/view")).status).toBe(404);
  });
});
