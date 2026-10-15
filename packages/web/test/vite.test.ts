import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { miu, route } from "miujs";
import { html, render, vite, type ViteOptions } from "../src/index.ts";

const dist = join(import.meta.dir, "fixtures", "vite-dist");
const manifestJson = await Bun.file(join(dist, ".vite", "manifest.json")).json();

async function errorOf(fn: () => unknown): Promise<any> {
  try {
    await fn();
  } catch (e) {
    expect((e as any).fix).toBeTruthy();
    return e;
  }
  throw new Error("expected an error");
}

let devServer: ReturnType<typeof Bun.serve>;
const seen: { path: string; headers: Record<string, string>; method: string }[] = [];
let devUrl: string;

beforeAll(() => {
  devServer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      seen.push({ path: u.pathname + u.search, headers: Object.fromEntries(req.headers), method: req.method });
      if (u.pathname === "/src/main.ts") return new Response("export const hmr = true;", { headers: { "content-type": "text/javascript" } });
      if (u.pathname === "/teapot") return new Response("short and stout", { status: 418 });
      return new Response("<!doctype html><script type=module src=/@vite/client></script>", { headers: { "content-type": "text/html" } });
    },
  });
  devUrl = `http://localhost:${devServer.port}`;
});

afterAll(() => devServer.stop(true));

const api = route.get("/api/x", { handler: () => ({ api: true }) });

function appWith(opts: ViteOptions, dev = true) {
  const v = vite(opts);
  const home = route.get("/", { handler: () => render(html`<head>${v.assetTags("src/main.ts")}</head>`) });
  const app = miu({ routes: [api, home], plugins: [v], logLevel: "silent", dev });
  return { app, v };
}

