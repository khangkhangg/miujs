// README examples must compile. Every ```ts block with `<!-- test -->` on the line above it is
// written to a temp file under the repo and type-checked with `tsc --noEmit`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENTED_PACKAGES, ROOT } from "../lib/repo.ts";
import { extractSnippets, typecheckSnippets, type Snippet } from "../readme-snippets.ts";

describe("extractSnippets", () => {
  test("takes only ts blocks marked <!-- test -->, with their README line", () => {
    const md = [
      "# x", //                         1
      "```ts", //                       2
      "const skipped = 1;", //          3
      "```", //                         4
      "<!-- test -->", //               5
      "```ts", //                       6
      "const a: number = 1;", //        7
      "```", //                         8
      "<!-- test -->", //               9
      "", //                            10
      "```bash", //                     11
      "echo not ts", //                 12
      "```", //                         13
      "<!-- test -->", //               14
      "```ts", //                       15
      "const b = 2;", //                16
      "const c = 3;", //                17
      "```", //                         18
    ].join("\n");
    const s = extractSnippets(md, "x/README.md");
    expect(s).toEqual([
      { file: "x/README.md", line: 7, code: "const a: number = 1;" },
      { file: "x/README.md", line: 16, code: "const b = 2;\nconst c = 3;" },
    ]);
  });

  test("handles CRLF line endings", () => {
    const s = extractSnippets("<!-- test -->\r\n```ts\r\nconst a = 1;\r\n```\r\n", "r.md");
    expect(s).toEqual([{ file: "r.md", line: 3, code: "const a = 1;" }]);
  });
});

describe("typecheckSnippets", () => {
  test("reports a type error at the README line it came from", async () => {
    const bad: Snippet = { file: "fake/README.md", line: 10, code: 'import { t } from "miujs";\nconst n: number = t.string();' };
    const errors = await typecheckSnippets([bad]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("fake/README.md:11");
  }, 120_000);
});

describe("package READMEs", () => {
  const all: Snippet[] = [];
  for (const pkg of DOCUMENTED_PACKAGES) {
    test(`${pkg} has a README with at least one tested snippet`, () => {
      const path = join(ROOT, "packages", pkg, "README.md");
      expect(existsSync(path)).toBe(true);
      const snippets = extractSnippets(readFileSync(path, "utf8"), `packages/${pkg}/README.md`);
      expect(snippets.length).toBeGreaterThan(0);
      all.push(...snippets);
    });
  }

  test("docs/guide.md has tested snippets", () => {
    const snippets = extractSnippets(readFileSync(join(ROOT, "docs", "guide.md"), "utf8"), "docs/guide.md");
    expect(snippets.length).toBeGreaterThanOrEqual(5);
    all.push(...snippets);
  });

  test("every tested snippet type-checks", async () => {
    expect(all.length).toBeGreaterThanOrEqual(DOCUMENTED_PACKAGES.length);
    const errors = await typecheckSnippets(all);
    expect(errors).toEqual([]);
  }, 300_000);
});
