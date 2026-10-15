// `miu deploy cloudflare` output that `wrangler dev --local` (workerd) must accept as-is. Found by
// the workerd harness (scripts/workerd): every case here broke a real local run.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appEnv, defaultCompatDate, wranglerToml } from "../src/index.ts";
import { cleanup, linkWorkspace, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

describe("wrangler.toml resource names", () => {
  test("D1, R2 and queue names carry the app name, so two apps in one account don't share them", () => {
    const toml = wranglerToml({ name: "notes-api", cloudflare: { d1: ["DB"], r2: ["FILES"], queues: { producers: ["JOBS"], consumers: ["JOBS"] } } }, "app.ts", "2026-01-01");
    expect(toml).toContain('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "notes-api-db"');
    expect(toml).toContain('[[r2_buckets]]\nbinding = "FILES"\nbucket_name = "notes-api-files"');
    expect(toml).toContain('[[queues.producers]]\nbinding = "JOBS"\nqueue = "notes-api-jobs"');
    expect(toml).toContain('[[queues.consumers]]\nqueue = "notes-api-jobs"');
  });

  test("odd app names become valid resource names", () => {
    const toml = wranglerToml({ name: "My App!", cloudflare: { d1: ["MAIN_DB"] } }, "app.ts", "2026-01-01");
    expect(toml).toContain('database_name = "my-app-main-db"');
  });
});

describe("compatibility date", () => {
  test("is capped at the date the locally installed workerd supports", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", "workerd"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "workerd", "package.json"), JSON.stringify({ name: "workerd", version: "1.20260926.0" }));
    mkdirSync(join(dir, "app"));
    expect(defaultCompatDate(join(dir, "app"), new Date("2026-10-15T12:00:00Z"))).toBe("2026-09-26");
    expect(defaultCompatDate(join(dir, "app"), new Date("2026-09-01T12:00:00Z"))).toBe("2026-09-01");
  });

  test("is today without a local workerd", () => {
    expect(defaultCompatDate(tempDir(), new Date("2026-10-15T12:00:00Z"))).toBe("2026-10-15");
  });
});

/** An app with a static assets folder and the game matchmaker's secret. */
function assetsProject() {
  const dir = tempDir();
  linkWorkspace(dir, ["miujs"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "assets-demo", type: "module" }));
  writeFileSync(
    join(dir, "app.ts"),
    `import { definePlugin, miu } from "miujs";
const site = definePlugin({ name: "site", cloudflare: () => ({ assets: { directory: "public" } }) });
export default miu({ name: "assets-demo", plugins: [site], logLevel: "silent" });
`,
  );
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<h1>hi</h1>");
  return dir;
}

describe("deploy cloudflare --out elsewhere", () => {
  test("--compatibility-date is written as given", async () => {
    const dir = assetsProject();
    const out = join(tempDir(), "wrangler.toml");
    const r = await run(["deploy", "cloudflare", "--dry-run", "--out", out, "--compatibility-date", "2025-06-01"], dir);
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('compatibility_date = "2025-06-01"');
  });

  test("a bad --compatibility-date is refused", async () => {
    const r = await run(["deploy", "cloudflare", "--dry-run", "--out", join(tempDir(), "w.toml"), "--compatibility-date", "soon"], assetsProject());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_COMPAT_DATE");
  });

  test("[assets] directory is relative to the config file, like main", async () => {
    const dir = assetsProject();
    const out = join(tempDir(), "nested", "wrangler.toml");
    const r = await run(["deploy", "cloudflare", "--dry-run", "--out", out], dir);
    expect(r.code).toBe(0);
    const toml = readFileSync(out, "utf8");
    const directory = toml.match(/directory = "(.+)"/)![1];
    expect(resolve(dirname(out), directory)).toBe(join(dir, "public"));
  });
});

test("the matchmaker's MIU_GAME_SECRET is listed as a secret to set", () => {
  const env = appEnv(tempDir(), { plugins: [{ name: "matchmaker" }] });
  expect(env.secrets).toContain("MIU_GAME_SECRET");
});

test("an app importing cloudflare:workers (Workflow / Durable Object base classes) still loads for deploy cloudflare", async () => {
  // Regression (workerd harness): workerd only runs Workflow classes that extend WorkflowEntrypoint
  // from "cloudflare:workers", but Bun cannot import that module, so the CLI could not read the app.
  const dir = tempDir();
  linkWorkspace(dir, ["miujs"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "wf-demo", type: "module" }));
  writeFileSync(
    join(dir, "app.ts"),
    `import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { definePlugin, miu } from "miujs";
export class Nightly extends WorkflowEntrypoint { async run() { return 1; } }
export class Counter extends DurableObject {}
const wf = definePlugin({ name: "wf", cloudflare: () => ({ workflows: [{ binding: "NIGHTLY", name: "nightly", className: "Nightly" }], durableObjects: [{ binding: "COUNTER", className: "Counter" }] }) });
export default miu({ name: "wf-demo", plugins: [wf], logLevel: "silent" });
`,
  );
  const out = join(tempDir(), "wrangler.toml");
  const r = await run(["deploy", "cloudflare", "--dry-run", "--out", out], dir);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const toml = readFileSync(out, "utf8");
  expect(toml).toContain('[[workflows]]\nname = "nightly"\nbinding = "NIGHTLY"\nclass_name = "Nightly"');
  expect(r.out).not.toContain("MIU_W_WORKFLOW_NOT_EXPORTED");
});
