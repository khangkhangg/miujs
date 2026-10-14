import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { memoryStore } from "../../src/batteries/store/index.ts";
import { cache, remember } from "../../src/batteries/cache.ts";

const setup = (opts: Partial<Parameters<typeof cache>[0]> = {}) => {
  let t = 1_000_000;
  const store = memoryStore({ now: () => t });
  const app = new Miu({ logger: false });
  let calls = 0;
  app.use(cache({ store, ttl: 30, ...opts }));
  app.get("/x", (c) => {
    calls++;
    c.header("x-custom", "yes");
    return { n: calls, lang: c.req.headers.get("accept-language") };
  });
  app.post("/x", () => ({ n: ++calls }));
  app.get("/cookie", (c) => {
    calls++;
    c.setCookie("s", "1");
    return "c";
  });
  app.get("/nostore", (c) => {
    calls++;
    c.header("cache-control", "no-store");
    return "n";
  });
  app.get("/private", (c) => {
    calls++;
    c.header("cache-control", "private, max-age=60");
    return "p";
  });
  app.get("/err", () => {
    calls++;
    return new Response("nope", { status: 500 });
  });
  app.get("/bin", () => {
    calls++;
    return new Response(new Uint8Array([0, 1, 2, 255, 128]), { headers: { "content-type": "application/octet-stream" } });
  });
  return { app, store, calls: () => calls, advance: (ms: number) => (t += ms) };
};

describe("cache middleware", () => {
  test("MISS then HIT with body and headers intact", async () => {
    const { app, calls } = setup();
    const a = await app.request("/x");
    expect(a.headers.get("x-miu-cache")).toBe("MISS");
    expect(await a.json()).toEqual({ n: 1, lang: null });
    const b = await app.request("/x");
    expect(b.status).toBe(200);
    expect(b.headers.get("x-miu-cache")).toBe("HIT");
    expect(b.headers.get("x-custom")).toBe("yes");
    expect(b.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await b.json()).toEqual({ n: 1, lang: null });
    expect(calls()).toBe(1);
  });

  test("expires after ttl", async () => {
    const { app, advance } = setup();
    await app.request("/x");
    advance(31_000);
    const res = await app.request("/x");
    expect(res.headers.get("x-miu-cache")).toBe("MISS");
    expect(await res.json()).toEqual({ n: 2, lang: null });
  });

  test("query string is part of the key", async () => {
    const { app } = setup();
    await app.request("/x?a=1");
    expect((await app.request("/x?a=2")).headers.get("x-miu-cache")).toBe("MISS");
    expect((await app.request("/x?a=1")).headers.get("x-miu-cache")).toBe("HIT");
  });

  test("vary headers are part of the key", async () => {
    const { app } = setup({ vary: ["accept-language"] });
    await app.request("/x", { headers: { "accept-language": "en" } });
    const fr = await app.request("/x", { headers: { "accept-language": "fr" } });
    expect(fr.headers.get("x-miu-cache")).toBe("MISS");
    expect(await fr.json()).toEqual({ n: 2, lang: "fr" });
    expect((await app.request("/x", { headers: { "accept-language": "en" } })).headers.get("x-miu-cache")).toBe("HIT");
  });

  test("does not cache set-cookie, no-store, private or non-200", async () => {
    const { app, calls } = setup();
    for (const p of ["/cookie", "/nostore", "/private", "/err"]) {
      await app.request(p);
      const res = await app.request(p);
      expect(res.headers.get("x-miu-cache")).toBe("MISS");
    }
    expect(calls()).toBe(8);
  });

  test("ignores non-GET methods by default", async () => {
    const { app, calls } = setup();
    await app.request("/x", { method: "POST" });
    const res = await app.request("/x", { method: "POST" });
    expect(res.headers.get("x-miu-cache")).toBeNull();
    expect(calls()).toBe(2);
  });

  test("skips authorized requests unless allowed", async () => {
    const { app, calls } = setup();
    const auth = { headers: { authorization: "Bearer t" } };
    await app.request("/x", auth);
    const res = await app.request("/x", auth);
    expect(res.headers.get("x-miu-cache")).toBeNull();
    expect(calls()).toBe(2);

    const allowed = setup({ allowAuthorized: true });
    await allowed.app.request("/x", auth);
    expect((await allowed.app.request("/x", auth)).headers.get("x-miu-cache")).toBe("HIT");
  });

  test("round-trips binary bodies", async () => {
    const { app } = setup();
    const a = new Uint8Array(await (await app.request("/bin")).arrayBuffer());
    const res = await app.request("/bin");
    expect(res.headers.get("x-miu-cache")).toBe("HIT");
    const b = new Uint8Array(await res.arrayBuffer());
    expect([...b]).toEqual([0, 1, 2, 255, 128]);
    expect([...a]).toEqual([...b]);
  });

  test("custom key", async () => {
    const { app } = setup({ key: () => "same" });
    await app.request("/x?a=1");
    expect((await app.request("/x?a=2")).headers.get("x-miu-cache")).toBe("HIT");
  });
});

describe("remember", () => {
  test("computes once, then returns cached value", async () => {
    const store = memoryStore();
    let n = 0;
    const fn = async () => ({ v: ++n });
    expect(await remember(store, "k", 60, fn)).toEqual({ v: 1 });
    expect(await remember(store, "k", 60, fn)).toEqual({ v: 1 });
    expect(n).toBe(1);
    expect(await store.ttl("k")).toBe(60);
  });

  test("coalesces concurrent calls", async () => {
    const store = memoryStore();
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = async () => {
      n++;
      await gate;
      return "value";
    };
    const p1 = remember(store, "k", 60, fn);
    const p2 = remember(store, "k", 60, fn);
    release();
    expect(await Promise.all([p1, p2])).toEqual(["value", "value"]);
    expect(n).toBe(1);
  });

  test("does not cache failures", async () => {
    const store = memoryStore();
    let n = 0;
    const fn = async () => {
      if (++n === 1) throw new Error("fail");
      return 2;
    };
    await expect(remember(store, "k", 60, fn)).rejects.toThrow("fail");
    expect(await remember(store, "k", 60, fn)).toBe(2);
  });
});
