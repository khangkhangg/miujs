import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeRunner, fixture, linkWorkspace, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

/** A small app in a temp folder: session (reads SESSION_SECRET), a route reading env vars, a test folder. */
function project() {
  const dir = tempDir();
  linkWorkspace(dir, ["miujs", "@miujs/session"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "deploy-demo", type: "module", dependencies: { miujs: "^0.1.0", "@miujs/session": "^0.1.0" } }));
  writeFileSync(
    join(dir, "app.ts"),
    `import { miu } from "miujs";
import { session } from "@miujs/session";
import * as health from "./routes/health.ts";

const app = miu({ name: "deploy-demo", routes: [health], plugins: [session()], logLevel: "silent" });
export default app;
`,
  );
  mkdirSync(join(dir, "routes"));
  writeFileSync(
    join(dir, "routes", "health.ts"),
    `import { route } from "miujs";

export const health = route.get("/health", {
  handler: ({ env }) => ({ ok: true, billing: Boolean(env.STRIPE_API_KEY), url: env.APP_URL ?? null }),
});
`,
  );
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<h1>hi</h1>");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "app.test.ts"), "// tests are not shipped\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  return dir;
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");

function expectGoodDockerfile(docker: string) {
  expect(docker).toMatch(/^FROM oven\/bun:1/m);
  expect(docker).toContain("bun install --production");
  expect(docker).toMatch(/^USER bun$/m);
  // Only what the app needs: no `COPY . .`, no tests, no docs.
  expect(docker).not.toMatch(/COPY (--\S+ )*\. \./);
  expect(docker).toMatch(/COPY .*app\.ts/);
  expect(docker).toMatch(/COPY .*routes/);
  expect(docker).toMatch(/COPY .*public/);
  expect(docker).not.toContain("test");
  expect(docker).not.toContain("README");
  expect(docker).toContain('CMD ["bun", "app.ts"]');
}

describe("miu deploy fly", () => {
  test("--dry-run writes a non-root oven/bun Dockerfile and fly.toml and prints the next commands", async () => {
    const dir = project();
    const { runner, calls } = fakeRunner();
    const r = await run(["deploy", "fly", "--dry-run"], dir, runner);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expectGoodDockerfile(read(dir, "Dockerfile"));
    expect(read(dir, ".dockerignore")).toContain("node_modules");
    const toml = read(dir, "fly.toml");
    expect(toml).toContain('app = "deploy-demo"');
    expect(toml).toContain("internal_port = 3000");
    expect(r.out).toContain("fly deploy");
    expect(r.out).toContain("fly secrets set SESSION_SECRET=");
    expect(r.out).toContain("STRIPE_API_KEY");
    expect(calls).toHaveLength(0);
  });

  test("without --dry-run it runs flyctl deploy through the runner", async () => {
    const dir = project();
    const { runner, calls } = fakeRunner();
    const r = await run(["deploy", "fly"], dir, runner);
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.cmd)).toEqual([["flyctl", "deploy"]]);
  });

  test("keeps files you edited unless --force", async () => {
    const dir = project();
    writeFileSync(join(dir, "fly.toml"), "# mine\n");
    const r = await run(["deploy", "fly", "--dry-run"], dir);
    expect(read(dir, "fly.toml")).toBe("# mine\n");
    expect(r.out).toContain("Kept fly.toml");
    await run(["deploy", "fly", "--dry-run", "--force"], dir);
    expect(read(dir, "fly.toml")).toContain('app = "deploy-demo"');
  });
});

describe("miu deploy railway / render", () => {
  test("railway writes a Dockerfile and railway.json and prints railway up", async () => {
    const dir = project();
    const r = await run(["deploy", "railway", "--dry-run"], dir);
    expect(r.code).toBe(0);
    expectGoodDockerfile(read(dir, "Dockerfile"));
    expect(JSON.parse(read(dir, "railway.json")).build.builder).toBe("DOCKERFILE");
    expect(r.out).toContain("railway up");
    expect(r.out).toContain("railway variables");
  });

  test("render writes a Dockerfile and render.yaml with secrets left for the dashboard", async () => {
    const dir = project();
    const r = await run(["deploy", "render", "--dry-run"], dir);
    expect(r.code).toBe(0);
    expectGoodDockerfile(read(dir, "Dockerfile"));
    const yaml = read(dir, "render.yaml");
    expect(yaml).toContain("name: deploy-demo");
    expect(yaml).toContain("runtime: docker");
    expect(yaml).toMatch(/- key: SESSION_SECRET\n\s+sync: false/);
    expect(yaml).toMatch(/- key: MIU_ENV\n\s+value: production/);
  });
});

