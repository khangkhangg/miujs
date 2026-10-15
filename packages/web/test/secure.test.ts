import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import { html, nonce, render, secureHeaders, type SecureHeadersOptions } from "../src/index.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect((e as any).fix).toBeTruthy();
    return (e as any).code;
  }
  return undefined;
}

const json = route.get("/json", { handler: () => ({ ok: true }) });
const own = route.get("/own", {
  handler: ({ set }) => {
    set.headers.set("x-frame-options", "SAMEORIGIN");
    set.headers.set("content-security-policy", "default-src 'none'");
    return "mine";
  },
});
const redirect = route.get("/go", { handler: () => Response.redirect("http://localhost/json", 302) });
const page = route.get("/page", {
  handler: (ctx) => render(html`<script nonce="${nonce(ctx)}">boot()</script><p>${String(ctx.state.cspNonce)}</p>`),
});

function appWith(opts?: SecureHeadersOptions) {
  return miu({ routes: [json, own, redirect, page], plugins: [secureHeaders(opts)], logLevel: "silent" });
}

describe("secureHeaders defaults", () => {
  test("sets the baseline headers on every response", async () => {
    const res = await appWith().request("/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const pp = res.headers.get("permissions-policy")!;
    for (const part of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()", "fullscreen=(self)"]) expect(pp).toContain(part);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  test("error responses get them too", async () => {
    const res = await appWith().request("/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("responses with immutable headers are copied, not dropped", async () => {
    const res = await appWith().request("/go");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("headers a handler set itself are kept", async () => {
    const res = await appWith().request("/own");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("HSTS", () => {
  test("only on https", async () => {
    const app = appWith();
    const https = await app.request("https://localhost/json");
    expect(https.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    const proxied = await app.request("http://localhost/json", { headers: { "x-forwarded-proto": "https" } });
    expect(proxied.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  test("configurable or off", async () => {
    const custom = await appWith({ hsts: { maxAge: 600, includeSubDomains: false, preload: true } }).request("https://localhost/json");
    expect(custom.headers.get("strict-transport-security")).toBe("max-age=600; preload");
    const off = await appWith({ hsts: false }).request("https://localhost/json");
    expect(off.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("frameAncestors (embedding 3D tours in listing sites)", () => {
  test("'self' maps to SAMEORIGIN", async () => {
    const res = await appWith({ frameAncestors: ["'self'"] }).request("/json");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });

  test("other origins drop X-Frame-Options and list them in CSP", async () => {
    const res = await appWith({ frameAncestors: ["'self'", "https://listings.example.com", "https://*.realestate.example"] }).request("/json");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://listings.example.com https://*.realestate.example");
  });

  test("injection into the policy is refused at startup", () => {
    expect(codeOf(() => secureHeaders({ frameAncestors: ["https://a.com; script-src *"] }))).toBe("MIU_E_WEB_CONFIG");
    expect(codeOf(() => secureHeaders({ frameAncestors: ["https://a.com,https://b.com"] }))).toBe("MIU_E_WEB_CONFIG");
  });
});

describe("CSP with nonce", () => {
  test("csp: true sends a strict default policy with a per-request nonce", async () => {
    const app = appWith({ csp: true });
    const a = await app.request("/page");
    const b = await app.request("/page");
    const csp = a.headers.get("content-security-policy")!;
    const n = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)![1];
    expect(n.length).toBeGreaterThanOrEqual(22);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' 'nonce-${n}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self' blob:");
    const body = await a.text();
    expect(body).toBe(`<script nonce="${n}">boot()</script><p>${n}</p>`);
    expect(b.headers.get("content-security-policy")).not.toBe(csp);
  });

  test("custom directives: camelCase keys, nonce appended to script-src, frame-ancestors merged", async () => {
    const res = await appWith({
      csp: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "https://cdn.example"], "img-src": ["'self'", "data:"], styleSrc: ["'self'", "'unsafe-inline'"] },
      frameAncestors: ["https://listings.example.com"],
    }).request("/page");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^default-src 'self'; script-src 'self' https:\/\/cdn\.example 'nonce-[^']+'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors https:\/\/listings\.example\.com$/);
  });

  test("style-src without 'unsafe-inline' gets the nonce too", async () => {
    const res = await appWith({ csp: { styleSrc: ["'self'"] } }).request("/page");
    expect(res.headers.get("content-security-policy")).toMatch(/style-src 'self' 'nonce-[^']+'/);
  });

  test("directive values cannot inject other directives", () => {
    expect(codeOf(() => secureHeaders({ csp: { scriptSrc: ["'self'; object-src *"] } }))).toBe("MIU_E_WEB_CONFIG");
    expect(codeOf(() => secureHeaders({ csp: { scriptSrc: ["'self';object-src"] } }))).toBe("MIU_E_WEB_CONFIG");
    expect(codeOf(() => secureHeaders({ frameAncestors: ["https://a.com;script-src"] }))).toBe("MIU_E_WEB_CONFIG");
    expect(codeOf(() => secureHeaders({ csp: { "bad name": ["x"] } as any }))).toBe("MIU_E_WEB_CONFIG");
  });

  test("nonce() without a CSP is an error with a fix", async () => {
    const res = await appWith().request("/page");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("MIU_E_WEB_NO_NONCE");
  });
});

describe("Permissions-Policy", () => {
  test("overrides merge with the defaults", async () => {
    const res = await appWith({ permissionsPolicy: { gyroscope: ["self"], "xr-spatial-tracking": ["self", "https://tour.example"], camera: [] } }).request("/json");
    const pp = res.headers.get("permissions-policy")!;
    expect(pp).toContain("gyroscope=(self)");
    expect(pp).toContain('xr-spatial-tracking=(self "https://tour.example")');
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
  });

  test("false turns it off", async () => {
    const res = await appWith({ permissionsPolicy: false }).request("/json");
    expect(res.headers.get("permissions-policy")).toBeNull();
  });
});

describe("secureHeaders inspect", () => {
  test("describes the policy", () => {
    const p = secureHeaders({ frameAncestors: ["https://listings.example.com"], csp: true });
    expect(p.name).toBe("secure-headers");
    const info = p.inspect() as Record<string, unknown>;
    expect(info.frameAncestors).toEqual(["https://listings.example.com"]);
    expect(info.csp).toContain("'nonce-{nonce}'");
    expect(info.hsts).toBe("max-age=31536000; includeSubDomains (https only)");
  });
});
