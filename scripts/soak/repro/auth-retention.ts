// What a signed-up user leaves in the heap: register + login + logout for N users, each from a
// new client IP, with @miujs/auth's default in-memory rate limiter vs rateLimit: false.
//   bun scripts/soak/repro/auth-retention.ts [users=1000]
import { heapStats } from "bun:jsc";
import { miu } from "../../../packages/miujs/src/index.ts";
import { auth, dbUserStore } from "../../../packages/auth/src/index.ts";
import { db, sqlite } from "../../../packages/db/src/index.ts";
import { session } from "../../../packages/session/src/index.ts";

const N = Number(process.argv[2] ?? 1000);

async function run(rateLimit: boolean) {
  const source = sqlite(":memory:");
  const app = miu({
    logLevel: "silent",
    dev: false,
    plugins: [db({ database: source }), session({ secret: "x".repeat(48) }), auth({ users: dbUserStore(source), password: { algorithm: "pbkdf2", iterations: 1000 }, ...(rateLimit ? {} : { rateLimit: false }) })],
  });
  await app.ready();
  let ip = "";
  const server = { upgrade: () => false, requestIP: () => ({ address: ip }) };
  const call = async (path: string, body: unknown, cookie = "") => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", cookie }, body: JSON.stringify(body) }), server);
    await res.text();
    return res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  };
  const user = async (i: number) => {
    ip = `10.1.${i >> 8}.${i & 255}`;
    await call("/auth/register", { email: `u${i}@x.test`, password: "password-123" });
    ip = `10.2.${i >> 8}.${i & 255}`;
    const c = await call("/auth/login", { email: `u${i}@x.test`, password: "password-123" });
    await call("/auth/logout", {}, c);
  };
  for (let i = 0; i < 50; i++) await user(100_000 + i); // warm-up
  Bun.gc(true);
  const a = heapStats();
  for (let i = 0; i < N; i++) await user(i);
  Bun.gc(true);
  Bun.gc(true);
  const b = heapStats();
  const obj = (b.objectTypeCounts.Object ?? 0) - (a.objectTypeCounts.Object ?? 0);
  console.log(`rateLimit ${rateLimit ? "default (memory)" : "false"}: +${((b.heapSize - a.heapSize) / N).toFixed(0)} B/user, +${(obj / N).toFixed(2)} Object/user, +${((b.objectCount - a.objectCount) / N).toFixed(2)} objects/user`);
}

await run(true);
await run(false);
