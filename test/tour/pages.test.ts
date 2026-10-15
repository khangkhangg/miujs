import { describe, expect, test } from "bun:test";
import { setup } from "./helpers.ts";

const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

describe("pages and assets", () => {
  test("public viewer page: strict CSP with a fresh nonce, no inline handlers, escaped data", async () => {
    const { as, seed } = setup();
    const { tour } = await seed("alice", 2, "</script><script>alert(1)</script>");
    await as("alice").post(`/api/tours/${tour.id}/publish`);
    const res = await as().get(`/t/${tour.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    const nonce = nonceOf(csp)!;
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("/assets/viewer.js");
    const res2 = await as().get(`/t/${tour.slug}`);
    expect(nonceOf(res2.headers.get("content-security-policy")!)).not.toBe(nonce);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("draft viewer pages are 404 except as an owner preview", async () => {
    const { as, seed } = setup();
    const { tour } = await seed("alice", 1);
    expect((await as().get(`/t/${tour.slug}`)).status).toBe(404);
    expect((await as("bob").get(`/t/${tour.slug}`)).status).toBe(404);
    const preview = await as("alice").get(`/t/${tour.slug}`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("Draft preview");
  });

  test("editor requires auth (401, or redirect to loginPath for browsers) and ownership", async () => {
    const { as, seed } = setup();
    const { tour } = await seed("alice", 1);
    expect((await as().get(`/editor/${tour.id}`)).status).toBe(401);
    expect((await as("bob").get(`/editor/${tour.id}`)).status).toBe(403);
    const ok = await as("alice").get(`/editor/${tour.id}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("/assets/editor.js");
    expect((await as("alice").get(`/editor`)).status).toBe(200);

    const s2 = setup({ loginPath: "/login" });
    const r = await s2.as().call(`/editor/x1`, { headers: { accept: "text/html" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login?next=%2Feditor%2Fx1");
  });

  test("serves the client modules as cacheable JavaScript", async () => {
    const { as } = setup();
    for (const f of ["viewer.js", "editor.js", "math.js"]) {
      const res = await as().get(`/assets/${f}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(res.headers.get("etag")).toBeTruthy();
      expect((await res.text()).length).toBeGreaterThan(500);
    }
    const versioned = await as().get(`/assets/viewer.js?v=abc`);
    expect(versioned.headers.get("cache-control")).toContain("max-age");
  });

  test("basePath prefixes every route and the URLs in pages", async () => {
    const { as, seed } = setup({ basePath: "/tours-app" });
    expect((await as("alice").get("/tours-app/api/tours")).status).toBe(200);
    expect((await as("alice").get("/api/tours")).status).toBe(404);
    const html = await (await as("alice").get("/tours-app/editor")).text();
    expect(html).toContain("/tours-app/assets/editor.js");
    void seed;
  });
});
