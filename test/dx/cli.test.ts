import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const BIN = join(ROOT, "bin/miu.ts");
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp("/tmp/miu-cli-");
  tmpDirs.push(d);
  return d;
}

async function miu(args: string[], cwd = ROOT, runtime: string[] = ["bun"]) {
  const proc = Bun.spawn([...runtime, BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const hasMigrate = await exists(join(ROOT, "src/migrate/introspect.ts"));

describe("miu --help / --version", () => {
  test("--help lists commands", async () => {
    const r = await miu(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["create", "routes", "openapi", "llms", "tools", "wrangler", "introspect"]) expect(r.stdout).toContain(cmd);
  });

  test("no args prints help", async () => {
    const r = await miu([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  test("--version prints package version", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const r = await miu(["--version"]);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  test("unknown command exits 1", async () => {
    const r = await miu(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown command");
  });
});

describe("miu routes / openapi / llms / tools", () => {
  test("routes prints a table", async () => {
    const r = await miu(["routes", "examples/basic.ts"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^METHOD\s+PATH\s+TOOL\s+SUMMARY$/);
    expect(r.stdout).toMatch(/GET\s+\/todos\/:id\s+get_todos_by_id\s+Get a todo/);
    expect(r.stdout).toMatch(/DELETE\s+\/todos\/:id\s+delete_todos_by_id\s+Delete a todo/);
  });

  test("routes resolves a relative entry from cwd and a named `app` export", async () => {
    const d = await tmp();
    await writeFile(
      join(d, "named.ts"),
      `import { Miu } from ${JSON.stringify(join(ROOT, "src/index.ts"))};\nexport const app = new Miu().get("/ping", { summary: "Ping", tool: false }, () => "pong");\n`,
    );
    const r = await miu(["routes", "named.ts"], d);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/GET\s+\/ping\s+-\s+Ping/);
  });

  test("routes with a missing entry fails nicely", async () => {
    const r = await miu(["routes", "does-not-exist.ts"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does-not-exist.ts");
  });

  test("openapi prints JSON and --out writes a file", async () => {
    const r = await miu(["openapi", "examples/basic.ts"]);
    const doc = JSON.parse(r.stdout);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("todo-api");
    const d = await tmp();
    const out = join(d, "openapi.json");
    const w = await miu(["openapi", "examples/basic.ts", "--out", out]);
    expect(w.code).toBe(0);
    expect(JSON.parse(await readFile(out, "utf8")).paths["/todos/{id}"]).toBeDefined();
  });

  test("llms and llms --full", async () => {
    const r = await miu(["llms", "examples/basic.ts", "--base-url", "https://todo.dev"]);
    expect(r.stdout).toStartWith("# todo-api");
    expect(r.stdout).toContain("[GET /todos](https://todo.dev/todos)");
    const f = await miu(["llms", "examples/basic.ts", "--full"]);
    expect(f.stdout).toContain("### Request body");
  });

  test("tools prints MCP tools JSON", async () => {
    const r = await miu(["tools", "examples/basic.ts"]);
    const tools = JSON.parse(r.stdout);
    expect(tools.map((t: { name: string }) => t.name)).toContain("post_todos");
  });

  test("defaults the entry to src/app.ts", async () => {
    const d = await tmp();
    await mkdir(join(d, "src"));
    await writeFile(join(d, "src/app.ts"), `import { Miu } from ${JSON.stringify(join(ROOT, "src/index.ts"))};\nexport default new Miu().get("/x", () => 1);\n`);
    const r = await miu(["routes"], d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/x");
  });

  test("runs under Node with --experimental-strip-types", async () => {
    const r = await miu(["tools", "examples/basic.ts"], ROOT, ["node", "--experimental-strip-types", "--no-warnings"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).length).toBe(5);
  });
});

describe("miu create", () => {
  for (const template of ["bun", "node", "workers"]) {
    test(`scaffolds the ${template} template`, async () => {
      const d = join(await tmp(), "my-app");
      const r = await miu(["create", d, "--template", template]);
      expect(r.code).toBe(0);
      const pkg = JSON.parse(await readFile(join(d, "package.json"), "utf8"));
      expect(pkg.name).toBe("my-app");
      expect(pkg.dependencies.miujs).toBeDefined();
      const app = await readFile(join(d, "src/app.ts"), "utf8");
      expect(app).toContain("mcp()");
      expect(app).toContain("openapi()");
      expect(app).not.toContain("{{");
      expect(await exists(join(d, "tsconfig.json"))).toBe(true);
      expect(await exists(join(d, ".gitignore"))).toBe(true);
      expect(await readFile(join(d, "README.md"), "utf8")).toContain("my-app");
      if (template === "workers") {
        expect(await readFile(join(d, "wrangler.toml"), "utf8")).toContain('name = "my-app"');
        expect(await exists(join(d, "src/worker.ts"))).toBe(true);
      }
      if (template === "node") expect(await readFile(join(d, "src/server.ts"), "utf8")).toContain("miujs/node");
      expect(r.stdout).toContain("cd ");
    });
  }

  test("--name overrides the package name; default template is bun", async () => {
    const d = join(await tmp(), "x");
    await miu(["create", d, "--name", "cool-api"]);
    const pkg = JSON.parse(await readFile(join(d, "package.json"), "utf8"));
    expect(pkg.name).toBe("cool-api");
    expect(pkg.scripts.dev).toContain("bun");
  });

  test("refuses a non-empty directory unless --force", async () => {
    const d = await tmp();
    await writeFile(join(d, "keep.txt"), "x");
    const r = await miu(["create", d]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not empty");
    const f = await miu(["create", d, "--force"]);
    expect(f.code).toBe(0);
    expect(await exists(join(d, "keep.txt"))).toBe(true);
  });

  test("unknown template fails", async () => {
    const r = await miu(["create", join(await tmp(), "y"), "--template", "deno"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown template");
  });
});

describe("miu wrangler", () => {
  test("prints wrangler.toml with bindings", async () => {
    const r = await miu(["wrangler", "--name", "shop", "--kv", "CACHE", "--d1", "DB", "--do", "Room"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('name = "shop"');
    expect(r.stdout).toContain(`compatibility_date = "${new Date().toISOString().slice(0, 10)}"`);
    expect(r.stdout).toContain('binding = "CACHE"');
    expect(r.stdout).toContain('database_name = "shop-db"');
    expect(r.stdout).toContain('class_name = "Room"');
  });

  test("--out writes a file and won't overwrite without --force", async () => {
    const d = await tmp();
    const out = join(d, "wrangler.toml");
    expect((await miu(["wrangler", "--name", "a", "--out", out])).code).toBe(0);
    expect(await readFile(out, "utf8")).toContain('name = "a"');
    const again = await miu(["wrangler", "--name", "a", "--out", out]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("exists");
  });
});

describe("miu introspect", () => {
  test("without a database URL prints usage and exits 1", async () => {
    const r = await miu(["introspect"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/introspect|migrat/i);
  });

  test.if(hasMigrate)("introspects a SQLite database when the migration kit is present", async () => {
    const d = await tmp();
    const db = join(d, "app.sqlite");
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db, { create: true });
    raw.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, bio TEXT)");
    raw.close();
    const r = await miu(["introspect", `sqlite:${db}`]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("email");
  });
});