describe("miu deploy vps", () => {
  test("writes a systemd unit and a Caddyfile and prints rsync/ssh commands without running them", async () => {
    const dir = project();
    const { runner, calls } = fakeRunner();
    const r = await run(["deploy", "vps", "--host", "deploy@203.0.113.7", "--domain", "demo.example.com"], dir, runner);
    expect(r.code).toBe(0);
    const unit = read(dir, "deploy/deploy-demo.service");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("app.ts");
    expect(unit).toMatch(/^User=/m);
    expect(unit).not.toMatch(/^User=root/m);
    expect(unit).toContain("Environment=MIU_ENV=production");
    expect(unit).toContain("Restart=");
    const caddy = read(dir, "deploy/Caddyfile");
    expect(caddy).toContain("demo.example.com {");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:3000");
    expect(r.out).toContain("rsync");
    expect(r.out).toContain("deploy@203.0.113.7");
    expect(r.out).toContain("ssh deploy@203.0.113.7");
    expect(r.out).toContain("systemctl");
    expect(calls).toHaveLength(0);
  });
});

describe("miu deploy deno-deploy", () => {
  test("writes deploy config to deno.json and prints the deployctl command", async () => {
    const dir = project();
    const r = await run(["deploy", "deno-deploy", "--dry-run"], dir);
    expect(r.code).toBe(0);
    const deno = JSON.parse(read(dir, "deno.json"));
    expect(deno.deploy).toMatchObject({ project: "deploy-demo", entrypoint: "app.ts" });
    expect(r.out).toContain("deployctl deploy --project=deploy-demo --entrypoint=app.ts");
  });
});

describe("miu deploy binary", () => {
  test("--dry-run writes the server entry and prints the bun build --compile command", async () => {
    const dir = project();
    const { runner, calls } = fakeRunner();
    const r = await run(["deploy", "binary", "--dry-run"], dir, runner);
    expect(r.code).toBe(0);
    expect(read(dir, ".miu/server.ts")).toContain('import app from "../app.ts"');
    expect(r.out).toContain("bun build --compile");
    expect(r.out).toContain("dist/deploy-demo");
    expect(calls).toHaveLength(0);
  });

  test("builds a working executable", async () => {
    const dir = project();
    const r = await run(["deploy", "binary", "--out", "dist/demo"], dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const exe = join(dir, "dist", process.platform === "win32" ? "demo.exe" : "demo");
    expect(existsSync(exe)).toBe(true);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn([exe], { cwd: dir, env: { ...process.env, PORT: String(port), MIU_ENV: "development" }, stdout: "pipe", stderr: "pipe" });
    try {
      let body: unknown = null;
      for (let i = 0; i < 100 && !body; i++) {
        try {
          body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(body).toEqual({ ok: true, billing: false, url: null });
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 60_000);
});

describe("miu deploy cloudflare reminders", () => {
  test("prints wrangler secret put for the secrets the app reads, not for bindings", async () => {
    const dir = project();
    const r = await run(["deploy", "cloudflare", "--dry-run"], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bunx wrangler secret put SESSION_SECRET");
    expect(r.out).toContain("bunx wrangler secret put STRIPE_API_KEY");
    // APP_URL is plain config, not a secret.
    expect(r.out).not.toContain("secret put APP_URL");
    expect(r.out).toContain("APP_URL");
  });

  test("reminds you to export Durable Object classes from the entry", async () => {
    const dir = tempDir();
    const r = await run(["deploy", "cloudflare", "--dry-run", "--out", join(dir, "wrangler.toml")], fixture("basic"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("MIU_W_DO_NOT_EXPORTED");
    expect(r.out).toContain("export const MiuRooms");
  });

  test("unknown targets list the real ones", async () => {
    const r = await run(["deploy", "mars"], fixture("basic"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_DEPLOY_TARGET");
    for (const t of ["cloudflare", "fly", "railway", "render", "vps", "binary", "deno-deploy"]) expect(r.err).toContain(t);
  });
});
