// Release tooling: version bumps, publish order and preflight, tarball checks, and the workflow.
// The full pack-install-run proof is `bun scripts/release/verify.ts` (minutes, needs the network).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_PACKAGES, buildOrder, buildPackage, publishManifest } from "../build-packages.ts";
import { ROOT, readPackageJson } from "../lib/repo.ts";
import { distTag, preflight } from "./publish.ts";
import { checkTarball, classifyDomErrors, parseArgs, splitTscOutput } from "./verify.ts";
import { addChangelogEntry, nextVersion, setVersion } from "./version.ts";

describe("version.ts", () => {
  test("bumps patch, minor, major, and finishes prereleases like npm", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.1", "major")).toBe("1.0.0");
    expect(nextVersion("1.0.0-rc.1", "major")).toBe("1.0.0");
    expect(nextVersion("1.2.0-rc.1", "minor")).toBe("1.2.0");
    expect(nextVersion("0.1.0", "1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(() => nextVersion("0.2.0", "0.1.9")).toThrow("not newer");
    expect(() => nextVersion("0.2.0", "huge")).toThrow("Expected patch");
  });

  test("setVersion changes the version and pinned ranges on our packages, nothing else", () => {
    const before = `{\n  "name": "@miujs/x",\n  "version": "0.1.0",\n  "dependencies": { "miujs": "workspace:*", "@miujs/db": "^0.1.0", "zod": "^0.1.0" }\n}\n`;
    expect(setVersion(before, "0.2.0")).toBe(`{\n  "name": "@miujs/x",\n  "version": "0.2.0",\n  "dependencies": { "miujs": "workspace:*", "@miujs/db": "^0.2.0", "zod": "^0.1.0" }\n}\n`);
  });

  test("changelog entries go on top, once per version", () => {
    const first = addChangelogEntry(null, "0.2.0", "2026-10-15", "- a");
    expect(first).toStartWith("# Changelog\n");
    expect(first).toContain("## 0.2.0 - 2026-10-15\n\n- a\n");
    const second = addChangelogEntry(first, "0.3.0", "2026-11-01", "- b");
    expect(second.indexOf("## 0.3.0")).toBeLessThan(second.indexOf("## 0.2.0"));
    expect(() => addChangelogEntry(second, "0.3.0", "2026-11-02", "- c")).toThrow("already");
  });

  test("every package is in lockstep with miujs", () => {
    const v = readPackageJson("miujs").version;
    for (const p of RELEASE_PACKAGES) expect(`${p}@${readPackageJson(p).version}`).toBe(`${p}@${v}`);
  });
});

describe("publish.ts", () => {
  test("publish order puts every workspace dependency first", () => {
    const order = buildOrder(RELEASE_PACKAGES);
    expect(new Set(order)).toEqual(new Set(RELEASE_PACKAGES));
    for (const folder of order) {
      const pkg = readPackageJson(folder);
      for (const [dep, spec] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
        if (!spec.startsWith("workspace:")) continue;
        const depFolder = dep === "miujs" ? "miujs" : dep.replace("@miujs/", "");
        expect(order.indexOf(depFolder), `${dep} before ${pkg.name}`).toBeLessThan(order.indexOf(folder));
      }
    }
  });

  const staged = (version: string, raw = "{}") => [{ folder: "miujs", name: "miujs", version, raw, repository: { url: "git+https://github.com/khangkhangg/miujs.git" } }];
  test("preflight: tag must match, lockstep, no workspace ranges, no license TODO", () => {
    expect(preflight(staged("0.2.0"), { tag: "v0.2.0", license: "ok" })).toEqual([]);
    expect(preflight(staged("0.2.0"), { tag: "v0.2.1", license: "ok" }).join()).toContain("does not match");
    expect(preflight([...staged("0.2.0"), { ...staged("0.1.0")[0], name: "@miujs/db" }], { license: "ok" }).join()).toContain("lockstep");
    expect(preflight(staged("0.2.0", '{"miujs":"workspace:*"}'), { license: "ok" }).join()).toContain("workspace:");
    expect(preflight(staged("0.2.0"), { license: "contact: **TODO: add**" }).join()).toContain("TODO");
  });

  test("prereleases publish under next", () => {
    expect(distTag("1.0.0")).toBe("latest");
    expect(distTag("1.0.0-rc.1")).toBe("next");
  });
});

describe("verify.ts", () => {
  test("checkTarball wants licenses, every export target, and no tests", () => {
    const m = publishManifest(readPackageJson("cache"));
    const files = ["package.json", "README.md", "LICENSE", "COMMERCIAL-LICENSE.md", "src/index.ts", "dist/index.js", "dist/types/index.d.ts"].map((f) => `package/${f}`);
    expect(checkTarball(m, files)).toEqual([]);
    expect(checkTarball(m, files.filter((f) => !f.endsWith("COMMERCIAL-LICENSE.md")))).toEqual(["missing COMMERCIAL-LICENSE.md"]);
    expect(checkTarball(m, files.filter((f) => !f.endsWith(".d.ts"))).join()).toContain("dist/types/index.d.ts");
    expect(checkTarball(m, [...files, "package/test/a.test.ts"]).join()).toContain("unexpected file");
  });

  test("splitTscOutput separates our errors from third-party ones and spots src/ files", () => {
    const out = [
      "C:\\t\\node_modules\\miujs\\dist\\types\\index.d.ts",
      "/t/node_modules/@miujs/db/src/index.ts",
      "node_modules/drizzle-orm/d1/driver.d.ts(1,56): error TS2307: Cannot find module '@miniflare/d1'",
      "node_modules/miujs/dist/types/app.d.ts(35,15): error TS2304: Cannot find name 'HeadersInit'.",
      "app.ts(3,1): error TS2322: nope",
    ].join("\n");
    const r = splitTscOutput(out);
    expect(r.ours).toHaveLength(2);
    expect(r.thirdParty).toHaveLength(1);
    expect(r.fromSrc).toEqual(["/t/node_modules/@miujs/db/src/index.ts"]);
    expect(r.declarations).toBe(2);
  });

  test("classifyDomErrors: missing DOM names are pending (miujs) or failures (others); the rest are failures", () => {
    const r = classifyDomErrors([
      "node_modules/miujs/dist/types/app.d.ts(35,15): error TS2304: Cannot find name 'HeadersInit'.",
      "node_modules/@miujs/web/dist/types/html.d.ts(20,15): error TS2304: Cannot find name 'HeadersInit'.",
      "node_modules/@miujs/auth/dist/types/jose.d.ts(19,32): error TS2749: 'CryptoKey' refers to a value, but is being used as a type here.",
      "app.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
    expect(r.pending).toEqual(["miujs/dist/types/app.d.ts:35 HeadersInit"]);
    expect(r.unexpected).toEqual(["@miujs/web/dist/types/html.d.ts:20 HeadersInit", "@miujs/auth/dist/types/jose.d.ts:19 CryptoKey"]);
    expect(r.other).toHaveLength(1);
  });

  test("--only/--skip choose steps; pack always runs", () => {
    expect([...parseArgs(["--only", "node"]).steps].sort()).toEqual(["node", "pack"]);
    expect(parseArgs(["--skip=deno,bun"]).steps.has("deno")).toBe(false);
    expect(parseArgs(["--no-build", "--keep"])).toMatchObject({ build: false, keep: true });
    expect(() => parseArgs(["--only", "rust"])).toThrow("Unknown step");
  });
});

describe(".github/workflows/release.yml", () => {
  type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const wf = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")) as {
    on: { push: { tags: string[] }; workflow_dispatch: { inputs: { dry_run: { default: boolean } } } };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const runs = steps.map((s) => s.run ?? "");

  test("publishes on v* tags; manual runs default to a dry run", () => {
    expect(wf.on.push.tags).toEqual(["v*"]);
    expect(wf.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(wf.permissions["id-token"]).toBe("write");
  });

  test("tests, builds and verifies before publishing with provenance and NPM_TOKEN", () => {
    const at = (cmd: string) => runs.findIndex((r) => r.includes(cmd));
    const order = ["bun install --frozen-lockfile", "bun test", "bun run typecheck", "bun scripts/build-packages.ts", "bun scripts/release/verify.ts", "bun scripts/release/publish.ts --provenance"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const publish = steps.find((s) => s.run?.includes("publish.ts --provenance"))!;
    expect(publish.env?.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(steps.find((s) => s.run?.includes("publish.ts --dry-run"))?.if).toContain("inputs.dry_run");
    expect(steps.find((s) => s.uses?.startsWith("actions/setup-node"))?.with).toMatchObject({ "node-version": "24", "registry-url": "https://registry.npmjs.org" });
  });
});

describe("public declarations without lib dom", () => {
  // Node consumers (lib es2023 + @types/node) have Headers, Request, Response and crypto, but not
  // these DOM-only names. scripts/release/verify.ts proves the same with tsc on the packed tarballs.
  const DOM_ONLY = /\b(HeadersInit|BodyInit|CryptoKey|JsonWebKey)\b/;
  const declarationsUsing = (folder: string) => {
    const dir = join(ROOT, "packages", folder, "dist", "types");
    const hits: string[] = [];
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      if (!name.endsWith(".d.ts")) continue;
      const text = readFileSync(join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      text.split("\n").forEach((l, i) => {
        const m = DOM_ONLY.exec(l);
        if (m) hits.push(`${folder}/dist/types/${name.replaceAll("\\", "/")}:${i + 1} ${m[1]}`);
      });
    }
    return hits;
  };

  test("auth, audit, web and ai use no DOM-only type names", async () => {
    for (const folder of buildOrder(["auth", "audit", "web", "ai"])) await buildPackage(folder);
    expect(["auth", "audit", "web", "ai"].flatMap(declarationsUsing)).toEqual([]);
  }, 180_000);
});
