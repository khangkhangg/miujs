// The default runner (used by `miu dev`, `miu logs`, `miu deploy`, `miu db`) must not leave child
// processes behind: not when it stops a command itself (`miu logs --last N`), and not when the
// CLI is interrupted (Ctrl+C / SIGTERM). Commands such as `bun x wrangler tail` start their own
// children, so the whole process tree has to go.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner } from "../src/util.ts";
import { cleanup, tempDir } from "./helpers.ts";

afterEach(cleanup);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A command that starts a grandchild (like `bun x wrangler` → node) and runs until killed. */
function treeScript(dir: string): string {
  const file = join(dir, "tree.ts");
  writeFileSync(
    file,
    `
    import { writeFileSync } from "node:fs";
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
    console.log("ready");
    setInterval(() => {}, 1000);
    `,
  );
  return file;
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const pidsOf = (file: string) => waitFor(() => (existsSync(file) && readFileSync(file, "utf8") ? (JSON.parse(readFileSync(file, "utf8")) as { parent: number; child: number }) : undefined));

async function gone(pid: number): Promise<boolean> {
  try {
    await waitFor(() => (alive(pid) ? undefined : true), 3000);
    return true;
  } catch {
    process.kill(pid); // don't leave it running after a failed test
    return false;
  }
}

describe("defaultRunner cleans up child processes", () => {
  test("aborting (miu logs --last N) kills the command and its children", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pids.json");
    const stop = new AbortController();
    const done = defaultRunner([process.execPath, treeScript(dir), pidFile], { cwd: dir, signal: stop.signal, onStdout: () => {} });
    const pids = await pidsOf(pidFile);
    stop.abort();
    const r = await done;
    expect(r.code).toBe(0);
    expect(await gone(pids.parent)).toBe(true);
    expect(await gone(pids.child)).toBe(true);
  }, 15_000);

  test("SIGINT to the CLI kills the running command tree", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pids.json");
    const before = process.listenerCount("SIGINT");
    const done = defaultRunner([process.execPath, treeScript(dir), pidFile], { cwd: dir });
    const pids = await pidsOf(pidFile);
    process.emit("SIGINT" as never);
    const r = await Promise.race([done, Bun.sleep(5000).then(() => null)]);
    expect(r).not.toBeNull();
    expect(r!.code).toBe(130);
    expect(await gone(pids.parent)).toBe(true);
    expect(await gone(pids.child)).toBe(true);
    // Its signal handlers are removed once the command is over.
    expect(process.listenerCount("SIGINT")).toBe(before);
  }, 15_000);
});

describe("CLI commands let the process exit on their own (no process.exit)", () => {
  const CLI = join(import.meta.dir, "..");
  test("inspect, test and openapi on an app", async () => {
    const { exitCheck } = await import("../../../scripts/lib/leak.ts");
    const r = await exitCheck(
      `
      import { runCli } from "../src/index.ts";
      const io = { cwd: ${JSON.stringify(join(CLI, "test", "fixtures", "basic"))}, out: () => {}, err: (s: string) => console.error(s) };
      for (const cmd of [["inspect"], ["test"], ["openapi"]]) {
        const code = await runCli(cmd, io);
        if (code !== 0) throw new Error(cmd + " exited " + code);
      }
      `,
      5000,
      CLI,
    );
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 15_000);

  // TODO(@miujs/realtime): loadtest() races each join against sleep(joinTimeoutMs) and never
  // clears that timer, so a script calling it stays alive ~5 s after the report. `miu loadtest`
  // itself exits (bin.ts calls process.exit). Turn this back into test() once realtime clears it.
  test.todo("loadtest closes its sockets and timers", async () => {
    const { exitCheck } = await import("../../../scripts/lib/leak.ts");
    const r = await exitCheck(
      `
      import { miu } from "miujs";
      import { defineRoom, rooms, t } from "@miujs/realtime";
      import { runCli } from "../src/index.ts";
      const counter = defineRoom("counter", { state: t.object({ n: t.number() }), client: { inc: t.object({ by: t.number() }) }, init: () => ({ n: 0 }), on: { inc: ({ room, msg }) => { room.state.n += msg.by; } } });
      const server = await miu({ plugins: [rooms({ rooms: [counter] })], logLevel: "silent" }).listen(0);
      const url = server.url.replace("http", "ws") + "rooms/counter/c1";
      const code = await runCli(["loadtest", url, "--players", "3", "--duration", "300ms", "--rate", "20", "--action", '{"type":"inc","data":{"by":1}}', "--json"], { cwd: ".", out: () => {}, err: (s: string) => console.error(s) });
      await server.stop();
      if (code !== 0) throw new Error("loadtest exited " + code);
      `,
      5000,
      CLI,
    );
    expect(r.exited, r.stderr).toBe(true);
    expect(r.code, r.stderr).toBe(0);
  }, 15_000);
});
