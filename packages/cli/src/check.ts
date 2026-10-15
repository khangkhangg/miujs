// `miu check`: leaked secrets, unauthenticated mutations, a typecheck, and node:/bun: imports that
// a Cloudflare Workers bundle cannot load.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BUNX, findEntry, loadApp, str, walk, type CliIO, type Flags, type Runner } from "./util.ts";

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[abpr]-[A-Za-z0-9-]{20,}\b/ },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|json|toml|ya?ml|env)$/;

export interface ForbiddenImport {
  specifier: string;
  importer: string;
}

/**
 * Bundles `entry` the way Wrangler does (browser-like target, ESM) and lists static `node:` / `bun:`
 * imports. Dynamic `import()`s are skipped: they only load when called, which runtime-guarded code
 * (`detectRuntime()`) relies on. Same approach as packages/miujs/test/bundle.test.ts.
 */
export async function workersImports(entry: string): Promise<{ found: ForbiddenImport[]; errors: string[] }> {
  const found: ForbiddenImport[] = [];
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    throw: false,
    plugins: [
      {
        name: "miu-workers-check",
        setup(build) {
          build.onResolve({ filter: /^(node|bun):/ }, (args) => {
            if (args.kind === "import-statement" || args.kind === "require-call") found.push({ specifier: args.path, importer: args.importer });
            return { path: args.path, external: true };
          });
        },
      },
    ],
  } as Parameters<typeof Bun.build>[0]);
  const errors = result.success ? [] : result.logs.filter((l) => l.level === "error").map((l) => String(l.message ?? l));
  return { found, errors };
}

export async function cmdCheck(io: CliIO, positional: string[], flags: Flags, run: Runner) {
  let errors = 0;
  let warnings = 0;
  for (const file of walk(io.cwd, SCAN_EXT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line)) {
          errors++;
          io.out(`error MIU_W_SECRET_IN_CODE ${relative(io.cwd, file)}:${i + 1} looks like a ${p.name}. Fix: move it to an env var or a Cloudflare secret and rotate it.`);
        }
      }
    });
  }
  const entry = findEntry(io.cwd, positional[0] ?? str(flags, "entry"));
  const app = await loadApp(entry);
  for (const r of app.inspect().routes) {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && !r.auth) {
      warnings++;
      io.out(`warn  MIU_W_UNAUTHENTICATED_MUTATION ${r.method} ${r.path} (${r.name}) has no auth. Fix: add \`auth: "required"\`, or \`auth: "optional"\` if it is public on purpose.`);
    }
  }

  // Types: only when the project has a tsconfig.json, so plain-JS apps are not forced into tsc.
  const tsconfig = join(io.cwd, "tsconfig.json");
  if (!flags["no-types"] && existsSync(tsconfig)) {
    const r = await run([...BUNX(), "tsc", "--noEmit", "-p", tsconfig], { cwd: io.cwd });
    if (r.code === 0) io.out("types ok (tsc --noEmit)");
    else {
      const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((l) => l.trim());
      const diagnostics = lines.filter((l) => /error TS\d+/.test(l));
      for (const l of diagnostics.length ? diagnostics : lines.slice(0, 20)) io.out(`error MIU_W_TYPECHECK ${l.trim()}`);
      errors += Math.max(1, diagnostics.length);
      io.out("      Fix the type errors above, or run `miu check --no-types` to skip this step.");
    }
  }

  // Workers: a static node:/bun: import breaks `wrangler deploy`. An error when the app is set up
  // for Workers (a wrangler config exists), a warning otherwise (Bun/Node-only apps may use them).
  const forWorkers = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"].some((f) => existsSync(join(io.cwd, f)));
  const bundle = await workersImports(entry);
  for (const e of bundle.errors) {
    warnings++;
    io.out(`warn  MIU_W_WORKERS_BUNDLE could not bundle for Workers: ${e}`);
  }
  for (const f of bundle.found) {
    const where = relative(io.cwd, f.importer) || f.importer;
    const msg = `MIU_W_WORKERS_NODE_IMPORT ${where} imports ${f.specifier}, which Cloudflare Workers cannot load. Fix: move it behind a runtime check (\`if (detectRuntime() === "bun") await import(...)\`) or into code that only runs on Bun/Node.`;
    if (forWorkers) {
      errors++;
      io.out(`error ${msg}`);
    } else {
      warnings++;
      io.out(`warn  ${msg}`);
    }
  }
  if (!bundle.found.length && !bundle.errors.length) io.out("Workers bundle ok (no static node:/bun: imports)");

  io.out(`\n${errors} error(s), ${warnings} warning(s)`);
  return errors ? 1 : 0;
}
