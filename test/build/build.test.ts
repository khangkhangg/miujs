import { beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackage, ROOT, run as spawn } from "./helpers.ts";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
let pkgRoot = "";
let dist = "";
const run = (cmd: string[]) => spawn(cmd, pkgRoot);

beforeAll(() => {
  pkgRoot = buildPackage();
  dist = join(pkgRoot, "dist");
}, 120_000);

test("every export condition points into src (bun) and dist (types/import/default)", () => {
  for (const [key, value] of Object.entries(pkg.exports as Record<string, Record<string, string>>)) {
    expect(Object.keys(value)).toEqual(["types", "bun", "import", "default"]);
    expect(value.bun).toMatch(/^\.\/src\/.+\.ts$/);
    expect(value.import).toBe(value.default!);
    expect(value.import).toBe(value.bun!.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js"));
    expect(value.types).toBe(value.import!.replace(/\.js$/, ".d.ts"));
    expect(existsSync(join(ROOT, value.bun!))).toBe(true);
    for (const target of [value.import!, value.types!]) {
      expect({ key, target, exists: existsSync(join(pkgRoot, target)) }).toEqual({ key, target, exists: true });
    }
  }
  expect(pkg.bin).toEqual({ miu: "./dist/bin/miu.js" });
  expect(pkg.files).toEqual(expect.arrayContaining(["dist", "src", "bin", "templates"]));
  expect(pkg.main).toBe(pkg.exports["."].import);
  expect(pkg.types).toBe(pkg.exports["."].types);
});

test("emits source maps, declaration maps and .js import specifiers", () => {
  for (const f of ["index.js.map", "index.d.ts.map", "core/app.js.map", "sqlite.js.map"]) {
    expect({ f, exists: existsSync(join(dist, f)) }).toEqual({ f, exists: true });
  }
  const map = JSON.parse(readFileSync(join(dist, "core/app.js.map"), "utf8"));
  expect(map.sources).toEqual(["../../src/core/app.ts"]);
  const js = readFileSync(join(dist, "index.js"), "utf8");
  expect(js).not.toMatch(/from\s+"\.[^"]*\.ts"/);
  expect(js).toContain("//# sourceMappingURL=index.js.map");
  expect(readFileSync(join(dist, "index.d.ts"), "utf8")).not.toMatch(/from\s+"\.[^"]*\.ts"/);
  // Tests and examples are not part of the build.
  expect(existsSync(join(dist, "test"))).toBe(false);
  expect(existsSync(join(dist, "examples"))).toBe(false);
});

test("node dist/bin/miu.js --version runs under plain Node", () => {
  const bin = join(dist, "bin/miu.js");
  expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  const r = run(["node", bin, "--version"]);
  expect(r.err).toBe("");
  expect(r.out.trim()).toBe(pkg.version);
  expect(r.code).toBe(0);
});

test("dist entries import and serve requests under plain Node (no type stripping)", () => {
  const script = join(pkgRoot, "smoke.mjs");
  writeFileSync(
    script,
    `import { Miu } from "./dist/index.js";
import { sqliteStore } from "./dist/sqlite.js";
const app = new Miu().get("/x", (c) => c.json({ ok: true, path: c.url.pathname }));
const res = await app.request("/x");
const store = sqliteStore({ path: ":memory:" });
await store.set("k", "v");
console.log(JSON.stringify({ status: res.status, body: await res.json(), kv: await store.get("k") }));
`,
  );
  const r = run(["node", script]);
  expect(r.err).toBe("");
  expect(JSON.parse(r.out)).toEqual({ status: 200, body: { ok: true, path: "/x" }, kv: "v" });
});