describe("vite() in production", () => {
  test("assetTags emits CSS, the module script and modulepreloads from the manifest", async () => {
    const { app, v } = appWith({ dist }, false);
    await app.ready();
    expect(String(v.assetTags("src/main.ts"))).toBe(
      [
        '<link rel="stylesheet" href="/assets/main-Dk2j3l4m.css">',
        '<link rel="stylesheet" href="/assets/shared-Aa1b2c3d.css">',
        '<script type="module" src="/assets/main-BxY12abc.js"></script>',
        '<link rel="modulepreload" href="/assets/shared-Cq3x9kLm.js">',
        '<link rel="modulepreload" href="/assets/vendor-Zz9y8x7w.js">',
      ].join("\n"),
    );
    expect(String(v.assetTags("src/admin.ts"))).toBe('<script type="module" src="/assets/admin-Pp0o9i8u.js"></script>');
  });

  test("works in a page and with a base path and nonce", async () => {
    const { app } = appWith({ dist }, false);
    const res = await app.request("/");
    expect(await res.text()).toContain('<script type="module" src="/assets/main-BxY12abc.js"></script>');
    const b = vite({ dist, base: "/app/" });
    await miu({ plugins: [b], logLevel: "silent", dev: false }).ready();
    expect(String(b.assetTags("src/admin.ts", { nonce: "abc" }))).toBe('<script type="module" src="/app/assets/admin-Pp0o9i8u.js" nonce="abc"></script>');
  });

  test("serves dist through staticFiles with immutable caching", async () => {
    const { app } = appWith({ dist }, false);
    const res = await app.request("/assets/main-BxY12abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe('console.log("main")');
    expect(await (await app.request("/api/x")).json()).toEqual({ api: true });
  });

  test("the manifest directory itself is not served", async () => {
    const { app } = appWith({ dist }, false);
    expect((await app.request("/.vite/manifest.json")).status).toBe(404);
  });

  test("spa option falls back to index.html for HTML navigations", async () => {
    const { app } = appWith({ dist, spa: "index.html" }, false);
    const res = await app.request("/tours/1", { headers: { accept: "text/html" } });
    expect(await res.text()).toBe('<!doctype html><div id="app"></div>');
  });

  test("a dev URL is ignored when the app is not in dev mode", async () => {
    const { app, v } = appWith({ dist, dev: devUrl }, false);
    await app.ready();
    expect(String(v.assetTags("src/admin.ts"))).toContain("/assets/admin-Pp0o9i8u.js");
  });

  test("a manifest object works without a filesystem (Workers)", async () => {
    const v = vite({ manifest: manifestJson });
    await miu({ plugins: [v], logLevel: "silent", dev: false }).ready();
    expect(String(v.assetTags("src/admin.ts"))).toBe('<script type="module" src="/assets/admin-Pp0o9i8u.js"></script>');
  });

  test("a missing manifest or entry is an error with a fix", async () => {
    const missing = vite({ dist: join(dist, "nope") });
    await miu({ plugins: [missing], logLevel: "silent", dev: false }).ready();
    expect((await errorOf(() => missing.assetTags("src/main.ts"))).code).toBe("MIU_E_WEB_VITE_MANIFEST");
    const { app, v } = appWith({ dist }, false);
    await app.ready();
    const err = await errorOf(() => v.assetTags("src/nope.ts"));
    expect(err.code).toBe("MIU_E_WEB_VITE_ENTRY");
    expect(err.fix).toContain("src/main.ts");
  });

  test("inspect", async () => {
    const { app, v } = appWith({ dist }, false);
    await app.ready();
    expect(v.inspect()).toEqual({ mode: "production", dist, manifest: ".vite/manifest.json", entries: ["src/main.ts", "src/admin.ts"], base: "/" });
  });
});

describe("vite() in dev", () => {
  test("assetTags points at the Vite dev server (HMR client connects there directly)", async () => {
    const { app, v } = appWith({ dev: devUrl });
    await app.ready();
    expect(String(v.assetTags("src/main.ts"))).toBe(
      `<script type="module" src="${devUrl}/@vite/client"></script>\n<script type="module" src="${devUrl}/src/main.ts"></script>`,
    );
    expect(v.inspect()).toEqual({ mode: "dev", dev: devUrl, base: "/" });
  });

  test("proxies unmatched GETs to the dev server; routes still win", async () => {
    const { app } = appWith({ dev: devUrl + "/" });
    seen.length = 0;
    const res = await app.request("/src/main.ts?t=1", { headers: { accept: "*/*", "accept-encoding": "gzip, br", "x-custom": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(await res.text()).toBe("export const hmr = true;");
    expect(seen[0].path).toBe("/src/main.ts?t=1");
    expect(seen[0].headers["x-custom"]).toBe("1");
    expect(await (await app.request("/api/x")).json()).toEqual({ api: true });
    expect((await app.request("/teapot")).status).toBe(418);
    expect(seen.map((s) => s.path)).toEqual(["/src/main.ts?t=1", "/teapot"]);
  });

  test("does not proxy POSTs; protocol-relative paths stay on the dev host", async () => {
    const { app } = appWith({ dev: devUrl });
    seen.length = 0;
    expect((await app.request("/src/main.ts", { method: "POST" })).status).toBe(404);
    const res = await app.request(new Request("http://localhost//evil.example/x"));
    expect(res.status).toBe(200);
    // It reached the dev server (Bun may collapse the double slash), not evil.example.
    expect(seen.map((s) => s.path.replace(/^\/+/, "/"))).toEqual(["/evil.example/x"]);
  });

  test("an unreachable dev server is a 502 with a fix", async () => {
    const { app } = appWith({ dev: "http://127.0.0.1:1" });
    const res = await app.request("/src/main.ts");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("MIU_E_WEB_VITE_DEV_UNREACHABLE");
    expect(body.error.fix).toContain("vite");
  });

  test("invalid dev URL is a config error", async () => {
    expect((await errorOf(() => vite({ dev: "localhost:5173" }))).code).toBe("MIU_E_WEB_CONFIG");
  });
});
