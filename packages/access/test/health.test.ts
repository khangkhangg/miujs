// Memory and exit health of @miujs/access: per-request membership lookups must not cache
// unboundedly, across many users and orgs.
import { expect, test } from "bun:test";
import { miu, route } from "miujs";
import { sqlite } from "@miujs/db";
import { join } from "node:path";
import { describeLeak, exitCheck, leakCheck } from "../../../scripts/lib/leak.ts";
import { access, accessStore, defineRoles, tenantScope } from "../src/index.ts";
import { testAuth } from "./helpers.ts";

const PKG = join(import.meta.dir, "..");

test("org-scoped requests from many users and orgs do not leak", async () => {
  const database = sqlite();
  const store = accessStore(database);
  const users: Record<string, { roles: string[] }> = {};
  const orgs: string[] = [];
  for (let i = 0; i < 100; i++) {
    users[`u${i}`] = { roles: [] };
    orgs.push((await store.createOrg({ name: `Org ${i}`, ownerId: `u${i}` })).id);
  }
  const roles = defineRoles({ owner: ["*"], member: ["contacts:read"] });
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [testAuth(users), access({ roles, database })],
    routes: [route.get("/contacts", { auth: "required", handler: (c) => ({ org: tenantScope(c), ok: c.can("contacts:read") }) })],
  });
  const r = await leakCheck("org-scoped request", async (i) => {
    const n = i % 100;
    // Own org (member) and someone else's (403): both look up membership.
    const org = i % 2 ? orgs[n] : orgs[(n + 1) % 100];
    const res = await app.fetch(new Request("http://x.test/contacts", { headers: { "x-user": `u${n}`, "x-org-id": org } }));
    expect(res.status).toBe(i % 2 ? 200 : 403);
    await res.arrayBuffer();
  }, { perRound: 2000, rounds: 6, warmup: 1000 });
  if (process.env.MIU_LEAK_VERBOSE) console.log(describeLeak(r));
  expect(r.leaking, describeLeak(r)).toBe(false);
}, 120_000);

test("an app using access() exits after work, and after listen + stop", async () => {
  const r = await exitCheck(`
    import { miu, route } from "miujs";
    import { sqlite } from "@miujs/db";
    import { access, accessStore, defineRoles } from "../src/index.ts";
    const database = sqlite();
    const org = await accessStore(database).createOrg({ name: "A", ownerId: "u1" });
    const app = miu({ logLevel: "silent", plugins: [access({ roles: defineRoles({ owner: ["*"] }), database })],
      routes: [route.get("/", { handler: (c) => ({ org: c.org }) })] });
    await app.ready();
    await (await app.fetch(new Request("http://x/", { headers: { "x-org-id": org.id } }))).text();
    const s = await app.listen(0, "127.0.0.1");
    await (await fetch(s.url)).text();
    await s.stop();
  `, 3000, PKG);
  expect(r.exited, r.stderr).toBe(true);
}, 10_000);
