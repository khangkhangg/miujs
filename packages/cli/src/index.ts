// `miu` command line. `runCli` is pure enough to test: it takes args, a cwd and output sinks
// and returns an exit code.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { camel, jobTemplate, newProjectFiles, pluginTemplate, roomTemplate, routeTemplate } from "./templates.ts";

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

class CliError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

const HELP = `miu — the MiuJS command line

Usage:
  miu dev [entry]                 Run the app with hot reload (bun --hot)
  miu test [entry]                Run the \`tests\` exported by route files
  miu inspect [entry] [--json]    List routes, schemas, plugins and MCP tools
  miu openapi [entry] [--out f]   Print or write the OpenAPI 3.1 spec
  miu check [entry]               Look for leaked secrets and unauthenticated mutations
  miu add route|job|room|plugin <name>
                                  Scaffold a file with a failing test
  miu new <dir>                   Create a new MiuJS project
  miu deploy cloudflare [--dry-run] [--out wrangler.toml] [--force]
                                  Generate wrangler.toml from your plugins and deploy

Entry defaults to app.ts, src/app.ts, index.ts or src/index.ts.`;

interface AppLike {
  ready(): Promise<void>;
  inspect(): any;
  openapi(): any;
  tests: { name: string; fn: (call: unknown) => unknown }[];
  call: unknown;
}

function parseArgs(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--") && (key === "out" || key === "entry")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const ENTRY_CANDIDATES = ["app.ts", "src/app.ts", "index.ts", "src/index.ts"];

function findEntry(cwd: string, given?: string): string {
  if (given) {
    const p = resolve(cwd, given);
    if (!existsSync(p)) throw new CliError("MIU_E_CLI_NO_APP", `Entry file ${given} does not exist`, "Pass the path to the file that default-exports your app.");
    return p;
  }
  for (const c of ENTRY_CANDIDATES) {
    const p = join(cwd, c);
    if (existsSync(p)) return p;
  }
  throw new CliError(
    "MIU_E_CLI_NO_APP",
    `No app entry found in ${cwd}`,
    `Create app.ts with \`export default miu({...})\`, or pass the entry path (tried ${ENTRY_CANDIDATES.join(", ")}).`,
  );
}

async function loadApp(entry: string): Promise<AppLike> {
  const mod = await import(pathToFileURL(entry).href);
  const app = mod.default;
  if (!app || typeof app.inspect !== "function" || typeof app.ready !== "function") {
    throw new CliError("MIU_E_CLI_NO_DEFAULT_EXPORT", `${entry} does not default-export a MiuJS app`, "Add `export default miu({ ... })` to the entry file.");
  }
  await app.ready();
  return app;
}

function writeNew(file: string, content: string) {
  if (existsSync(file)) throw new CliError("MIU_E_CLI_EXISTS", `${file} already exists`, "Pick another name or delete the existing file first.");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ---------- commands ----------

async function cmdInspect(io: CliIO, positional: string[], flags: Record<string, string | true>) {
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? (flags.entry as string | undefined)));
  const info = app.inspect();
  if (flags.json) {
    io.out(JSON.stringify(info, null, 2));
    return 0;
  }
  io.out(`${info.name} ${info.version} (${info.runtime}${info.dev ? ", dev" : ""})`);
  io.out("");
  for (const r of info.routes) {
    const auth = r.auth ? ` [auth: ${typeof r.auth === "object" ? `role ${r.auth.role}` : r.auth}]` : "";
    io.out(`${r.method.padEnd(7)} ${r.path.padEnd(32)} ${r.name}${r.summary ? `  — ${r.summary}` : ""}${auth}`);
  }
  if (info.plugins.length) io.out(`\nPlugins: ${info.plugins.map((p: { name: string }) => p.name).join(", ")}`);
  if (info.mcp) io.out(`MCP: ${info.mcp.path} (${info.mcp.tools.length} tools)`);
  if (info.tests.length) io.out(`Tests: ${info.tests.length}`);
  return 0;
}

