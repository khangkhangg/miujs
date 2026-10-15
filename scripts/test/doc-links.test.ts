// Relative links in the docs must point at files that exist, and #anchors into docs/errors.md at real codes.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { documentedCodes, githubAnchor } from "../error-catalog.ts";
import { DOCUMENTED_PACKAGES, ROOT } from "../lib/repo.ts";

const docs = ["README.md", "AGENTS.md", "docs/guide.md", ...DOCUMENTED_PACKAGES.map((p) => `packages/${p}/README.md`)];
const errorAnchors = new Set(documentedCodes(readFileSync(join(ROOT, "docs", "errors.md"), "utf8")).map(githubAnchor));

test("relative links in README, AGENTS, the guide and package READMEs resolve", () => {
  const broken: string[] = [];
  for (const doc of docs) {
    const text = readFileSync(join(ROOT, doc), "utf8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const [path, hash] = target.split("#");
      const abs = join(ROOT, dirname(doc), path);
      if (!existsSync(abs)) broken.push(`${doc}: ${target}`);
      else if (hash && abs.replaceAll("\\", "/").endsWith("docs/errors.md") && !errorAnchors.has(hash)) broken.push(`${doc}: ${target} (no such code)`);
    }
  }
  expect(broken).toEqual([]);
});
