// Bumps every package in lockstep and adds a CHANGELOG.md entry.
//
//   bun scripts/release/version.ts patch                # 0.1.0 -> 0.1.1
//   bun scripts/release/version.ts minor                # 0.1.0 -> 0.2.0
//   bun scripts/release/version.ts 1.0.0-rc.1           # an exact version (prereleases publish under the "next" dist-tag)
//   bun scripts/release/version.ts minor --notes "- Postgres adapter" --dry-run
//
// What it changes:
//   packages/*/package.json   "version" (every workspace package, released or not, so they never drift)
//                             and any non-workspace range on miujs / @miujs/* (workspace:* stays: the
//                             build rewrites it to ^<version> in the published manifest)
//   CHANGELOG.md              a "## <version> - <date>" entry on top: --notes, or the commit subjects
//                             since the previous v* tag
// It does not commit, tag or push; it prints the commands to do that.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/repo.ts";

export type Bump = "patch" | "minor" | "major";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function nextVersion(current: string, to: string): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`Current version "${current}" is not semver`);
  if (SEMVER.test(to)) {
    if (compare(to, current) <= 0) throw new Error(`${to} is not newer than ${current}`);
    return to;
  }
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] !== undefined;
  // A bump from a prerelease finishes that release: 1.0.0-rc.1 + patch/minor/major as npm does.
  switch (to) {
    case "patch":
      return pre ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
    case "minor":
      return pre && pat === 0 ? `${maj}.${min}.0` : `${maj}.${min + 1}.0`;
    case "major":
      return pre && min === 0 && pat === 0 ? `${maj}.0.0` : `${maj + 1}.0.0`;
    default:
      throw new Error(`Expected patch, minor, major or an x.y.z version, got "${to}"`);
  }
}

/** Semver precedence (enough for x.y.z[-pre]). */
export function compare(a: string, b: string): number {
  const pa = SEMVER.exec(a)!;
  const pb = SEMVER.exec(b)!;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/** Rewrites the top-level "version" and non-workspace ranges on our packages, keeping the file's formatting. */
export function setVersion(text: string, version: string): string {
  let out = text.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
  out = out.replace(/("(?:miujs|@miujs\/[\w-]+)"\s*:\s*)"([^"]*)"/g, (whole, key: string, spec: string) =>
    spec.startsWith("workspace:") || !/^[\^~]?\d/.test(spec) ? whole : `${key}"^${version}"`,
  );
  return out;
}

/** A CHANGELOG.md with the new entry on top (below the title, if there is one). */
export function addChangelogEntry(existing: string | null, version: string, date: string, notes: string): string {
  const entry = `## ${version} - ${date}\n\n${notes.trim()}\n`;
  if (!existing) return `# Changelog\n\nAll MiuJS packages share one version. Each entry covers \`miujs\` and every \`@miujs/*\` package.\n\n${entry}`;
  if (existing.includes(`## ${version} `)) throw new Error(`CHANGELOG.md already has an entry for ${version}`);
  const i = existing.indexOf("\n## ");
  return i < 0 ? `${existing.trimEnd()}\n\n${entry}` : `${existing.slice(0, i + 1)}${entry}\n${existing.slice(i + 1)}`;
}

function git(args: string[]): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

/** Commit subjects since the last v* tag, as a bullet list. */
function notesFromGit(): string {
  const last = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  const log = git(["log", "--no-merges", "--format=%s", ...(last ? [`${last}..HEAD`] : ["-n", "200"])]);
  const lines = (log ?? "").split("\n").filter(Boolean);
  if (!lines.length) return "- No changes recorded.";
  return lines.map((l) => `- ${l}`).join("\n");
}

const packageFiles = () =>
  readdirSync(join(ROOT, "packages"))
    .map((d) => join(ROOT, "packages", d, "package.json"))
    .filter(existsSync)
    .sort();

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const notesAt = args.indexOf("--notes");
  const notes = notesAt >= 0 ? args[notesAt + 1] : undefined;
  const to = args.filter((a, i) => !a.startsWith("--") && !(notesAt >= 0 && i === notesAt + 1))[0];
  if (!to) {
    console.error("usage: bun scripts/release/version.ts <patch|minor|major|x.y.z> [--notes \"...\"] [--dry-run]");
    process.exit(2);
  }
  const files = packageFiles();
  const versions = new Map(files.map((f) => [f, JSON.parse(readFileSync(f, "utf8")).version as string]));
  const current = versions.get(join(ROOT, "packages", "miujs", "package.json"))!;
  const drifted = [...versions].filter(([, v]) => v !== current);
  if (drifted.length) console.warn(`warning: not in lockstep with miujs@${current}: ${drifted.map(([f, v]) => `${f.split(/[\\/]/).at(-2)}@${v}`).join(", ")} (they are set to the new version too)`);
  const version = nextVersion(current, to);
  const date = new Date().toISOString().slice(0, 10);
  const changelogPath = join(ROOT, "CHANGELOG.md");
  const changelog = addChangelogEntry(existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null, version, date, notes ?? notesFromGit());
  console.log(`${current} -> ${version} (${files.length} packages)${dryRun ? " [dry run]" : ""}`);
  if (dryRun) {
    console.log(changelog.split("\n## ").slice(0, 2).join("\n## ").slice(0, 2000));
  } else {
    for (const f of files) writeFileSync(f, setVersion(readFileSync(f, "utf8"), version));
    writeFileSync(changelogPath, changelog);
    console.log(`\nNext:\n  bun install                       # refresh bun.lock\n  git commit -am "release: v${version}"\n  git tag v${version}\n  git push && git push origin v${version}   # the Release workflow publishes on the tag`);
  }
}