async function cmdTest(io: CliIO, positional: string[], flags: Record<string, string | true>) {
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? (flags.entry as string | undefined)));
  let passed = 0;
  let failed = 0;
  for (const t of app.tests) {
    const start = performance.now();
    try {
      await t.fn(app.call);
      passed++;
      io.out(`✓ ${t.name} (${Math.round(performance.now() - start)}ms)`);
    } catch (e) {
      failed++;
      io.out(`✗ ${t.name}`);
      io.out(`    ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (app.tests.length === 0) io.out("No route tests found. Export `tests` from route files to add some.");
  io.out(`\n${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

async function cmdOpenapi(io: CliIO, positional: string[], flags: Record<string, string | true>) {
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? (flags.entry as string | undefined)));
  const spec = JSON.stringify(app.openapi(), null, 2);
  if (typeof flags.out === "string") {
    const file = resolve(io.cwd, flags.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, spec + "\n");
    io.out(`Wrote ${file}`);
  } else io.out(spec);
  return 0;
}

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
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (SCAN_EXT.test(name) && st.size < 1_000_000) yield p;
  }
}

async function cmdCheck(io: CliIO, positional: string[], flags: Record<string, string | true>) {
  let errors = 0;
  let warnings = 0;
  for (const file of walk(io.cwd)) {
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
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? (flags.entry as string | undefined)));
  for (const r of app.inspect().routes) {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && !r.auth) {
      warnings++;
      io.out(`warn  MIU_W_UNAUTHENTICATED_MUTATION ${r.method} ${r.path} (${r.name}) has no auth. Fix: add \`auth: "required"\`, or \`auth: "optional"\` if it is public on purpose.`);
    }
  }
  io.out(`\n${errors} error(s), ${warnings} warning(s)`);
  return errors ? 1 : 0;
}

function cmdAdd(io: CliIO, positional: string[]) {
  const [kind, rawName] = positional;
  const kinds = ["route", "job", "room", "plugin"];
  if (!kind || !kinds.includes(kind) || !rawName) {
    throw new CliError("MIU_E_CLI_ADD_USAGE", `Usage: miu add <kind> <name>`, `<kind> is one of: ${kinds.join(", ")}.`);
  }
  const name = rawName.replace(/^\/+|\/+$/g, "").replace(/\.ts$/, "");
  const base = name.split("/").pop()!;
  const exportName = camel(base);
  const folder = { route: "routes", job: "jobs", room: "rooms", plugin: "plugins" }[kind]!;
  const rel = `${folder}/${name}.ts`;
  const file = join(io.cwd, rel);
  const content =
    kind === "route"
      ? routeTemplate(`/${name}`, exportName, rel)
      : kind === "job"
        ? jobTemplate(base, exportName)
        : kind === "room"
          ? roomTemplate(base, exportName)
          : pluginTemplate(base, exportName);
  writeNew(file, content);
  io.out(`Created ${rel}`);
  const where = kind === "route" ? "miu({ routes: [...] })" : kind === "plugin" ? "miu({ plugins: [...] })" : `the ${kind === "job" ? "queue" : "rooms"} plugin`;
  io.out(`Next: register it in ${where} in app.ts, then run \`miu test\`.`);
  return 0;
}

function cmdNew(io: CliIO, positional: string[]) {
  const name = positional[0];
  if (!name) throw new CliError("MIU_E_CLI_NEW_USAGE", "Usage: miu new <dir>", "Pass the folder name for the new project.");
  const dir = resolve(io.cwd, name);
  if (existsSync(dir) && readdirSync(dir).length) {
    throw new CliError("MIU_E_CLI_EXISTS", `${dir} already exists and is not empty`, "Pick another folder name.");
  }
  const pkgName = name.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  for (const [rel, content] of Object.entries(newProjectFiles(pkgName))) writeNew(join(dir, rel), content);
  io.out(`Created ${pkgName} in ${dir}`);
  io.out(`Next:\n  cd ${name}\n  bun install\n  bun run dev`);
  return 0;
}

