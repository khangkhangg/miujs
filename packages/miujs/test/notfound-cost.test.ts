import { expect, test } from "bun:test";
import { miu, route } from "../src/index.ts";

const routes = Array.from({ length: 300 }, (_, i) => route.get(`/resource${i}/items/:id/details`, { handler: () => "x" }));

test("a 404 for a huge path stays cheap (no CPU amplification from suggestions)", async () => {
  const app = miu({ logLevel: "silent", routes });
  await app.ready();
  const long = "/" + "a".repeat(8000);
  await app.fetch(new Request("http://localhost" + long)); // warm
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) expect((await app.fetch(new Request("http://localhost" + long))).status).toBe(404);
  expect((performance.now() - t0) / 10).toBeLessThan(5);
});

test("typos in normal-length paths still get a did-you-mean fix", async () => {
  const app = miu({ logLevel: "silent", routes });
  const body = await (await app.fetch(new Request("http://localhost/resource12/item/7/details"))).json();
  expect(body.error.fix).toContain("/resource12/items/:id/details");
});
