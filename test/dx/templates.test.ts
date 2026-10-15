import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { renderTemplate, TEMPLATES } from "../../src/cli/scaffold.ts";
import { buildPackage, ROOT, run } from "../build/helpers.ts";

/**
 * The app starters (`admin`, `tour`, `tour --with-admin`): scaffolded into a temp dir next to a
 * node_modules/miujs that points at a local build of this repo (types from dist/, Bun runs src/ via the
 * "bun" export condition), then the starter's own test suite and `tsc --noEmit` run inside it.
 */

const work = mkdtempSync(join(tmpdir(), "miu-templates-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function io(): Io & { stdout: string; stderr: string } {
  const o = {
    stdout: "",
    stderr: "",
    cwd: work,
    out: async (t: string) => void (o.stdout += t),
    err: async (t: string) => void (o.stderr += t),
  };
  return o;
}

describe("renderTemplate", () => {
  test("fills variables and keeps or drops feature blocks", () => {
    const src = [
      "name={{name}}",
      "// {{#admin}}",
      "admin line",
      "// {{/admin}}",
      "// {{^admin}}",
      "no admin line",
      "// {{/admin}}",
      "<!-- {{#admin}} -->",
      "md admin",
      "<!-- {{/admin}} -->",
      "end {{unknown}}",
      "",
    ].join("\n");
    expect(renderTemplate(src, { name: "x" }, new Set(["admin"]))).toBe("name=x\nadmin line\nmd admin\nend {{unknown}}\n");
    expect(renderTemplate(src, { name: "x" }, new Set())).toBe("name=x\nno admin line\nend {{unknown}}\n");
  });

  test("unbalanced blocks are an error", () => {
    expect(() => renderTemplate("{{#admin}}\nx\n", {}, new Set())).toThrow(/admin/);
    expect(() => renderTemplate("x\n{{/admin}}\n", {}, new Set())).toThrow(/admin/);
  });
});

describe("miu create: template list and flags", () => {
  test("the templates are registered", () => {
    expect([...TEMPLATES]).toEqual(expect.arrayContaining(["bun", "node", "workers", "admin", "tour"]));
  });

  test("--help lists every template and --with-admin", async () => {
    const o = io();
    expect(await main(["--help"], o)).toBe(0);
    for (const name of TEMPLATES) expect(o.stdout).toContain(name);
    expect(o.stdout).toContain("--with-admin");
  });

  test("an unknown template names the available ones", async () => {
    const o = io();
    expect(await main(["create", join(work, "nope"), "--template", "deno"], o)).toBe(1);
    expect(o.stderr).toContain("Unknown template");
    for (const name of TEMPLATES) expect(o.stderr).toContain(name);
  });

  test("usage without a directory names the templates", async () => {
    const o = io();
    expect(await main(["create"], o)).toBe(1);
    expect(o.stderr).toContain("admin");
    expect(o.stderr).toContain("tour");
  });

  test("--with-admin is only accepted by templates that support it", async () => {
    const o = io();
    expect(await main(["create", join(work, "bad-flag"), "--template", "bun", "--with-admin"], o)).toBe(1);
    expect(o.stderr).toContain("--with-admin");
    expect(existsSync(join(work, "bad-flag"))).toBe(false);
  });
});

// ---------- scaffold + run the starters ----------

let pkgRoot = "";
beforeAll(() => {
  pkgRoot = buildPackage();
}, 120_000);

async function scaffold(name: string, args: string[]): Promise<{ dir: string; stdout: string }> {
  const dir = join(work, name);
  const o = io();
  const code = await main(["create", dir, ...args], o);
  expect(o.stderr).toBe("");
  expect(code).toBe(0);
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(pkgRoot, join(dir, "node_modules/miujs"));
  symlinkSync(join(ROOT, "node_modules/@types"), join(dir, "node_modules/@types"));
  return { dir, stdout: o.stdout };
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const TSC = join(ROOT, "node_modules/.bin/tsc");

function expectStarterPasses(dir: string) {
  const r = run(["bun", "test"], dir, { MIU_ENV: "", ADMIN_PASSWORD: "", SESSION_SECRET: "" });
  if (r.code !== 0) console.error(r.out, r.err);
  expect(r.code).toBe(0);
  expect(r.err).toMatch(/\b[1-9]\d* pass\b/);
  expect(r.err).toMatch(/\b0 fail\b/);
}

function expectTypechecks(dir: string) {
  const r = run([TSC, "--noEmit", "-p", join(dir, "tsconfig.json")], dir);
  if (r.code !== 0) console.error(r.out, r.err);
  expect(r.code).toBe(0);
}

describe("admin template", () => {
  let dir = "";
  test("scaffolds a back-office starter", async () => {
    const s = await scaffold("my-admin", ["--template", "admin"]);
    dir = s.dir;
    expect(s.stdout).toContain("bun run dev");
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.name).toBe("my-admin");
    expect(pkg.scripts.dev).toContain("MIU_ENV=development");
    expect(pkg.scripts.dev).toContain("--watch");
    expect(pkg.scripts.start).toBeDefined();
    expect(pkg.scripts.test).toBe("bun test");
    const app = read(dir, "src/app.ts");
    for (const s of ["mcp()", "openapi()", "admin(", "sqliteRepository", "diskBlobStore", "sessions(", "ADMIN_PASSWORD", "inspector("]) {
      expect(app).toContain(s);
    }
    expect(app).not.toContain("{{");
    expect(read(dir, "README.md")).toContain("my-admin");
    expect(read(dir, "README.md")).toMatch(/add a resource/i);
    expect(existsSync(join(dir, "test/app.test.ts"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
  });

  test("its starter test passes", () => expectStarterPasses(dir), 60_000);
  test("it typechecks", () => expectTypechecks(dir), 60_000);
});

describe("tour template", () => {
  let dir = "";
  test("scaffolds a virtual-tour starter", async () => {
    const s = await scaffold("my-tours", ["--template", "tour"]);
    dir = s.dir;
    expect(s.stdout).toContain("bun run seed");
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.scripts.seed).toBeDefined();
    expect(pkg.scripts.dev).toContain("MIU_ENV=development");
    const app = read(dir, "src/app.ts");
    for (const s of ["tourKit(", "/signup", "mcp()", "openapi()", "inspector("]) expect(app).toContain(s);
    for (const s of ["sqliteRepository", "diskBlobStore"]) expect(read(dir, "src/data.ts")).toContain(s);
    expect(app).not.toContain("miujs/admin");
    expect(app).not.toContain("{{");
    expect(existsSync(join(dir, "src/admin.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/panorama.ts"))).toBe(true);
    const readme = read(dir, "README.md");
    for (const s of ["2:1", "equirectangular", "hotspot", "Publish", "Cloudflare", "Node"]) expect(readme).toContain(s);
    expect(readme).not.toContain("/admin");
  });

  test("its starter test passes", () => expectStarterPasses(dir), 60_000);
  test("it typechecks", () => expectTypechecks(dir), 60_000);
});

describe("tour template --with-admin", () => {
  let dir = "";
  test("adds the back-office", async () => {
    const s = await scaffold("my-tours-admin", ["--template", "tour", "--with-admin"]);
    dir = s.dir;
    expect(s.stdout).toContain("with admin");
    expect(read(dir, "src/app.ts")).toContain("./admin.ts");
    expect(read(dir, "src/admin.ts")).toContain("miujs/admin");
    expect(read(dir, "README.md")).toContain("/admin");
    expect(read(dir, "src/app.ts")).not.toContain("{{");
  });

  test("its starter test passes", () => expectStarterPasses(dir), 60_000);
  test("it typechecks", () => expectTypechecks(dir), 60_000);
});
