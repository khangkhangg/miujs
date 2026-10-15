// Admin pages protect themselves even when the app has no secureHeaders(): no framing
// (clickjacking on bulk delete / publish buttons) and a script policy that blocks injected code.

import { expect, test } from "bun:test";
import { uiResources } from "./fixtures.ts";
import { uiSetup } from "./harness.ts";

test("admin pages carry frame and script protection by themselves", async () => {
  const h = await uiSetup(uiResources());
  for (const path of ["/admin", "/admin/r/contacts", "/admin/login"]) {
    const r = await h.req("GET", path, { user: path === "/admin/login" ? null : "ann" });
    expect([path, r.status]).toEqual([path, 200]);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-eval");
  }
});
