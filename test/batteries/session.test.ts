import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { session, sessions, type Session } from "../../src/batteries/session.ts";
import { memoryStore, type Store } from "../../src/batteries/store/index.ts";

const SECRET = "s".repeat(32);
const OTHER = "o".repeat(32);

/** Minimal cookie jar that carries Set-Cookie between app.request calls. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    cookies,
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    take(res: Response) {
      for (const sc of res.headers.getSetCookie()) {
        const [pair, ...attrs] = sc.split(";");
        const i = pair!.indexOf("=");
        const k = pair!.slice(0, i).trim();
        const v = pair!.slice(i + 1).trim();
        if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0") || v === "") cookies.delete(k);
        else cookies.set(k, v);
      }
    },
  };
}

function setup(opts: { secret?: string | string[]; store?: Store; rolling?: boolean } = {}) {
  const store = opts.store ?? memoryStore();
  const app = new Miu({ logger: false });
  app.use(sessions({ store, secret: opts.secret ?? SECRET, rolling: opts.rolling }));
  const j = jar();
  const req = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const ch = j.header();
    if (ch) headers.set("cookie", ch);
    const res = await app.request(path, { ...init, headers });
    j.take(res);
    return res;
  };
  return { app, store, jar: j, req };
}

describe("sessions()", () => {
  test("rejects short secrets", () => {
    expect(() => sessions({ store: memoryStore(), secret: "short" })).toThrow(/32/);
    expect(() => sessions({ store: memoryStore(), secret: [SECRET, "short"] })).toThrow(/32/);
    expect(() => sessions({ store: memoryStore(), secret: [] })).toThrow();
  });

  test("does not set a cookie for an untouched session", async () => {
    const { app, req } = setup();
    app.get("/", async (c) => {
      const s = session(c);
      expect(await s.get("x")).toBeUndefined();
      return "ok";
    });
    const res = await req("/");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("persists values across requests with a signed HttpOnly cookie", async () => {
    const { app, req, store } = setup();
    app.post("/set", async (c) => {
      await session(c).set("n", 41);
      return "ok";
    });
    app.get("/get", async (c) => ({ n: await session(c).get("n"), all: await session(c).all() }));

    const res = await req("/set", { method: "POST" });
    const sc = res.headers.getSetCookie();
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatch(/^miu\.sid=[\w-]+\.[\w-]+;/);
    expect(sc[0]).toContain("HttpOnly");
    expect(sc[0]).toContain("Path=/");
    expect(sc[0]).toContain("SameSite=Lax");
    expect(sc[0]).toContain("Max-Age=1209600");

    const id = sc[0]!.split(";")[0]!.split("=")[1]!.split(".")[0]!;
    expect(id).toHaveLength(43); // 32 bytes base64url
    expect(await store.prefix("sess:").ttl(id)).toBe(1209600);

    expect(await (await req("/get")).json()).toEqual({ n: 41, all: { n: 41 } });
  });

  test("a read-only request does not rewrite the session", async () => {
    const { app, req } = setup();
    app.post("/set", async (c) => (await session(c).set("a", 1), "ok"));
    app.get("/get", async (c) => String(await session(c).get("a")));
    await req("/set", { method: "POST" });
    const res = await req("/get");
    expect(await res.text()).toBe("1");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("tampered signature or id yields a fresh session", async () => {
    const { app, req, jar: j } = setup();
    app.post("/set", async (c) => (await session(c).set("a", 1), "ok"));
    app.get("/get", async (c) => ({ id: session(c).id, a: (await session(c).get("a")) ?? null }));
    await req("/set", { method: "POST" });
    const [id, sig] = j.cookies.get("miu.sid")!.split(".");

    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [`${id}.${flip(sig!)}`, `${flip(id!)}.${sig}`, id!, "garbage", `${id}.`]) {
      j.cookies.set("miu.sid", bad);
      const body = (await (await req("/get")).json()) as { id: string; a: unknown };
      expect(body.a).toBeNull();
      expect(body.id).not.toBe(id);
    }
  });

  test("valid signature but unknown id yields a fresh session", async () => {
    const store = memoryStore();
    const { app, req, jar: j } = setup({ store });
    app.post("/set", async (c) => (await session(c).set("a", 1), "ok"));
    app.get("/get", async (c) => ({ a: (await session(c).get("a")) ?? null }));
    await req("/set", { method: "POST" });
    const id = j.cookies.get("miu.sid")!.split(".")[0]!;
    await store.prefix("sess:").delete(id);
    expect(await (await req("/get")).json()).toEqual({ a: null });
  });

  test("key rotation: signs with the first secret, verifies with any", async () => {
    const store = memoryStore();
    const old = setup({ store, secret: OTHER });
    old.app.post("/set", async (c) => (await session(c).set("a", "kept"), "ok"));
    await old.req("/set", { method: "POST" });
    const oldCookie = old.jar.cookies.get("miu.sid")!;

    const rotated = setup({ store, secret: [SECRET, OTHER] });
    rotated.app.get("/get", async (c) => String(await session(c).get("a")));
    rotated.app.post("/touch", async (c) => (await session(c).set("b", 2), "ok"));
    rotated.jar.cookies.set("miu.sid", oldCookie);
    expect(await (await rotated.req("/get")).text()).toBe("kept");

    await rotated.req("/touch", { method: "POST" });
    const newCookie = rotated.jar.cookies.get("miu.sid")!;
    expect(newCookie.split(".")[0]).toBe(oldCookie.split(".")[0]!);
    expect(newCookie).not.toBe(oldCookie); // re-signed with the primary secret

    const fresh = setup({ store, secret: SECRET });
    fresh.app.get("/get", async (c) => String(await session(c).get("a")));
    fresh.jar.cookies.set("miu.sid", oldCookie);
    expect(await (await fresh.req("/get")).text()).toBe("undefined");
  });

  test("flash survives exactly one request", async () => {
    const { app, req } = setup();
    app.post("/save", async (c) => (await session(c).flash("notice", "Saved!"), "ok"));
    app.get("/peek", async (c) => (await session(c).set("other", 1), "ok"));
    app.get("/show", async (c) => ({ notice: (await session(c).flash<string>("notice")) ?? null }));

    await req("/save", { method: "POST" });
    expect(await (await req("/show")).json()).toEqual({ notice: "Saved!" });
    expect(await (await req("/show")).json()).toEqual({ notice: null });

    // Unread flash is still discarded after the next request.
    await req("/save", { method: "POST" });
    await req("/peek");
    expect(await (await req("/show")).json()).toEqual({ notice: null });
  });

  test("delete removes a key", async () => {
    const { app, req } = setup();
    app.post("/set", async (c) => (await session(c).set("a", 1), await session(c).set("b", 2), "ok"));
    app.post("/del", async (c) => (await session(c).delete("a"), "ok"));
    app.get("/all", async (c) => session(c).all());
    await req("/set", { method: "POST" });
    await req("/del", { method: "POST" });
    expect(await (await req("/all")).json()).toEqual({ b: 2 });
  });

  test("regenerate changes the id, keeps data and deletes the old record", async () => {
    const { app, req, store, jar: j } = setup();
    app.post("/set", async (c) => (await session(c).set("cart", [1, 2]), "ok"));
    app.post("/regen", async (c) => {
      const before = session(c).id;
      await session(c).regenerate();
      return { before, after: session(c).id };
    });
    app.get("/all", async (c) => session(c).all());

    await req("/set", { method: "POST" });
    const oldCookie = j.cookies.get("miu.sid")!;
    const { before, after } = (await (await req("/regen", { method: "POST" })).json()) as { before: string; after: string };
    expect(after).not.toBe(before);
    expect(j.cookies.get("miu.sid")!.split(".")[0]).toBe(after);
    expect(await store.prefix("sess:").has(before)).toBe(false);
    expect(await (await req("/all")).json()).toEqual({ cart: [1, 2] });

    j.cookies.set("miu.sid", oldCookie);
    expect(await (await req("/all")).json()).toEqual({});
  });

  test("destroy deletes the record and clears the cookie", async () => {
    const { app, req, store, jar: j } = setup();
    app.post("/set", async (c) => (await session(c).set("a", 1), "ok"));
    app.post("/destroy", async (c) => (await session(c).destroy(), "ok"));
    await req("/set", { method: "POST" });
    const id = j.cookies.get("miu.sid")!.split(".")[0]!;
    const res = await req("/destroy", { method: "POST" });
    const sc = res.headers.getSetCookie();
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatch(/^miu\.sid=;/);
    expect(sc[0]).toContain("Max-Age=0");
    expect(await store.prefix("sess:").has(id)).toBe(false);
    expect(j.cookies.has("miu.sid")).toBe(false);
  });

  test("destroy of a session that never existed sets no cookie", async () => {
    const { app, req } = setup();
    app.post("/destroy", async (c) => (await session(c).destroy(), "ok"));
    const res = await req("/destroy", { method: "POST" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("cookie options and custom name", async () => {
    const app = new Miu();
    app.use(
      sessions({
        store: memoryStore(),
        secret: SECRET,
        cookieName: "sid",
        ttl: 60,
        cookie: { secure: true, sameSite: "Strict", path: "/app", domain: "example.com" },
      }),
    );
    app.post("/", async (c) => (await session(c).set("a", 1), "ok"));
    const sc = (await app.request("/", { method: "POST" })).headers.getSetCookie()[0]!;
    expect(sc).toStartWith("sid=");
    for (const part of ["Max-Age=60", "Path=/app", "Domain=example.com", "HttpOnly", "Secure", "SameSite=Strict"]) {
      expect(sc).toContain(part);
    }
  });

  test("works with handlers that return a Response directly", async () => {
    const { app, req } = setup();
    app.post("/r", async (c) => {
      await session(c).set("a", 1);
      return Response.redirect("http://localhost/next", 303);
    });
    const res = await req("/r", { method: "POST" });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  test("rolling sessions refresh the cookie and TTL on every request", async () => {
    let t = 1_000_000;
    const store = memoryStore({ now: () => t });
    const { app, req } = setup({ store, rolling: true });
    app.post("/set", async (c) => (await session(c).set("a", 1), "ok"));
    app.get("/noop", () => "ok");
    await req("/set", { method: "POST" });
    t += 1000 * 1000;
    const res = await req("/noop");
    const sc = res.headers.getSetCookie();
    expect(sc).toHaveLength(1);
    const id = sc[0]!.split(";")[0]!.split("=")[1]!.split(".")[0]!;
    expect(await store.prefix("sess:").ttl(id)).toBe(1209600);

    const fresh = await setup({ store, rolling: true });
    fresh.app.get("/noop", () => "ok");
    expect((await fresh.req("/noop")).headers.getSetCookie()).toEqual([]);
  });

  test("session(c) throws without the middleware", async () => {
    const app = new Miu({ logger: false });
    let error: unknown;
    app.get("/", (c) => {
      try {
        session(c);
      } catch (e) {
        error = e;
      }
      return "ok";
    });
    await app.request("/");
    expect(String(error)).toMatch(/sessions\(\)/);
  });

  test("c.get('session') exposes the same object", async () => {
    const { app, req } = setup();
    let same = false;
    app.get("/", (c) => {
      same = (c.get("session") as Session) === session(c);
      return "ok";
    });
    await req("/");
    expect(same).toBe(true);
  });
});
