import { beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage, ROOT, run } from "./helpers.ts";

// Install packages/create-miu next to a node_modules/miujs that points at the local build,
// the same layout `npm create miu` / `bun create miu` produce.
let work = "";
let bin = "";
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

beforeAll(() => {
  const pkgRoot = buildPackage();
  work = mkdtempSync(join(tmpdir(), "create-miu-"));
  const pkgDir = join(work, "node_modules/create-miu");
  cpSync(join(ROOT, "packages/create-miu"), pkgDir, { recursive: true });
  symlinkSync(pkgRoot, join(work, "node_modules/miujs"));
  bin = join(pkgDir, JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin["create-miu"]);
}, 120_000);

test("create-miu package metadata", () => {
  const p = JSON.parse(readFileSync(join(ROOT, "packages/create-miu/package.json"), "utf8"));
  expect(p.name).toBe("create-miu");
  expect(Object.keys(p.bin)).toEqual(["create-miu"]);
  expect(p.dependencies.miujs).toBe(`^${version}`);
  expect(readFileSync(join(ROOT, "packages/create-miu", p.bin["create-miu"]), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  expect(existsSync(join(ROOT, "packages/create-miu/README.md"))).toBe(true);
});

for (const runtime of ["node", "bun"]) {
  test(`scaffolds an app via the miujs CLI under ${runtime}`, () => {
    const cwd = join(work, `run-${runtime}`);
    mkdirSync(cwd);
    const r = run([runtime, bin, "my-app", "--template", "node"], cwd);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Created my-app (node template)");
    const app = JSON.parse(readFileSync(join(cwd, "my-app/package.json"), "utf8"));
    expect(app.name).toBe("my-app");
    expect(app.dependencies.miujs).toBe(`^${version}`);
    expect(existsSync(join(cwd, "my-app/src/server.ts"))).toBe(true);
  });
}

test("defaults the directory and forwards errors with a non-zero exit", () => {
  const cwd = join(work, "defaults");
  mkdirSync(cwd);
  const ok = run(["node", bin], cwd);
  expect(ok.code).toBe(0);
  expect(existsSync(join(cwd, "miu-app/package.json"))).toBe(true);
  const again = run(["node", bin, "miu-app"], cwd);
  expect(again.code).toBe(1);
  expect(again.err).toContain("not empty");
  const help = run(["node", bin, "--help"], cwd);
  expect(help.code).toBe(0);
  expect(help.out).toContain("create-miu");
});
