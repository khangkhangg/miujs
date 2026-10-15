import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_BASE, errors } from "../../packages/miujs/src/index.ts";
import { collectCodes, documentedCodes, githubAnchor, renderCatalog, scanPackage, type SourceFile } from "../error-catalog.ts";
import { ROOT, blobUrl } from "../lib/repo.ts";

const files = (map: Record<string, string>): SourceFile[] => Object.entries(map).map(([path, text]) => ({ path, text }));
const byCode = (pkg: string, src: Record<string, string>) => new Map(scanPackage(pkg, files(src)).filter((o) => o.kind !== "mention").map((o) => [o.code, o]));

describe("githubAnchor", () => {
  test("matches GitHub's heading ids", () => {
    expect(githubAnchor("MIU_E_NOT_FOUND")).toBe("miu_e_not_found");
    expect(githubAnchor("MIU_W_SECRET_IN_CODE")).toBe("miu_w_secret_in_code");
    expect(githubAnchor("Hello World! (x)")).toBe("hello-world-x");
    expect(githubAnchor("`ERR_INVALID_ARG_TYPE`")).toBe("err_invalid_arg_type");
  });
});

describe("scanPackage", () => {
  test("new MiuError({...}) with literal code, status, message and fix", () => {
    const o = byCode("cache", {
      "packages/cache/src/errors.ts": `export const cacheErrors = {
  ttl: (ttl: unknown) =>
    new MiuError({
      code: "MIU_E_CACHE_TTL",
      status: 500,
      message: \`Cache ttl must be positive, got \${String(ttl)}\`,
      fix: "Pass \`ttl\` in seconds.",
    }),
};`,
    }).get("MIU_E_CACHE_TTL")!;
    expect(o).toMatchObject({ pkg: "cache", status: 500, message: "Cache ttl must be positive, got {ttl}", fix: "Pass `ttl` in seconds." });
  });

  test("errors.config(code, message, fix) is a 500", () => {
    const o = byCode("db", { "packages/db/src/index.ts": `throw errors.config(\n  "MIU_E_DB_MISSING",\n  'No database',\n  "Add db() to plugins.",\n);` }).get("MIU_E_DB_MISSING")!;
    expect(o).toMatchObject({ status: 500, message: "No database", fix: "Add db() to plugins." });
  });

  test("helper calls with (code, message, fix) and (code, status, message, fix)", () => {
    const m = byCode("cli", {
      "packages/cli/src/index.ts": `throw new CliError("MIU_E_CLI_EXISTS", \`\${file} already exists\`, "Pick another name.");
throw roomError("MIU_E_ROOM_FULL", 409, "Room is full", "Try another room.");`,
    });
    expect(m.get("MIU_E_CLI_EXISTS")).toMatchObject({ message: "{file} already exists", fix: "Pick another name." });
    expect(m.get("MIU_E_ROOM_FULL")).toMatchObject({ status: 409, message: "Room is full", fix: "Try another room." });
  });

  test("prefix factories resolve the codes their callers pass, across files", () => {
    const m = byCode("auth", {
      "packages/auth/src/oauth.ts": `function oauthError(code: string, status: number, message: string, fix: string) {
  return errors.custom({ code: \`MIU_E_AUTH_OAUTH_\${code}\`, status, message, fix });
}
const stateError = (why: string) => oauthError("STATE", 400, \`OAuth failed: \${why}\`, "Start again.");`,
      "packages/auth/src/other.ts": `if (!p) throw oauthError("PROVIDER_UNKNOWN", 404, "No provider", "Add it.");`,
    });
    expect(m.get("MIU_E_AUTH_OAUTH_STATE")).toMatchObject({ status: 400, message: "OAuth failed: {why}", fix: "Start again." });
    expect(m.get("MIU_E_AUTH_OAUTH_PROVIDER_UNKNOWN")).toMatchObject({ status: 404, file: "packages/auth/src/other.ts" });
    expect(m.has("MIU_E_AUTH_OAUTH")).toBe(false);
  });

  test("object-member factories with defaults and literal statuses", () => {
    const m = byCode("files", {
      "packages/files/src/errors.ts": `export const filesErrors = {
  config: (code: string, message: string, fix: string) => new MiuError({ code: \`MIU_E_FILES_\${code}\`, status: 500, message, fix }),
  badRequest: (code: string, message: string, fix: string, status = 400) => new MiuError({ code: \`MIU_E_FILES_\${code}\`, status, message, fix }),
};`,
      "packages/files/src/upload.ts": `const noFile = (field: string) => filesErrors.badRequest("NO_FILE", \`No file in \${field}\`, "Send a file.");
throw filesErrors.badRequest("TOO_BIG", "Too big", "Smaller.", 413);
throw filesErrors.config("CONFIG", "Bad config", "Fix config.");
throw errors.config("MIU_E_OTHER", "x", "y");`,
    });
    expect(m.get("MIU_E_FILES_NO_FILE")).toMatchObject({ status: 400, message: "No file in {field}", fix: "Send a file." });
    expect(m.get("MIU_E_FILES_TOO_BIG")).toMatchObject({ status: 413 });
    expect(m.get("MIU_E_FILES_CONFIG")).toMatchObject({ status: 500, message: "Bad config" });
    expect(m.get("MIU_E_OTHER")).toMatchObject({ status: 500 });
  });

  test("a code parameter typed as a union of literals", () => {
    const m = byCode("queue", {
      "packages/queue/src/errors.ts": `export const queueErrors = {
  backend: (code: "REDIS" | "SQLITE", op: string, fix: string) =>
    new MiuError({ code: \`MIU_E_QUEUE_\${code}\`, status: 500, message: \`Queue operation \${op} failed\`, fix }),
};`,
    });
    expect([...m.keys()].sort()).toEqual(["MIU_E_QUEUE_REDIS", "MIU_E_QUEUE_SQLITE"]);
    expect(m.get("MIU_E_QUEUE_REDIS")).toMatchObject({ status: 500, message: "Queue operation {op} failed" });
  });

  test("ternary codes pick the matching branch of status, message and fix", () => {
    const m = byCode("miujs", {
      "packages/miujs/src/errors.ts": `new MiuError({
  code: where === "response" ? "MIU_E_RESPONSE_INVALID" : "MIU_E_VALIDATION",
  status: where === "response" ? 500 : 400,
  message: "Invalid " + where,
  fix: where === "response" ? "Fix the handler." : "Send valid input.",
})`,
    });
    expect(m.get("MIU_E_RESPONSE_INVALID")).toMatchObject({ status: 500, fix: "Fix the handler.", message: "Invalid {where}" });
    expect(m.get("MIU_E_VALIDATION")).toMatchObject({ status: 400, fix: "Send valid input." });
  });

  test("CLI warnings written as `CODE message. Fix: fix`", () => {
    const m = byCode("cli", { "packages/cli/src/index.ts": "io.out(`warn  MIU_W_UNAUTHENTICATED_MUTATION ${r.path} has no auth. Fix: add \\`auth\\`.`);" });
    expect(m.get("MIU_W_UNAUTHENTICATED_MUTATION")).toMatchObject({ message: "{r.path} has no auth.", fix: "add `auth`." });
  });

  test("mentions in comments count as codes; globs and template prefixes do not", () => {
    const all = scanPackage("ai", files({ "packages/ai/src/http.ts": "// errors mapped to MIU_E_AI_*, see MIU_E_AI_TIMEOUT\nconst c = `MIU_E_X_${code}`;" }));
    expect(all.map((o) => o.code)).toEqual(["MIU_E_AI_TIMEOUT"]);
    expect(all[0].kind).toBe("mention");
  });
});

