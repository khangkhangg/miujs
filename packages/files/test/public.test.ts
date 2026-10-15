import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { files, memoryStore } from "../src/index.ts";
import { errorCode, makeApp, SECRET } from "./helpers.ts";

const nowSec = () => Math.floor(Date.now() / 1000);
const payload = (url: string) => JSON.parse(atob(url.split("/").pop()!.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));

describe("signedUrl({ expiresAt })", () => {
  test("an absolute expiry gives the same URL every time", async () => {
    const { inCtx, req } = makeApp();
    const at = nowSec() + 3600;
    const [a, b] = await inCtx(async ({ files }) => {
      await files.put("a.png", "x", { contentType: "image/png" });
      return [await files.signedUrl("a.png", { expiresAt: at }), await files.signedUrl("a.png", { expiresAt: new Date(at * 1000) })];
    });
    expect(a).toBe(b);
    expect(payload(a).e).toBe(at);
    expect((await req(a)).status).toBe(200);
  });

  test("expiresAt is validated: future, within 7 days, not with expiresIn", async () => {
    const { inCtx } = makeApp();
    const code = (o: any) => inCtx(({ files }) => files.signedUrl("a", o)).then(() => "ok", (e) => e.code);
    expect(await code({ expiresAt: nowSec() - 1 })).toBe("MIU_E_FILES_CONFIG");
    expect(await code({ expiresAt: nowSec() + 8 * 86400 })).toBe("MIU_E_FILES_CONFIG");
    expect(await code({ expiresAt: nowSec() + 60, expiresIn: 60 })).toBe("MIU_E_FILES_CONFIG");
    expect(await code({ expiresAt: "tomorrow" })).toBe("MIU_E_FILES_CONFIG");
  });
});

describe('cache: "public"', () => {
  test("the download is publicly cacheable", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("a.png", "x", { contentType: "image/png" });
      return files.signedUrl("a.png", { cache: "public", expiresIn: 600 });
    });
    const cc = (await req(url)).headers.get("cache-control")!;
    expect(cc).toMatch(/^public, max-age=\d+$/);
  });

  test("without expiresAt, public URLs round their expiry up to the hour so they repeat", async () => {
    const { inCtx } = makeApp();
    const [a, b] = await inCtx(async ({ files }) => [await files.signedUrl("a", { cache: "public", expiresIn: 600 }), await files.signedUrl("a", { cache: "public", expiresIn: 600 })]);
    expect(a).toBe(b);
    expect(payload(a).e % 3600).toBe(0);
    expect(payload(a).e - nowSec()).toBeGreaterThanOrEqual(600);
  });

  test("cache is GET only", async () => {
    const { inCtx } = makeApp();
    const err = await inCtx(({ files }) => files.signedUrl("a", { method: "PUT", cache: "public" })).catch((e) => e.code);
    expect(err).toBe("MIU_E_FILES_CONFIG");
  });

  test("private stays the default", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("a", "x");
      return files.signedUrl("a");
    });
    expect((await req(url)).headers.get("cache-control")).toMatch(/^private, /);
  });
});

describe("signedPrefixUrl", () => {
  async function tiles() {
    const ctx = makeApp();
    const base = await ctx.inCtx(async ({ files }) => {
      await files.put("tiles/t1/0/f/0_0.jpg", "TILE", { contentType: "image/jpeg" });
      await files.put("tiles/t1/1/f/1_1.jpg", "TILE2", { contentType: "image/jpeg" });
      await files.put("tiles/t2/0/f/0_0.jpg", "OTHER", { contentType: "image/jpeg" });
      await files.put("tiles/t1.jpg", "SIBLING", { contentType: "image/jpeg" });
      return files.signedPrefixUrl("tiles/t1", { expiresIn: 600, cache: "public" });
    });
    return { ...ctx, base };
  }

  test("one token serves every file under the prefix", async () => {
    const { base, req } = await tiles();
    expect(base).toMatch(/^http:\/\/app\.test\/_files\/p\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const r = await req(`${base}/0/f/0_0.jpg`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("TILE");
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    expect(await (await req(`${base}/1/f/1_1.jpg`)).text()).toBe("TILE2");
  });

  test("nothing outside the prefix", async () => {
    const { base, req } = await tiles();
    expect((await req(`${base}/..%2Ft2%2F0%2Ff%2F0_0.jpg`)).status).toBe(400);
    expect((await req(`${base}/../t2/0/f/0_0.jpg`)).status).not.toBe(200);
    expect((await req(`${base}/0/f/9_9.jpg`)).status).toBe(404);
    const token = base.split("/p/")[1];
    // A prefix token is not a file token, and a file token is not a prefix token.
    expect(await errorCode(await req(`/_files/${token}`))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("a file URL does not work as a prefix URL", async () => {
    const { inCtx, req } = makeApp();
    const url = await inCtx(async ({ files }) => {
      await files.put("tiles/a/b.jpg", "x");
      return files.signedUrl("tiles/a");
    });
    const token = url.split("/_files/")[1];
    expect(await errorCode(await req(`/_files/p/${token}/b.jpg`))).toBe("MIU_E_FILES_TOKEN_INVALID");
  });

  test("validates the prefix", async () => {
    const { inCtx } = makeApp();
    expect(await inCtx(({ files }) => files.signedPrefixUrl("../x")).catch((e) => e.code)).toBe("MIU_E_FILES_KEY_INVALID");
  });
});

describe('app.service("files")', () => {
  test("jobs reach the store outside requests", async () => {
    const store = memoryStore();
    const app = miu({ plugins: [files({ store, secret: SECRET, publicUrl: "https://files.example.com" })], logLevel: "silent" });
    await app.ready();
    const svc = app.service("files");
    await svc.put("jobs/out.txt", "done", { contentType: "text/plain" });
    expect(await (await svc.get("jobs/out.txt"))!.body.getReader().read().then((r) => new TextDecoder().decode(r.value))).toBe("done");
    expect(await store.head("jobs/out.txt")).not.toBeNull();
    expect(svc.store()).toBe(store);
    expect(await svc.signedUrl("jobs/out.txt")).toStartWith("https://files.example.com/_files/");
    expect(svc.forEnv({ FILES_SECRET: "y".repeat(40) }).store()).toBe(store);
  });

  test("without publicUrl, signed URLs from a job are relative", async () => {
    const app = miu({ plugins: [files({ store: memoryStore(), secret: SECRET })], logLevel: "silent" });
    await app.ready();
    expect(await app.service("files").signedUrl("a")).toStartWith("/_files/");
  });
});
