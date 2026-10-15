import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeRunner, fixture, linkWorkspace, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

const APP = `import { miu, route } from "miujs";
export default miu({ name: "check-demo", logLevel: "silent", routes: [route.get("/x", { handler: () => "x" })] });
`;

function project(files: Record<string, string> = {}) {
  const dir = tempDir();
  linkWorkspace(dir, ["miujs"]);
  writeFileSync(join(dir, "app.ts"), APP);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("miu check: types", () => {
  test("runs tsc --noEmit through bun x when a tsconfig.json exists, and fails on type errors", async () => {
    const dir = project({ "tsconfig.json": "{}" });
    const { runner, calls } = fakeRunner(() => ({ code: 2, stdout: "app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" }));
    const r = await run(["check"], dir, runner);
    expect(r.code).toBe(1);
    const tsc = calls.find((c) => c.cmd.includes("tsc"))!;
    expect(tsc.cmd.slice(tsc.cmd.indexOf("tsc"))).toEqual(["tsc", "--noEmit", "-p", join(dir, "tsconfig.json")]);
    expect(tsc.cmd.slice(0, tsc.cmd.indexOf("tsc"))).toEqual([process.execPath, "x"]);
    expect(r.out).toContain("MIU_W_TYPECHECK");
    expect(r.out).toContain("TS2322");
  });

  test("a clean typecheck passes", async () => {
    const dir = project({ "tsconfig.json": "{}" });
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const r = await run(["check"], dir, runner);
    expect(r.code).toBe(0);
    expect(r.out).toContain("types ok");
  });

  test("--no-types skips the typecheck", async () => {
    const dir = project({ "tsconfig.json": "{}" });
    const { runner, calls } = fakeRunner(() => ({ code: 2, stdout: "boom" }));
    const r = await run(["check", "--no-types"], dir, runner);
    expect(r.code).toBe(0);
    expect(calls.filter((c) => c.cmd.includes("tsc"))).toHaveLength(0);
  });

  test("no tsconfig.json, no typecheck", async () => {
    const { runner, calls } = fakeRunner();
    const r = await run(["check"], fixture("basic"), runner);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("runs the real tsc from the repo's node_modules", async () => {
    // Inside the repo so `bun x tsc` finds the workspace's TypeScript without downloading it.
    const dir = tempDir(join(import.meta.dir, "..", ".tmp"));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["lib.ts"] }));
    writeFileSync(join(dir, "lib.ts"), "export const n: number = 'not a number';\n");
    writeFileSync(join(dir, "app.ts"), APP);
    linkWorkspace(dir, ["miujs"]);
    const r = await run(["check"], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("TS2322");
  }, 30_000);
});

describe("miu check: Workers bundle", () => {
  test("warns about static node: and bun: imports in code a Worker would bundle", async () => {
    const dir = project({
      "app.ts": `import { miu } from "miujs";\nimport { helper } from "./lib/helper.ts";\nexport default miu({ name: "w", logLevel: "silent" });\nexport { helper };\n`,
      "lib/helper.ts": `import { readFileSync } from "node:fs";\nimport { Database } from "bun:sqlite";\nexport const helper = () => [readFileSync, Database];\nexport const lazy = () => import("node:path");\n`,
    });
    const r = await run(["check", "--no-types"], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("MIU_W_WORKERS_NODE_IMPORT");
    expect(r.out).toMatch(/lib[\\/]helper\.ts imports node:fs/);
    expect(r.out).toMatch(/lib[\\/]helper\.ts imports bun:sqlite/);
    // Dynamic imports load only when called, so they are not reported.
    expect(r.out).not.toContain("node:path");
  });

  test("is an error when the app deploys to Workers (wrangler.toml present)", async () => {
    const dir = project({
      "app.ts": `import { miu } from "miujs";\nimport { readFileSync } from "node:fs";\nexport const r = readFileSync;\nexport default miu({ name: "w", logLevel: "silent" });\n`,
      "wrangler.toml": 'name = "w"\n',
    });
    const r = await run(["check", "--no-types"], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("error MIU_W_WORKERS_NODE_IMPORT");
  });

  test("the core alone bundles cleanly", async () => {
    const r = await run(["check", "--no-types"], project());
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("MIU_W_WORKERS_NODE_IMPORT");
    expect(r.out).toContain("Workers bundle ok");
  });
});
