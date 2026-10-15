import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli } from "../src/index.ts";

const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

async function run(args: string[], cwd: string) {
  let out = "";
  let err = "";
  const code = await runCli(args, { cwd, out: (s) => void (out += s + "\n"), err: (s) => void (err += s + "\n") });
  return { code, out, err };
}

const temps: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "miu-cli-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("help", () => {
  test("no command prints help and exits 0", async () => {
    const r = await run([], tempDir());
    expect(r.code).toBe(0);
    expect(r.out).toContain("miu inspect");
  });

  test("unknown command exits 1 with a fix", async () => {
    const r = await run(["frobnicate"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_UNKNOWN_COMMAND");
    expect(r.err).toContain("miu help");
  });
});

describe("inspect", () => {
  test("--json prints the app description", async () => {
    const r = await run(["inspect", "--json"], fixture("basic"));
    expect(r.code).toBe(0);
    const info = JSON.parse(r.out);
    expect(info.name).toBe("basic-fixture");
    expect(info.routes.map((x: any) => x.name)).toEqual(["getUser", "deleteUser"]);
  });

  test("default output is a readable route list", async () => {
    const r = await run(["inspect"], fixture("basic"));
    expect(r.out).toContain("GET     /users/:id");
    expect(r.out).toContain("getUser");
  });

  test("missing entry file exits 1 with a fix", async () => {
    const r = await run(["inspect"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_NO_APP");
  });
});

describe("test", () => {
  test("runs route-file tests and exits 0 when all pass", async () => {
    const r = await run(["test"], fixture("basic"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ returns the user");
    expect(r.out).toContain("1 passed, 0 failed");
  });

  test("exits 1 and shows the failure message", async () => {
    const r = await run(["test"], fixture("failing"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ fails on purpose");
    expect(r.out).toContain("expected status 201, got 200");
    expect(r.out).toContain("1 passed, 1 failed");
  });
});

describe("openapi", () => {
  test("--out writes the spec to a file", async () => {
    const dir = tempDir();
    const out = join(dir, "openapi.json");
    const r = await run(["openapi", "--out", out], fixture("basic"));
    expect(r.code).toBe(0);
    const spec = JSON.parse(readFileSync(out, "utf8"));
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/users/{id}"].get.operationId).toBe("getUser");
  });
});

describe("check", () => {
  test("flags leaked secrets and exits 1", async () => {
    const r = await run(["check"], fixture("failing"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("MIU_W_SECRET_IN_CODE");
    expect(r.out).toContain("app.ts");
  });

  test("warns about mutating routes without auth but exits 0", async () => {
    const r = await run(["check"], fixture("basic"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("MIU_W_UNAUTHENTICATED_MUTATION");
    expect(r.out).toContain("DELETE /users/:id");
  });
});

describe("add", () => {
  test("add route scaffolds a route file with a failing test", async () => {
    const dir = tempDir();
    const r = await run(["add", "route", "users/get-profile"], dir);
    expect(r.code).toBe(0);
    const file = join(dir, "routes", "users", "get-profile.ts");
    const src = readFileSync(file, "utf8");
    expect(src).toContain('route.get("/users/get-profile"');
    expect(src).toContain("export const getProfile");
    expect(src).toContain("export const tests");
    expect(src).toContain("TODO");
  });

  test("add refuses to overwrite an existing file", async () => {
    const dir = tempDir();
    await run(["add", "route", "ping"], dir);
    const r = await run(["add", "route", "ping"], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_EXISTS");
  });

  test("add job, room and plugin create files in their folders", async () => {
    const dir = tempDir();
    expect((await run(["add", "job", "send-welcome"], dir)).code).toBe(0);
    expect((await run(["add", "room", "lobby"], dir)).code).toBe(0);
    expect((await run(["add", "plugin", "audit-log"], dir)).code).toBe(0);
    expect(readFileSync(join(dir, "jobs", "send-welcome.ts"), "utf8")).toContain('defineJob("send-welcome"');
    expect(readFileSync(join(dir, "rooms", "lobby.ts"), "utf8")).toContain('defineRoom("lobby"');
    expect(readFileSync(join(dir, "plugins", "audit-log.ts"), "utf8")).toContain('name: "audit-log"');
  });

  test("add with an unknown kind exits 1", async () => {
    const r = await run(["add", "widget", "x"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("route, job, room, plugin");
  });
});

describe("new", () => {
  test("creates a runnable project", async () => {
    const dir = tempDir();
    const r = await run(["new", "my-app"], dir);
    expect(r.code).toBe(0);
    for (const f of ["app.ts", "package.json", "tsconfig.json", "AGENTS.md", "routes/health.ts", ".gitignore"]) {
      expect(existsSync(join(dir, "my-app", f))).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(dir, "my-app", "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(pkg.dependencies.miujs).toBeDefined();
  });

  test("refuses a non-empty directory", async () => {
    const dir = tempDir();
    await run(["new", "x"], dir);
    const r = await run(["new", "x"], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_EXISTS");
  });
});

describe("deploy cloudflare --dry-run", () => {
  test("generates wrangler.toml from the plugins' Cloudflare needs", async () => {
    const dir = tempDir();
    const out = join(dir, "wrangler.toml");
    const r = await run(["deploy", "cloudflare", "--dry-run", "--out", out], fixture("basic"));
    expect(r.code).toBe(0);
    const toml = readFileSync(out, "utf8");
    expect(toml).toContain('name = "basic-fixture"');
    // wrangler resolves `main` relative to the config file's folder.
    const main = toml.match(/main = "(.+)"/)![1];
    expect(resolve(dirname(out), main)).toBe(join(fixture("basic"), "app.ts"));
    expect(toml).toMatch(/compatibility_date = "\d{4}-\d{2}-\d{2}"/);
    expect(toml).toContain('[[kv_namespaces]]\nbinding = "CACHE"');
    expect(toml).toContain('[[d1_databases]]\nbinding = "DB"');
    expect(toml).toContain('[[queues.producers]]\nbinding = "JOBS"\nqueue = "jobs"');
    expect(toml).toContain('[[queues.consumers]]\nqueue = "jobs"');
    expect(toml).toContain('[[durable_objects.bindings]]\nname = "MIU_ROOMS"\nclass_name = "MiuRooms"');
    expect(toml).toContain('new_sqlite_classes = ["MiuRooms"]');
    expect(toml).toContain('crons = ["0 * * * *"]');
  });

  test("unknown deploy target exits 1", async () => {
    const r = await run(["deploy", "mars"], fixture("basic"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_DEPLOY_TARGET");
  });
});

describe("deploy target", () => {
  test("deploy cloudflare builds the app as a Cloudflare target", async () => {
    const dir = tempDir();
    const out = join(dir, "wrangler.toml");
    const r = await run(["deploy", "cloudflare", "--dry-run", "--out", out], fixture("targeted"));
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('binding = "TARGETED"');
    expect(process.env.MIU_TARGET).toBeUndefined();
  });
});
