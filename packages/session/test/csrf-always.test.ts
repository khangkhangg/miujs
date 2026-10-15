import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { session } from "../src/index.ts";
import { SECRET } from "./helpers.ts";

// Routes tagged "csrf-always" (sign-in forms) get the Origin check even without a session cookie,
// so a cross-site form can't log a victim into an attacker's account (login CSRF).
function app() {
  return miu({
    logLevel: "silent",
    plugins: [session({ secret: SECRET, trustedOrigins: ["https://partner.example"] })],
    routes: [
      route.post("/login", { tags: ["csrf-always"], handler: () => "ok" }),
      route.post("/plain", { handler: () => "ok" }),
    ],
  });
}
const post = (path: string, headers: Record<string, string>) => app().fetch(new Request(`http://localhost${path}`, { method: "POST", headers }));

describe("csrf-always routes without a cookie", () => {
  test("cross-site Origin is rejected", async () => {
    const res = await post("/login", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MIU_E_CSRF");
  });

  test("Sec-Fetch-Site: cross-site is rejected even without Origin", async () => {
    expect((await post("/login", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("same-origin and trusted origins are allowed", async () => {
    expect((await post("/login", { origin: "http://localhost" })).status).toBe(200);
    expect((await post("/login", { origin: "https://partner.example" })).status).toBe(200);
  });

  test("non-browser clients without Origin are allowed", async () => {
    expect((await post("/login", {})).status).toBe(200);
  });

  test("untagged routes without a cookie are not checked", async () => {
    expect((await post("/plain", { origin: "https://evil.example" })).status).toBe(200);
  });
});