export function wranglerToml(info: any, main: string, date = new Date().toISOString().slice(0, 10)): string {
  const cf = info.cloudflare ?? {};
  const queueName = (b: string) => b.toLowerCase().replace(/_/g, "-");
  const parts: string[] = [
    `# Generated by \`miu deploy cloudflare\`. Re-run it after adding plugins.`,
    `name = "${info.name}"`,
    `main = "${main}"`,
    `compatibility_date = "${date}"`,
  ];
  for (const b of cf.kv ?? []) parts.push(`\n[[kv_namespaces]]\nbinding = "${b}"`);
  for (const b of cf.d1 ?? []) parts.push(`\n[[d1_databases]]\nbinding = "${b}"\ndatabase_name = "${queueName(b)}"`);
  for (const b of cf.r2 ?? []) parts.push(`\n[[r2_buckets]]\nbinding = "${b}"\nbucket_name = "${queueName(b)}"`);
  for (const b of cf.queues?.producers ?? []) parts.push(`\n[[queues.producers]]\nbinding = "${b}"\nqueue = "${queueName(b)}"`);
  for (const b of cf.queues?.consumers ?? []) parts.push(`\n[[queues.consumers]]\nqueue = "${queueName(b)}"`);
  const dos = cf.durableObjects ?? [];
  for (const d of dos) parts.push(`\n[[durable_objects.bindings]]\nname = "${d.binding}"\nclass_name = "${d.className}"`);
  if (dos.length) {
    parts.push(`\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = [${dos.map((d: { className: string }) => `"${d.className}"`).join(", ")}]`);
  }
  if (cf.crons?.length) parts.push(`\n[triggers]\ncrons = [${cf.crons.map((c: string) => `"${c}"`).join(", ")}]`);
  return parts.join("\n") + "\n";
}

async function cmdDeploy(io: CliIO, positional: string[], flags: Record<string, string | true>) {
  const target = positional[0];
  if (target !== "cloudflare") {
    throw new CliError("MIU_E_CLI_DEPLOY_TARGET", `Unknown deploy target "${target ?? ""}"`, "Use `miu deploy cloudflare`. Other targets (fly, vps, binary) are planned.");
  }
  const entry = findEntry(io.cwd, flags.entry as string | undefined);
  const out = resolve(io.cwd, typeof flags.out === "string" ? flags.out : "wrangler.toml");
  // Build the app as Workers will run it, so plugins pick their Cloudflare defaults
  // (see targetRuntime() in miujs) and declare the bindings they need.
  const previous = process.env.MIU_TARGET;
  process.env.MIU_TARGET = "cloudflare";
  let toml: string;
  try {
    const app = await loadApp(entry);
    toml = wranglerToml(app.inspect(), relative(dirname(out), entry).replace(/\\/g, "/"));
  } finally {
    if (previous === undefined) delete process.env.MIU_TARGET;
    else process.env.MIU_TARGET = previous;
  }
  if (existsSync(out) && !flags.force && !flags["dry-run"]) {
    throw new CliError("MIU_E_CLI_EXISTS", `${out} already exists`, "Re-run with --force to overwrite it, or --dry-run --out other.toml to compare.");
  }
  writeFileSync(out, toml);
  io.out(`Wrote ${out}`);
  if (flags["dry-run"]) {
    io.out(toml);
    return 0;
  }
  const proc = Bun.spawn(["bunx", "wrangler", "deploy", "--config", out], { cwd: io.cwd, stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

async function cmdDev(io: CliIO, positional: string[], flags: Record<string, string | true>) {
  const entry = findEntry(io.cwd, positional[0] ?? (flags.entry as string | undefined));
  io.out(`miu dev: bun --hot ${relative(io.cwd, entry)}`);
  const proc = Bun.spawn([process.execPath, "--hot", entry], { cwd: io.cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, MIU_ENV: "development" } });
  return await proc.exited;
}

export async function runCli(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  const { positional, flags } = parseArgs(rest);
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      case "inspect":
        return await cmdInspect(io, positional, flags);
      case "test":
        return await cmdTest(io, positional, flags);
      case "openapi":
        return await cmdOpenapi(io, positional, flags);
      case "check":
        return await cmdCheck(io, positional, flags);
      case "add":
        return cmdAdd(io, positional);
      case "new":
        return cmdNew(io, positional);
      case "deploy":
        return await cmdDeploy(io, positional, flags);
      case "dev":
        return await cmdDev(io, positional, flags);
      default:
        throw new CliError("MIU_E_CLI_UNKNOWN_COMMAND", `Unknown command "${command}"`, "Run `miu help` to see the commands.");
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`error ${e.code}: ${e.message}\n  fix: ${e.fix}`);
      return 1;
    }
    const err = e as { code?: string; message?: string; fix?: string };
    if (err && typeof err.code === "string" && err.code.startsWith("MIU_E_")) {
      io.err(`error ${err.code}: ${err.message}${err.fix ? `\n  fix: ${err.fix}` : ""}`);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 1;
  }
}
