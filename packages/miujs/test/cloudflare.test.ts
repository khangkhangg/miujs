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
  });
});
