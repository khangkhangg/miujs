// RSS during a burst of concurrent sign-ins with @miujs/auth's default password hashing
// (argon2id via Bun.password at the package defaults: 64 MiB per hash with no cap before the F1 fix,
// 19 MiB and at most 4 at once after it). The printed hash shows the m= cost in use.
//
//   bun scripts/soak/repro/argon2-burst.ts [concurrency=32]
import { hashPassword, verifyPassword } from "../../../packages/auth/src/password.ts";

const n = Number(process.argv[2] ?? 32);
const mb = (b: number) => (b / 1048576).toFixed(0);
const base = process.memoryUsage().rss;
let peak = base;
const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);

const hash = await hashPassword("correct horse battery");
peak = base;
const t = performance.now();
await Promise.all(Array.from({ length: n }, () => verifyPassword("correct horse battery", hash)));
const ms = performance.now() - t;
clearInterval(timer);
await new Promise((r) => setTimeout(r, 200));
console.log(`${n} concurrent verifyPassword (package defaults): RSS before ${mb(base)} MB, peak ${mb(peak)} MB (+${mb(peak - base)} MB), after ${mb(process.memoryUsage().rss)} MB; ${ms.toFixed(0)} ms total, hash ${hash.slice(0, 32)}…`);
