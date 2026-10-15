// Mutation spot-check for the game-stack security fixes: undo each fix in place, run the test that
// guards it, expect a failure, restore the file. Run: bun scripts/soak/repro/mutate.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
interface Mutant {
  name: string;
  file: string;
  from: string;
  to: string;
  test: string;
  pattern: string;
}

const M: Mutant[] = [
  { name: "msgpack length check", file: "packages/realtime/src/msgpack.ts", from: "  checkCount(r, n, 1);", to: "", test: "packages/realtime/test/security.test.ts", pattern: "100M elements" },
  { name: "generic handler error", file: "packages/realtime/src/room.ts", from: "message: `The ${where} handler failed`,", to: "message: `The ${where} handler failed: ${err instanceof Error ? err.message : String(err)}`,", test: "packages/realtime/test/security.test.ts", pattern: "does not leak" },
  { name: "maxMembers", file: "packages/realtime/src/room.ts", from: "if (this.seats.size >= maxMembers) {", to: "if (false) {", test: "packages/realtime/test/security.test.ts", pattern: "maxMembers" },
  { name: "join timeout", file: "packages/realtime/src/room.ts", from: "    this.awaitJoin(socket.id);\n  }\n\n  /** A socket that", to: "  }\n\n  /** A socket that", test: "packages/realtime/test/security.test.ts", pattern: "never joins" },
  { name: "requireHostKey", file: "packages/realtime/src/room.ts", from: "    if (this.def.requireHostKey) {\n      // Host only", to: "    if (false) {\n      // Host only", test: "packages/realtime/test/security.test.ts", pattern: "requireHostKey: the first joiner" },
  { name: "no promotion with requireHostKey", file: "packages/realtime/src/room.ts", from: `if (seat.player.role === "host" && !this.def.requireHostKey) {`, to: `if (seat.player.role === "host") {`, test: "packages/realtime/test/security.test.ts", pattern: "no player is promoted" },
  { name: "createOnJoin (registry)", file: "packages/realtime/src/registry.ts", from: "      if (def.def.createOnJoin === false) {", to: "      if (false) {", test: "packages/realtime/test/security.test.ts", pattern: "LocalRooms.route" },
  { name: "createOnJoin (route)", file: "packages/realtime/src/plugin.ts", from: "      if (!registry.joinable(type, id)) throw notFound(type, id);", to: "", test: "packages/realtime/test/security.test.ts", pattern: "createOnJoin: false — connecting" },
  { name: "lookups count misses only", file: "packages/realtime/src/plugin.ts", from: "      if (!lookups.allowed(ip, clock.now())) throw limited();", to: "      if (!lookups.take(ip, clock.now())) throw limited();", test: "packages/realtime/test/security.test.ts", pattern: "classroom" },
  { name: "code released on close", file: "packages/realtime/src/plugin.ts", from: "      memoryCodes.delete(code);\n    },", to: "    },", test: "packages/realtime/test/security.test.ts", pattern: "frees its join code" },
  { name: "per-IP cap", file: "packages/realtime/src/plugin.ts", from: "if (ip !== undefined && (perIp.get(ip) ?? 0) >= maxPerIp) {", to: "if (false) {", test: "packages/realtime/test/security.test.ts", pattern: "maxConnectionsPerIp" },
  { name: "DO internal host", file: "packages/realtime/src/cloudflare.ts", from: `if (url.hostname !== "miu-room") return`, to: `if (false) return`, test: "packages/realtime/test/security.test.ts", pattern: "internal endpoints" },
  { name: "MCP operator gate", file: "packages/realtime/src/plugin.ts", from: `    if (mcpAccess === "public") return;`, to: `    return;`, test: "packages/realtime/test/security.test.ts", pattern: "operator tools" },
  { name: "slow consumer close", file: "packages/realtime/src/room.ts", from: `=== 0) this.dropSlow(socket);`, to: `=== 0) void 0;`, test: "packages/realtime/test/security.test.ts", pattern: "frames the server drops" },
  { name: "game ban on kick", file: "packages/game/src/room.ts", from: `if (g.banned?.includes(tk.userId)) throw`, to: `if (false) throw`, test: "packages/game/test/security.test.ts", pattern: "kicked player" },
  { name: "game name from ticket", file: "packages/game/src/room.ts", from: "        nameFromTicket(ctx.player, admitted.seat);\n", to: "", test: "packages/game/test/security.test.ts", pattern: "display name" },
  { name: "game requireHostKey", file: "packages/game/src/room.ts", from: "    requireHostKey: def.requireHostKey ?? true,", to: "", test: "packages/game/test/security.test.ts", pattern: "first-joiner host" },
  { name: "game createOnJoin", file: "packages/game/src/room.ts", from: "    createOnJoin: def.createOnJoin ?? false,", to: "", test: "packages/game/test/security.test.ts", pattern: "resume-only" },
  { name: "lobby guess limit", file: "packages/game/src/lobbies.ts", from: "if (!keys.every((k) => guesses.allowed(k, now))) throw", to: "if (false) throw", test: "packages/game/test/security.test.ts", pattern: "brute forced" },
  { name: "lobby create limit", file: "packages/game/src/lobbies.ts", from: "if (!creates.take(ctx.user.id, clock.now())) throw", to: "if (false) throw", test: "packages/game/test/security.test.ts", pattern: "creation is rate limited" },
  { name: "nonce in DB", file: "packages/game/src/leaderboard.ts", from: "if (claimed.meta.changes !== 1) throw", to: "if (false) throw", test: "packages/game/test/security.test.ts", pattern: "replayed on another isolate" },
  { name: "quiz requireHostKey", file: "examples/quiz/room.ts", from: "    requireHostKey: true,\n", to: "", test: "examples/quiz/test/security.test.ts", pattern: "does not become host" },
  { name: "quiz createOnJoin", file: "examples/quiz/room.ts", from: "    createOnJoin: false,\n", to: "", test: "examples/quiz/test/security.test.ts", pattern: "only exist" },
  { name: "quiz create limit", file: "examples/quiz/app.ts", from: `if (!creates.take(ip ?? "unknown", Date.now())) {`, to: `if (false) {`, test: "examples/quiz/test/security.test.ts", pattern: "rate limited per IP" },
  { name: "patchBatchMs", file: "packages/realtime/src/room.ts", from: "else if (batchMs > 0) this.flushLazy(patch, batchMs, from, delta);", to: "else if (false) this.flushLazy(patch, batchMs, from, delta);", test: "packages/realtime/test/batch.test.ts", pattern: "coalesced" },
  { name: "batch rollback point", file: "packages/realtime/src/room.ts", from: "(delta.length ? applyCloned(from, delta) : from)", to: "(from)", test: "packages/realtime/test/batch.test.ts", pattern: "rolls back only itself" },
];

let survived = 0;
for (const m of M) {
  const path = join(root, m.file);
  const orig = readFileSync(path, "utf8");
  if (!orig.includes(m.from)) {
    console.log(`?? ${m.name}: pattern not found`);
    survived++;
    continue;
  }
  writeFileSync(path, orig.replace(m.from, m.to));
  try {
    const p = Bun.spawnSync([process.execPath, "test", m.test, "-t", m.pattern], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString() + p.stderr.toString();
    const killed = p.exitCode !== 0 && /\(fail\)/.test(out);
    console.log(`${killed ? "killed  " : "SURVIVED"} ${m.name}`);
    if (!killed) survived++;
  } finally {
    writeFileSync(path, orig);
  }
}
console.log(`${M.length - survived}/${M.length} mutants killed`);
process.exit(survived ? 1 : 0);
