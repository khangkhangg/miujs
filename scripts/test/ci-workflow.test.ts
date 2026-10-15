// The CI workflow must parse and keep running the checks the docs rely on.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/repo.ts";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { "runs-on": string; steps: Step[]; strategy?: { matrix: { include?: Record<string, unknown>[] } } };
type Workflow = { name: string; on: Record<string, unknown>; jobs: Record<string, Job> };

const wf = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as Workflow;
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");
const allSteps = Object.values(wf.jobs).flatMap((j) => j.steps);

describe(".github/workflows/ci.yml", () => {
  test("runs on push and pull_request", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "push"]);
  });

  test("the Bun job installs from the lockfile, tests, typechecks and checks generated docs", () => {
    const r = runs(wf.jobs.bun);
    expect(r).toContain("bun install --frozen-lockfile");
    expect(r).toContain("bun test");
    expect(r).toContain("bun run typecheck");
    expect(r).toContain("bun scripts/error-catalog.ts --check");
    expect(r).toContain("bun scripts/build-llms.ts --check");
  });

  test("the smoke job runs scripts/runtime-smoke.ts on Node 24 and Deno 2, after a Bun install", () => {
    const job = wf.jobs.smoke;
    const include = job.strategy!.matrix.include!;
    expect(include).toContainEqual(expect.objectContaining({ runtime: "node", version: "24" }));
    expect(include).toContainEqual(expect.objectContaining({ runtime: "deno", version: "v2.x" }));
    expect(runs(job)).toContain("bun install --frozen-lockfile");
    expect(runs(job)).toContain("${{ matrix.run }}");
    const commands = include.map((m) => m.run);
    expect(commands).toContain("node scripts/runtime-smoke.ts");
    expect(commands).toContain("deno run -A scripts/runtime-smoke.ts");
  });

  test("every action is pinned to a version tag", () => {
    const uses = allSteps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@v\d+(\.\d+){0,2}$/);
  });

  test("bun's install cache is cached, keyed on bun.lock", () => {
    const caches = allSteps.filter((s) => s.uses?.startsWith("actions/cache@"));
    expect(caches.length).toBeGreaterThanOrEqual(2);
    for (const c of caches) {
      expect(String(c.with!.path)).toContain(".bun/install/cache");
      expect(String(c.with!.key)).toContain("hashFiles('bun.lock')");
    }
  });
});
