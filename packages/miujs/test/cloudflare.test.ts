import { expect, test } from "bun:test";
import { definePlugin, miu } from "../src/index.ts";

test("inspect() merges the Cloudflare bindings plugins need", async () => {
  const app = miu({
    plugins: [
      definePlugin({ name: "a", cloudflare: () => ({ kv: ["CACHE"], d1: ["DB"] }) }),
      definePlugin({ name: "b", cloudflare: () => ({ kv: ["CACHE", "SESSIONS"], queues: { producers: ["JOBS"], consumers: ["JOBS"] }, crons: ["*/5 * * * *"] }) }),
      definePlugin({ name: "c", cloudflare: () => ({ durableObjects: [{ binding: "MIU_ROOMS", className: "MiuRooms" }] }) }),
      definePlugin({ name: "d" }),
    ],
  });
  await app.ready();
  expect(app.inspect().cloudflare).toEqual({
    kv: ["CACHE", "SESSIONS"],
    d1: ["DB"],
    r2: [],
    queues: { producers: ["JOBS"], consumers: ["JOBS"] },
    durableObjects: [{ binding: "MIU_ROOMS", className: "MiuRooms" }],
    crons: ["*/5 * * * *"],
    assets: undefined,
    workflows: [],
    ratelimits: [],
    ai: undefined,
    vectorize: [],
  });
});

test("inspect() merges static assets, workflows and rate limit bindings", async () => {
  const app = miu({
    plugins: [
      definePlugin({ name: "web", cloudflare: () => ({ assets: { directory: "./dist", notFoundHandling: "single-page-application" } }) }),
      definePlugin({ name: "wf", cloudflare: () => ({ workflows: [{ binding: "FOLLOW_UP", name: "contact-follow-up", className: "FollowUpWorkflow" }] }) }),
      definePlugin({ name: "rl", cloudflare: () => ({ ratelimits: [{ binding: "LOGIN_LIMIT", limit: 10, period: 60 }] }) }),
    ],
  });
  await app.ready();
  const cf = app.inspect().cloudflare;
  expect(cf.assets).toEqual({ directory: "./dist", binding: "ASSETS", notFoundHandling: "single-page-application" });
  expect(cf.workflows).toEqual([{ binding: "FOLLOW_UP", name: "contact-follow-up", className: "FollowUpWorkflow" }]);
  expect(cf.ratelimits).toEqual([{ binding: "LOGIN_LIMIT", limit: 10, period: 60 }]);
});

test("two plugins asking for different asset directories fail at startup", async () => {
  const app = miu({
    plugins: [
      definePlugin({ name: "a", cloudflare: () => ({ assets: { directory: "./dist" } }) }),
      definePlugin({ name: "b", cloudflare: () => ({ assets: { directory: "./public" } }) }),
    ],
  });
  await app.ready();
  expect(() => app.inspect()).toThrow(expect.objectContaining({ code: "MIU_E_CLOUDFLARE_ASSETS_CONFLICT" }));
});
