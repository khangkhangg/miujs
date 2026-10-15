// Publishes the built packages (dist/npm/<pkg>) to npm in dependency order. Run by
// .github/workflows/release.yml after build + verify; locally only with --dry-run.
//
//   bun scripts/release/publish.ts --dry-run                 # npm publish --dry-run for each package
//   bun scripts/release/publish.ts --provenance              # the real thing (CI, on a v* tag)
//
// Before publishing anything it checks, for every package: the staged version matches the tag
// (GITHUB_REF_NAME=v<version>) and every other package (lockstep); no workspace: ranges are left;
// COMMERCIAL-LICENSE.md has no TODO; and the npm name is free or already ours. Versions that are
// already on npm are skipped, so a failed run can be re-run. Auth comes from NODE_AUTH_TOKEN (the
// NPM_TOKEN secret, via actions/setup-node's .npmrc); this script never logs in.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_PACKAGES, buildOrder, findNode, stageDir } from "../build-packages.ts";
import { GITHUB_REPO, ROOT } from "../lib/repo.ts";
import { findNpm } from "./verify.ts";

interface Staged {
  folder: string;
  name: string;
  version: string;
  raw: string;
  repository?: { url?: string };
}

/** Problems that must stop a release before anything is published. */
export function preflight(staged: Staged[], opts: { tag?: string; license: string }): string[] {
  const problems: string[] = [];
  const versions = new Set(staged.map((s) => s.version));
  if (versions.size !== 1) problems.push(`Packages are not in lockstep: ${staged.map((s) => `${s.name}@${s.version}`).join(", ")}. Run bun scripts/release/version.ts.`);
  const version = staged[0]?.version;
  if (opts.tag !== undefined && opts.tag !== `v${version}`) problems.push(`Tag ${opts.tag} does not match the package version ${version}. Tag v${version}, or bump with scripts/release/version.ts.`);
  for (const s of staged) {
    if (s.raw.includes("workspace:")) problems.push(`${s.name}: package.json still has workspace: ranges. Rebuild with bun scripts/build-packages.ts.`);
    if (!s.repository?.url?.includes(GITHUB_REPO)) problems.push(`${s.name}: repository.url must point at github.com/${GITHUB_REPO} (npm provenance checks it).`);
  }
  if (/\bTODO\b/.test(opts.license)) problems.push("COMMERCIAL-LICENSE.md still has a TODO (the sales contact). It ships in every package; fill it in first.");
  return problems;
}

/** npm dist-tag for a version: prereleases never become "latest". */
export const distTag = (version: string) => (version.includes("-") ? "next" : "latest");

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const provenance = args.includes("--provenance");
  const node = findNode();
  if (!node) throw new Error("Node not found: set NODE_BIN or put node on PATH");
  const npm = findNpm(node);
  const npmRun = (a: string[]) => {
    const p = Bun.spawnSync([...npm, ...a], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_update_notifier: "false" } });
    return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };

  const folders = buildOrder(RELEASE_PACKAGES);
  const staged: Staged[] = folders.map((folder) => {
    const file = join(stageDir(folder), "package.json");
    if (!existsSync(file)) throw new Error(`${file} is missing. Run bun scripts/build-packages.ts first.`);
    const raw = readFileSync(file, "utf8");
    return { folder, raw, ...JSON.parse(raw) };
  });
  const inCi = process.env.GITHUB_ACTIONS === "true";
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  const problems = preflight(staged, { tag, license: readFileSync(join(ROOT, "COMMERCIAL-LICENSE.md"), "utf8") });
  if (!dryRun && inCi && !tag) problems.push("Real publishes run only from a v* tag. Use the workflow's dry run from a branch.");

  // Who are we, and is each name free or ours?
  const whoami = npmRun(["whoami"]);
  const me = whoami.code === 0 ? whoami.out : null;
  if (!dryRun && !me) problems.push(`npm whoami failed (${whoami.err.split("\n").pop()}). Set the NPM_TOKEN secret (an automation or granular token with publish rights to miujs and @miujs/*).`);
  const skip = new Set<string>();
  for (const s of staged) {
    const view = npmRun(["view", s.name, "--json"]);
    if (view.code !== 0) continue; // E404: the name is free
    const info = JSON.parse(view.out || "{}") as { versions?: string[]; repository?: { url?: string }; maintainers?: (string | { name: string })[] };
    const ours = String(info.repository?.url ?? "").includes(GITHUB_REPO);
    const maintainers = (info.maintainers ?? []).map((m) => (typeof m === "string" ? m.split(" ")[0] : m.name));
    if (!ours && !(me && maintainers.includes(me))) {
      const msg = `${s.name} already exists on npm and is not this project's (repository ${info.repository?.url ?? "?"}, maintainers ${maintainers.join(", ") || "?"}). See RELEASING.md: acquire the name or rename the package.`;
      if (dryRun) console.warn(`warning: ${msg}`);
      else problems.push(msg);
    }
    if (info.versions?.includes(s.version)) skip.add(s.name);
  }

  if (problems.length) {
    console.error(`Not publishing:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    if (!dryRun) process.exit(1);
    console.error("(continuing because of --dry-run)");
  }

  const version = staged[0].version;
  console.log(`${dryRun ? "[dry run] " : ""}publishing ${staged.length} packages at ${version} (dist-tag ${distTag(version)})${me ? ` as ${me}` : ""}`);
  let failed = 0;
  for (const s of staged) {
    if (skip.has(s.name)) {
      console.log(`skip   ${s.name}@${s.version} (already on npm)`);
      continue;
    }
    const cmd = ["publish", stageDir(s.folder), "--access", "public", "--tag", distTag(version), ...(provenance ? ["--provenance"] : []), ...(dryRun ? ["--dry-run"] : [])];
    const r = npmRun(cmd);
    if (r.code === 0) console.log(`${dryRun ? "ok    " : "done  "} ${s.name}@${s.version}`);
    else {
      failed++;
      console.error(`FAILED ${s.name}@${s.version}\n${(r.out + "\n" + r.err).trim().split("\n").slice(-15).join("\n")}`);
      // Dependents of a failed package would point at a version that is not on npm.
      if (!dryRun) break;
    }
  }
  if (failed) process.exit(1);
}
