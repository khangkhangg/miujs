// Plugins add typed route options through `RouteExtensions` and read them from `ctx.route.config`.
import { describe, expect, test } from "bun:test";
import { definePlugin, miu, route, type RouteConfig } from "../src/index.ts";

declare module "../src/index.ts" {
  interface RouteExtensions {
    /** A test plugin's per-route option. */
    stamp?: string;
  }
}

describe("RouteExtensions", () => {
  test("extension fields are typed on route configs and reach plugin hooks via ctx.route.config", async () => {
    const seen: (string | undefined)[] = [];
    const stamper = definePlugin({
      name: "stamper",
      onRequest(ctx) {
        seen.push(ctx.route?.config?.stamp);
      },
    });
    const def = route.get("/a", { stamp: "A", handler: () => "a" });
    const app = miu({ logLevel: "silent", plugins: [stamper], routes: [def, route.get("/b", { handler: () => "b" })] });
    await (await app.fetch(new Request("http://localhost/a"))).text();
    await (await app.fetch(new Request("http://localhost/b"))).text();
    expect(seen).toEqual(["A", undefined]);
  });

  test("config is the route's own object, shared by every request (no copy)", async () => {
    const configs: unknown[] = [];
    const def = route.get("/a", { stamp: "A", handler: () => "a" });
    const app = miu({ logLevel: "silent", plugins: [definePlugin({ name: "p", onRequest: (ctx) => void configs.push(ctx.route?.config) })], routes: [def] });
    for (let i = 0; i < 2; i++) await (await app.fetch(new Request("http://localhost/a"))).text();
    expect(configs[0]).toBe(def.config);
    expect(configs[1]).toBe(def.config);
  });

  test("internal routes have no config", async () => {
    let cfg: unknown = "unset";
    const app = miu({ dev: true, logLevel: "silent", plugins: [definePlugin({ name: "p", onRequest: (ctx) => void (cfg = ctx.route?.config) })] });
    await (await app.fetch(new Request("http://localhost/_miu/app.json"))).text();
    expect(cfg).toBeUndefined();
  });

  test("an unknown option is still a type error", () => {
    // @ts-expect-error `nope` is not a route option
    const c: RouteConfig<undefined, undefined, undefined, undefined, false> = { nope: 1, handler: () => "x" };
    expect(c).toBeDefined();
  });
});
