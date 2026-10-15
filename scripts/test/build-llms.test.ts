import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { absolutizeLinks, renderLlmsFull, renderLlmsTxt } from "../build-llms.ts";
import { DOCUMENTED_PACKAGES, ROOT, blobUrl, rawUrl } from "../lib/repo.ts";

const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

describe("llms.txt", () => {
  const txt = renderLlmsTxt();

  test("follows the llms.txt shape: H1, summary blockquote, H2 link lists", () => {
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# MiuJS");
    expect(lines[2]).toStartWith("> ");
    expect(txt).toContain("\n## Docs\n");
    expect(txt).toContain("\n## Packages\n");
    expect(txt).toContain("\n## Optional\n");
  });

  test("links every package README with its one-line summary", () => {
    for (const pkg of DOCUMENTED_PACKAGES) {
      const summary = read(`packages/${pkg}/README.md`).split("\n")[2].replace(/^>\s*/, "");
      const name = pkg === "miujs" ? "miujs" : `@miujs/${pkg}`;
      expect(txt).toContain(`- [${name}](${rawUrl(`packages/${pkg}/README.md`)}): ${summary}`);
    }
  });

  test("links the guide, the error catalog and AGENTS.md", () => {
    for (const p of ["docs/guide.md", "docs/errors.md", "AGENTS.md", "llms-full.txt"]) expect(txt).toContain(`](${rawUrl(p)})`);
  });

  test("llms.txt on disk is up to date (run: bun scripts/build-llms.ts)", () => {
    expect(read("llms.txt")).toBe(txt);
  });
});

describe("llms-full.txt", () => {
  const full = renderLlmsFull();

  test("concatenates AGENTS.md, README.md, the guide and every package README, in order", () => {
    const order = ["AGENTS.md", "README.md", "docs/guide.md", ...DOCUMENTED_PACKAGES.map((p) => `packages/${p}/README.md`)];
    let at = -1;
    for (const p of order) {
      const i = full.indexOf(`<!-- source: ${p} -->`);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(full).toContain(read("AGENTS.md").split("\n")[0]);
  });

  test("relative links become absolute GitHub links", () => {
    expect(absolutizeLinks("see [errors](../../docs/errors.md#miu_e_x) and [x](https://a.b) and [s](./src)", "packages/cache/README.md")).toBe(
      `see [errors](${blobUrl("docs/errors.md")}#miu_e_x) and [x](https://a.b) and [s](${blobUrl("packages/cache/src")})`,
    );
    expect(absolutizeLinks("[top](#install)", "README.md")).toBe(`[top](${blobUrl("README.md")}#install)`);
    expect(full).not.toMatch(/\]\(\.\.?\//);
  });

  test("llms-full.txt on disk is up to date (run: bun scripts/build-llms.ts)", () => {
    expect(read("llms-full.txt")).toBe(full);
  });
});
