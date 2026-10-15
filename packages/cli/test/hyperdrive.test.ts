// `miu deploy cloudflare` and Postgres over Hyperdrive: [[hyperdrive]] blocks from plugins'
// cloudflare() needs (e.g. pg() from @miujs/db/postgres).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudflareNeeds } from "miujs";
import { appEnv, wranglerToml } from "../src/index.ts";
import { cleanup, linkWorkspace, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

describe("wrangler.toml for Hyperdrive (Postgres)", () => {
  test("renders [[hyperdrive]] with id and localConnectionString, and enables nodejs_compat for postgres.js", () => {
    const hyperdrive: CloudflareNeeds["hyperdrive"] = [
      { binding: "HYPERDRIVE", id: "a1b2c3", localConnectionString: "postgres://postgres:postgres@localhost:5432/app" },
      { binding: "ANALYTICS" },
    ];
    const toml = wranglerToml({ name: "app", cloudflare: { hyperdrive } }, "app.ts", "2026-10-15");
    expect(toml).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(toml).toContain('[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "a1b2c3"\nlocalConnectionString = "postgres://postgres:postgres@localhost:5432/app"');
    // Without an id wrangler deploy fails, so the placeholder says where it comes from.
    expect(toml).toContain('[[hyperdrive]]\nbinding = "ANALYTICS"\nid = "<run: bunx wrangler hyperdrive create app-analytics --connection-string=...>"');
  });

  test("no Hyperdrive, no compatibility flag", () => {
    expect(wranglerToml({ name: "app", cloudflare: { d1: ["DB"] } }, "app.ts", "2026-10-15")).not.toContain("compatibility_flags");
  });

  test("Hyperdrive bindings are not reported as env vars to set", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.ts"), "export const f = (env: any) => [env.HYPERDRIVE, env.DATABASE_URL];\n");
    const env = appEnv(dir, { cloudflare: { hyperdrive: [{ binding: "HYPERDRIVE" }] } });
    expect(env.vars).toEqual(["DATABASE_URL"]);
  });
});

test("miu deploy cloudflare writes [[hyperdrive]] for an app using pg() from @miujs/db/postgres", async () => {
  const dir = tempDir();
  linkWorkspace(dir, ["miujs", "@miujs/db"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pg-demo", type: "module" }));
  writeFileSync(
    join(dir, "app.ts"),
    `import { miu, route } from "miujs";
import { pg } from "@miujs/db/postgres";
const app = miu({ name: "pg-demo", logLevel: "silent",
  plugins: [pg({ hyperdriveId: "0123abcd", localConnectionString: "postgres://postgres:postgres@localhost:5432/app" })],
  routes: [route.get("/", { handler: async ({ sql }) => sql\`SELECT 1\` })] });
export default app;
`,
  );
  const out = join(dir, "wrangler.toml");
  const r = await run(["deploy", "cloudflare", "--dry-run", "--out", out], dir);
  expect(r.code, r.err + r.out).toBe(0);
  const toml = readFileSync(out, "utf8");
  expect(toml).toContain('compatibility_flags = ["nodejs_compat"]');
  expect(toml).toContain('[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "0123abcd"\nlocalConnectionString = "postgres://postgres:postgres@localhost:5432/app"');
  // The binding is not an env var to set.
  expect(r.out).not.toContain("HYPERDRIVE,");
});
