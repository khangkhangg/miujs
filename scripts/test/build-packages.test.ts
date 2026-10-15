// The npm build: JS for Node, .d.ts for TypeScript, TS source for Bun/Deno, one manifest for all.
// Builds miujs and @miujs/cache for real, then imports the staged packages under real Node.
import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findDeno, findNode, publishManifest, stageDir } from "../build-packages.ts";
import { ROOT, readPackageJson } from "../lib/repo.ts";

const bun = process.execPath;
const run = (args: string[], cwd = ROOT) => {
  const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe("publishManifest", () => {
  test("exports: types for TypeScript, src for Bun, dist JS for Node, Deno and bundlers", () => {
    const m = publishManifest(readPackageJson("miujs"));
    expect(m.exports).toEqual({
      ".": { types: "./dist/types/index.d.ts", bun: "./src/index.ts", default: "./dist/index.js" },
      "./node": { types: "./dist/types/node.d.ts", bun: "./src/node.ts", default: "./dist/node.js" },
      "./package.json": "./package.json",
    });
    expect(Object.keys(m.exports["."] as object)).toEqual(["types", "bun", "default"]);
    expect(m.main).toBe("./dist/index.js");
    expect(m.types).toBe("./dist/types/index.d.ts");
    expect(m.files).toEqual(expect.arrayContaining(["src", "dist", "README.md", "LICENSE"]));
    expect(m.type).toBe("module");
  });

  test("workspace deps become version ranges; dev deps are dropped; scoped packages publish publicly", () => {
    const m = publishManifest(readPackageJson("db"));
    expect(m.dependencies).toEqual({ miujs: `^${readPackageJson("miujs").version}` });
    expect(m.devDependencies).toBeUndefined();
    expect(m.peerDependencies).toEqual(readPackageJson("db").peerDependencies);
    expect(m.publishConfig).toEqual({ access: "public" });
    expect(JSON.stringify(m)).not.toContain("workspace:");
  });

  test("bin points at built JS", () => {
    expect(publishManifest(readPackageJson("cli")).bin).toEqual({ miu: "./dist/bin.js" });
  });
});

describe("bun scripts/build-packages.ts", () => {
  beforeAll(() => {
    for (const pkg of ["miujs", "cache"]) {
      rmSync(join(ROOT, "packages", pkg, "dist"), { recursive: true, force: true });
      rmSync(stageDir(pkg), { recursive: true, force: true });
    }
  });

  test("--dry-run prints the planned package.json and writes nothing", () => {
    const r = run([bun, "scripts/build-packages.ts", "cache", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"name": "@miujs/cache"');
    expect(r.out).toContain('"default": "./dist/index.js"');
    expect(existsSync(join(ROOT, "packages", "cache", "dist"))).toBe(false);
    expect(existsSync(stageDir("cache"))).toBe(false);
  });

  test("builds miujs and @miujs/cache: dist JS, dist/types, and a staged package", () => {
    const r = run([bun, "scripts/build-packages.ts", "miujs", "cache"]);
    if (r.code !== 0) console.error(r.out, r.err);
    expect(r.code).toBe(0);
    for (const f of ["index.js", "node.js", "types/index.d.ts", "types/node.d.ts", "types/errors.d.ts"]) {
      expect(existsSync(join(ROOT, "packages", "miujs", "dist", f))).toBe(true);
    }
    expect(existsSync(join(ROOT, "packages", "cache", "dist", "index.js"))).toBe(true);
    // Workspace deps stay external; relative .ts specifiers point at the built .js.
    const cacheJs = readFileSync(join(ROOT, "packages", "cache", "dist", "index.js"), "utf8");
    expect(cacheJs).toMatch(/from\s*"miujs"/);
    const miujsJs = readdirSync(join(ROOT, "packages", "miujs", "dist")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(ROOT, "packages", "miujs", "dist", f), "utf8")).join("\n");
    expect(miujsJs).not.toMatch(/["']\.\/[\w./-]+\.ts["']/);
    expect(miujsJs).toContain('"./node.js"');
    const dts = readFileSync(join(ROOT, "packages", "miujs", "dist", "types", "index.d.ts"), "utf8");
    expect(dts).not.toMatch(/from "\.[^"]*\.ts"/);
    // The staged folder is what `npm publish` gets.
    const staged = JSON.parse(readFileSync(join(stageDir("cache"), "package.json"), "utf8"));
    expect(staged).toEqual(publishManifest(readPackageJson("cache")));
    for (const f of ["src/index.ts", "dist/index.js", "dist/types/index.d.ts", "README.md", "LICENSE"]) expect(existsSync(join(stageDir("cache"), f))).toBe(true);
    expect(existsSync(join(stageDir("cache"), "test"))).toBe(false);
  }, 180_000);

  // One installed-from-npm folder, the same app, three runtimes.
  const proofApp = `import { miu, route, t, detectRuntime } from "miujs";
import { cache } from "@miujs/cache";
let hits = 0;
const app = miu({
  name: "proof", logLevel: "silent", dev: false, plugins: [cache()],
  routes: [route.get("/hello/:name", {
    params: t.object({ name: t.string() }),
    handler: async ({ params, cache }) => ({ hi: params.name, n: await cache.remember("k", 60, async () => ++hits) }),
  })],
});
const server = await app.listen(0, "127.0.0.1");
const a = await fetch(\`http://127.0.0.1:\${server.port}/hello/node\`);
const b = await fetch(\`http://127.0.0.1:\${server.port}/hello/again\`);
const bad = await fetch(\`http://127.0.0.1:\${server.port}/nope\`);
console.log(JSON.stringify({
  runtime: detectRuntime(),
  resolved: [import.meta.resolve("miujs"), import.meta.resolve("@miujs/cache")],
  a: [a.status, await a.json()], b: await b.json(), bad: (await bad.json()).error,
}));
await server.stop();
`;

  const runProof = (cmd: string[]) => {
    const dir = join(ROOT, ".tmp", `proof-${process.pid}-${Math.random().toString(36).slice(2)}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "node_modules", "@miujs"), { recursive: true });
    cpSync(stageDir("miujs"), join(dir, "node_modules", "miujs"), { recursive: true });
    cpSync(stageDir("cache"), join(dir, "node_modules", "@miujs", "cache"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", private: true, dependencies: { miujs: "0.1.0", "@miujs/cache": "0.1.0" } }));
    writeFileSync(join(dir, "deno.json"), JSON.stringify({ nodeModulesDir: "manual" }));
    writeFileSync(join(dir, "app.mjs"), proofApp);
    try {
      const r = run([...cmd, "app.mjs"], dir);
      if (r.code !== 0) console.error(r.err);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.out.trim().split("\n").pop()!);
      expect(out.a).toEqual([200, { hi: "node", n: 1 }]);
      expect(out.b).toEqual({ hi: "again", n: 1 });
      expect(out.bad.docs).toStartWith("https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#miu_e_");
      return out as { runtime: string; resolved: string[] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("Node imports the published form (dist JS via the default condition) and serves a route", () => {
    const node = findNode();
    expect(node, "Node not found: set NODE_BIN or put node on PATH").toBeTruthy();
    const out = runProof([node!]);
    expect(out.runtime).toBe("node");
    expect(out.resolved[0]).toEndWith("node_modules/miujs/dist/index.js");
    expect(out.resolved[1]).toEndWith("node_modules/@miujs/cache/dist/index.js");
  }, 60_000);

  test("Bun runs the TypeScript source through the bun condition", () => {
    const out = runProof([bun]);
    expect(out.runtime).toBe("bun");
    expect(out.resolved[0].replaceAll("\\", "/")).toEndWith("node_modules/miujs/src/index.ts");
  }, 60_000);

  // Deno won't strip types under node_modules, which is why there is no "deno" -> src condition.
  test.skipIf(!findDeno())("Deno runs the published form through the default condition", () => {
    const out = runProof([findDeno()!, "run", "-A"]);
    expect(out.runtime).toBe("deno");
    expect(out.resolved[0]).toEndWith("node_modules/miujs/dist/index.js");
  }, 120_000);

  test("TypeScript consumers get types through the `types` condition", () => {
    const dir = join(ROOT, ".tmp", `types-proof-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "node_modules", "@miujs"), { recursive: true });
    cpSync(stageDir("miujs"), join(dir, "node_modules", "miujs"), { recursive: true });
    cpSync(stageDir("cache"), join(dir, "node_modules", "@miujs", "cache"), { recursive: true });
    // Without src/, a resolver that wrongly picked "bun" would fail; types must come from dist/types.
    rmSync(join(dir, "node_modules", "miujs", "src"), { recursive: true, force: true });
    rmSync(join(dir, "node_modules", "@miujs", "cache", "src"), { recursive: true, force: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", private: true }));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ["app.ts"] }),
    );
    writeFileSync(
      join(dir, "app.ts"),
      `import { miu, route, t, type Infer } from "miujs";
import { cache, type CacheClient } from "@miujs/cache";
const User = t.object({ id: t.string() });
const u: Infer<typeof User> = { id: "1" };
const app = miu({ plugins: [cache()], routes: [route.get("/u/:id", { params: User, handler: ({ params }) => ({ id: params.id }) })] });
const c: CacheClient | undefined = undefined;
// @ts-expect-error id must be a string
const bad: Infer<typeof User> = { id: 1 };
export { app, u, c, bad };
`,
    );
    try {
      const r = run([bun, "x", "tsc", "-p", join(dir, "tsconfig.json"), "--pretty", "false"]);
      expect(r.out + r.err).toBe("");
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
