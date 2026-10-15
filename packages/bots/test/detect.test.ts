import { describe, expect, test } from "bun:test";
import { detectVisitor, type DetectOptions } from "../src/index.ts";
import { BROWSER_HEADERS, CHROME, SAFARI, cfRequest } from "./helpers.ts";

const req = (headers: Record<string, string>, url = "https://example.com/") => new Request(url, { headers });
const workers: DetectOptions = { runtime: "workerd" };

describe("detectVisitor: user agent and headers", () => {
  test("a browser sending what browsers send is human", () => {
    expect(detectVisitor(req(BROWSER_HEADERS))).toMatchObject({ kind: "human", verified: false, access: "full" });
  });

  test("a browser user agent without accept-language is unknown", () => {
    const { "accept-language": _, ...h } = BROWSER_HEADERS;
    expect(detectVisitor(req(h)).kind).toBe("unknown");
  });

  test("Chromium without sec-fetch-* is unknown on https, but not on plain http where Chrome omits them", () => {
    const { "sec-fetch-mode": _, "sec-fetch-site": __, ...h } = BROWSER_HEADERS;
    expect(detectVisitor(req(h, "https://example.com/")).kind).toBe("unknown");
    expect(detectVisitor(req(h, "http://example.com/")).kind).toBe("human");
    // Behind a TLS-terminating proxy the scheme comes from x-forwarded-proto (it can only make a request look less human).
    expect(detectVisitor(req({ ...h, "x-forwarded-proto": "https" }, "http://example.com/")).kind).toBe("unknown");
    // localhost is a secure context.
    expect(detectVisitor(req(h, "http://localhost:3000/")).kind).toBe("unknown");
  });

  test("Safari is not required to send sec-fetch-*", () => {
    expect(detectVisitor(req({ "user-agent": SAFARI, "accept-language": "en" })).kind).toBe("human");
  });

  test("no user agent, or a non-browser one, is unknown", () => {
    expect(detectVisitor(req({})).kind).toBe("unknown");
    expect(detectVisitor(req({ "user-agent": "MyApp/1.0", "accept-language": "en" })).kind).toBe("unknown");
  });

  test("automation tools are bots, AI crawlers are ai (unverified)", () => {
    expect(detectVisitor(req({ "user-agent": "curl/8.4.0" }))).toMatchObject({ kind: "bot", name: "curl", verified: false });
    expect(detectVisitor(req({ "user-agent": "GPTBot/1.2" }))).toMatchObject({ kind: "ai", name: "GPTBot", verified: false });
  });

  test("a user agent claiming to be a search engine is a bot until verified", () => {
    const v = detectVisitor(req({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }));
    expect(v).toMatchObject({ kind: "bot", name: "Googlebot", verified: false });
  });

  test("Cloudflare headers are ignored off Workers unless trusted, so they cannot be spoofed", () => {
    const h = { ...BROWSER_HEADERS, "user-agent": "Googlebot/2.1", "cf-verified-bot": "true", "cf-ipcountry": "US", "cf-bot-score": "99" };
    expect(detectVisitor(req(h))).toMatchObject({ kind: "bot", verified: false, country: undefined, score: undefined });
    expect(detectVisitor(req(h), { trustCloudflare: true })).toMatchObject({ kind: "search", verified: true, country: "US", score: 99 });
  });

  test("trusted Cloudflare headers give location and score; a low score makes a browser a bot", () => {
    const h = { ...BROWSER_HEADERS, "cf-ipcountry": "DE", "cf-ipcity": "Berlin", "cf-region": "Land Berlin", "cf-ipcontinent": "EU", "cf-bot-score": "12" };
    expect(detectVisitor(req(h), { trustCloudflare: true })).toMatchObject({ kind: "bot", score: 12, country: "DE", city: "Berlin", region: "Land Berlin", continent: "EU" });
  });
});

describe("detectVisitor: Cloudflare request.cf on Workers", () => {
  const cf = { country: "VN", region: "Ho Chi Minh", city: "Ho Chi Minh City", continent: "AS", asn: 7552, asOrganization: "Viettel" };

  test("location fields come from request.cf", () => {
    const v = detectVisitor(cfRequest("https://x/", BROWSER_HEADERS, cf), workers);
    expect(v).toMatchObject({ kind: "human", country: "VN", region: "Ho Chi Minh", city: "Ho Chi Minh City", continent: "AS", asn: 7552, asOrg: "Viettel" });
  });

  test("request.cf is ignored off Workers (a Request object can carry anything)", () => {
    const v = detectVisitor(cfRequest("https://x/", BROWSER_HEADERS, { ...cf, botManagement: { score: 1 } }));
    expect(v).toMatchObject({ kind: "human", country: undefined, score: undefined });
  });

  test("XX (unknown country) is no country", () => {
    expect(detectVisitor(cfRequest("https://x/", BROWSER_HEADERS, { country: "XX" }), workers).country).toBeUndefined();
  });

  test("verifiedBot verifies a search engine claim", () => {
    const v = detectVisitor(cfRequest("https://x/", { "user-agent": "Googlebot/2.1" }, { botManagement: { score: 1, verifiedBot: true }, verifiedBotCategory: "Search Engine Crawler" }), workers);
    expect(v).toMatchObject({ kind: "search", name: "Googlebot", verified: true, score: 1 });
  });

  test("the verified bot category decides the kind when the user agent names nothing", () => {
    const ai = detectVisitor(cfRequest("https://x/", { "user-agent": "Mozilla/5.0 (compatible)" }, { botManagement: { verifiedBot: true }, verifiedBotCategory: "AI Crawler" }), workers);
    expect(ai).toMatchObject({ kind: "ai", verified: true });
    const preview = detectVisitor(cfRequest("https://x/", { "user-agent": "Mozilla/5.0 (compatible)" }, { botManagement: { verifiedBot: true }, verifiedBotCategory: "Page Preview" }), workers);
    expect(preview).toMatchObject({ kind: "bot", verified: true });
  });

  test("a low bot score makes a perfect-looking browser a bot", () => {
    expect(detectVisitor(cfRequest("https://x/", BROWSER_HEADERS, { botManagement: { score: 5 } }), workers)).toMatchObject({ kind: "bot", score: 5 });
  });

  test("a high score outranks the header heuristic, but never upgrades a self-declared bot", () => {
    expect(detectVisitor(cfRequest("https://x/", { "user-agent": CHROME }, { botManagement: { score: 90 } }), workers).kind).toBe("human");
    expect(detectVisitor(cfRequest("https://x/", { "user-agent": "GPTBot/1.2" }, { botManagement: { score: 90 } }), workers).kind).toBe("ai");
    expect(detectVisitor(cfRequest("https://x/", { "user-agent": "curl/8" }, { botManagement: { score: 90 } }), workers).kind).toBe("bot");
  });

  test("passing Cloudflare JavaScript detection makes a browser human", () => {
    expect(detectVisitor(cfRequest("https://x/", { "user-agent": CHROME }, { botManagement: { jsDetection: { passed: true } } }), workers).kind).toBe("human");
  });

  test("the bot score threshold is configurable", () => {
    const r = () => cfRequest("https://x/", BROWSER_HEADERS, { botManagement: { score: 40 } });
    expect(detectVisitor(r(), workers).kind).toBe("human");
    expect(detectVisitor(r(), { ...workers, botScoreThreshold: 50 }).kind).toBe("bot");
  });
});