describe("renderCatalog", () => {
  test("one ## section per code, with package, status, meaning and fix", () => {
    const entries = collectCodes([
      { kind: "error", code: "MIU_E_B", pkg: "cache", file: "packages/cache/src/x.ts", status: 404, message: "B gone", fix: "Make B." },
      { kind: "error", code: "MIU_E_A", pkg: "miujs", file: "packages/miujs/src/x.ts", status: null, message: null, fix: null },
      { kind: "mention", code: "MIU_E_A", pkg: "web", file: "packages/web/src/x.ts", status: null, message: null, fix: null },
    ]);
    const md = renderCatalog(entries);
    expect(documentedCodes(md)).toEqual(["MIU_E_A", "MIU_E_B"]);
    const b = md.slice(md.indexOf("## MIU_E_B"));
    expect(b).toContain("`@miujs/cache`");
    expect(b).toContain("404");
    expect(b).toContain("B gone");
    expect(b).toContain("Make B.");
    expect(md).toContain("[MIU_E_B](#miu_e_b)");
  });
});

describe("docs/errors.md", () => {
  const md = readFileSync(join(ROOT, "docs", "errors.md"), "utf8");
  const documented = new Set(documentedCodes(md));
  const inSource = collectCodes();

  test("documents every MIU_E_* / MIU_W_* code in packages/*/src", () => {
    const missing = [...inSource.keys()].filter((c) => !documented.has(c));
    if (missing.length) console.error(`Undocumented codes (run: bun scripts/error-catalog.ts): ${missing.join(", ")}`);
    expect(missing).toEqual([]);
  });

  test("has no sections for codes that no longer exist", () => {
    expect([...documented].filter((c) => !inSource.has(c))).toEqual([]);
  });

  test("error bodies link to the code's GitHub anchor in docs/errors.md", () => {
    expect(DOCS_BASE).toBe(blobUrl("docs/errors.md") + "#");
    expect(errors.notFound("user").toJSON().error.docs).toBe(blobUrl("docs/errors.md") + "#miu_e_not_found");
    for (const code of documented) expect(DOCS_BASE + code.toLowerCase()).toBe(`${blobUrl("docs/errors.md")}#${githubAnchor(code)}`);
  });
});
