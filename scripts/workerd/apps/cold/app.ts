// Cold-start / bundle-size fixture: core + session + auth (in-memory users) + cache, nothing else.
import { miu, route } from "miujs";
import { auth, memoryUserStore } from "@miujs/auth";
import { cache } from "@miujs/cache";
import { session } from "@miujs/session";

const me = route.get("/whoami", {
  auth: "optional",
  handler: async ({ user, cache }) => ({ user: user?.id ?? null, hits: await cache.remember("hits", 60, async () => 1) }),
});

export default miu({ name: "cold", logLevel: "warn", routes: [me], plugins: [session(), auth({ users: memoryUserStore() }), cache()] });
