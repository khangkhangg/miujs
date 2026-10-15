// `miu` command line. `runCli` is pure enough to test: it takes args, a cwd, output sinks and an
// optional command runner (for wrangler, flyctl, bun build, ...) and returns an exit code.

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cmdCheck } from "./check.ts";
import { cmdDb } from "./db.ts";
import { cmdDeploy } from "./deploy.ts";
import { cmdLoadtest } from "./loadtest.ts";
import { cmdLogs } from "./logs.ts";
import { camel, jobTemplate, pluginTemplate, roomTemplate, routeTemplate, templateFiles, TEMPLATES } from "./templates.ts";
import { CliError, defaultRunner, findEntry, loadApp, parseArgs, str, writeFile, writeNew, type CliIO, type FlagSpec, type Flags, type Runner } from "./util.ts";

export { CliError, defaultRunner, parseArgs, type CliIO, type RunOptions, type RunResult, type Runner } from "./util.ts";
export { inlineParams, wranglerD1 } from "./db.ts";
export { appEnv, defaultCompatDate, dockerfile, shippedPaths, withHyperdrive, wranglerToml, DEPLOY_TARGETS } from "./deploy.ts";
export { formatEntry, entriesFromTail, jsonObjectSplitter, parseLine, type LogEntry } from "./logs.ts";
export { parseActions } from "./loadtest.ts";
export { workersImports } from "./check.ts";
export { TEMPLATES, templateFiles } from "./templates.ts";

const HELP = `miu — the MiuJS command line

Usage:
  miu dev [entry]                 Run the app with hot reload (bun --hot)
  miu test [entry]                Run the \`tests\` exported by route files
  miu inspect [entry] [--json]    List routes, schemas, plugins and MCP tools
  miu openapi [entry] [--out f]   Print or write the OpenAPI 3.1 spec
  miu check [entry] [--no-types]  Leaked secrets, unauthenticated mutations, tsc --noEmit
                                  (when a tsconfig.json exists) and node:/bun: imports that
                                  would break a Cloudflare Workers bundle
  miu add route|job|room|plugin <name>
                                  Scaffold a file with a failing test
  miu new <dir> [--template api]  Create a new MiuJS project. Templates:
                                    api           JSON API with a health route (default)
                                    fullstack     @miujs/web JSX pages + htmx
                                    quiz-game     the Kahoot-style quiz (examples/quiz)
                                    chat          realtime chat room + client page
                                    saas-starter  auth, sessions, orgs, mail, audit, workflows
                                    crm           contacts per org + a follow-up workflow (minimal)
                                    game          a realtime multiplayer room (minimal)

  miu db pull [--db file.sqlite | --d1 name] [--out schema.ts] [--json]
                                  Introspect a database and write a Drizzle schema.ts
                                  (or print the JSON description)
  miu db migrate [--dir migrations] [--db file.sqlite | --d1 name]
                                  Apply NNNN_name.sql files that have not run yet
  miu db migrate --generate <name> --schema schema.ts [--dir migrations] [--db f | --d1 n]
                                  Diff your Drizzle schema against the database (or the
                                  migrations replayed in memory) and write the next
                                  NNNN_<name>.sql. Destructive changes are printed, never written.
      --d1 <name> runs \`bunx wrangler d1 execute <name> --remote --json\` (needs \`wrangler login\`).
      Applied migrations are recorded in the _miu_migrations table (the same one db({ migrations })
      uses at runtime). Wrangler's \`wrangler d1 migrations apply\` keeps its own d1_migrations table
      instead; both read the same NNNN_name.sql files, but they do not know about each other, so
      pick one tool per database. Both tables are skipped by \`miu db pull\`.

  miu loadtest <ws-url> --players N --duration 10s [--action '{"type":"inc","data":{}}']
               [--rate 5] [--json]
                                  Simulate N room clients and print p50/p95/p99 patch latency
                                  (--action also accepts a protocol frame {"t":"msg","type":...});
                                  without --action: join-only, reports join/welcome latency
                                  and join failures by code
  miu logs [--last N] [--json] [--file app.log | --worker name]
                                  Pretty-print the app's JSON-lines log: a local file (--file),
                                  or \`wrangler tail --format json\` for Cloudflare
  miu deploy <target> [--dry-run] [--force] [--entry app.ts]
      cloudflare [--out wrangler.toml] [--compatibility-date YYYY-MM-DD]
                                        wrangler.toml from your plugins, secrets to set, then deploy
      fly                               Dockerfile (oven/bun, non-root) + fly.toml, then flyctl deploy
      railway                           Dockerfile + railway.json, then railway up
      render                            Dockerfile + render.yaml (deploy from git as a Blueprint)
      vps [--host user@server] [--domain example.com]
                                        systemd unit + Caddyfile; prints the rsync/ssh commands
      binary [--out dist/app]           bun build --compile into one executable
      deno-deploy                       deno.json deploy config; deployctl deploy
      --dry-run writes the files and prints the next commands without running anything.

Entry defaults to app.ts, src/app.ts, index.ts or src/index.ts.`;

const ENTRY: FlagSpec = { entry: "value" };
const FLAGS: Record<string, FlagSpec> = {
  dev: ENTRY,
  test: ENTRY,
  inspect: { ...ENTRY, json: "bool" },
  openapi: { ...ENTRY, out: "value" },
  check: { ...ENTRY, "no-types": "bool" },
  add: {},
  new: { template: "value" },
  deploy: { ...ENTRY, out: "value", "dry-run": "bool", force: "bool", host: "value", domain: "value", region: "value", port: "value", "compatibility-date": "value" },
  db: { db: "value", d1: "value", out: "value", json: "bool", dir: "value", generate: "value", schema: "value" },
  loadtest: { players: "value", duration: "value", action: "value", rate: "value", json: "bool" },
  logs: { last: "value", json: "bool", file: "value", worker: "value" },
};

// ---------- commands ----------

async function cmdInspect(io: CliIO, positional: string[], flags: Flags) {
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? str(flags, "entry")));
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

async function cmdTest(io: CliIO, positional: string[], flags: Flags) {
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? str(flags, "entry")));
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

async function cmdOpenapi(io: CliIO, positional: string[], flags: Flags) {
  const app = await loadApp(findEntry(io.cwd, positional[0] ?? str(flags, "entry")));
  const spec = JSON.stringify(app.openapi(), null, 2);
  const out = str(flags, "out");
  if (out) {
    const file = resolve(io.cwd, out);
    writeFile(file, spec + "\n");
    io.out(`Wrote ${file}`);
  } else io.out(spec);
  return 0;
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

function cmdNew(io: CliIO, positional: string[], flags: Flags) {
  const name = positional[0];
  if (!name) throw new CliError("MIU_E_CLI_NEW_USAGE", "Usage: miu new <dir> [--template api]", "Pass the folder name for the new project.");
  const template = str(flags, "template") ?? "api";
  const info = TEMPLATES[template];
  if (!info) {
    throw new CliError("MIU_E_CLI_TEMPLATE", `Unknown template "${template}"`, `Use --template with one of: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.description})`).join(", ")}.`);
  }
  const dir = resolve(io.cwd, name);
  if (existsSync(dir) && readdirSync(dir).length) {
    throw new CliError("MIU_E_CLI_EXISTS", `${dir} already exists and is not empty`, "Pick another folder name.");
  }
  const pkgName = name.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (info.inProgress) io.out(`${template}: kit in progress; generating a minimal starter.`);
  for (const [rel, content] of Object.entries(templateFiles(template, pkgName))) writeNew(join(dir, rel), content);
  io.out(`Created ${pkgName} in ${dir} (template: ${template})`);
  io.out(`Next:\n  cd ${name}\n  bun install\n  bun run dev`);
  return 0;
}

async function cmdDev(io: CliIO, positional: string[], flags: Flags, run: Runner) {
  const entry = findEntry(io.cwd, positional[0] ?? str(flags, "entry"));
  io.out(`miu dev: bun --hot ${relative(io.cwd, entry)}`);
  return (await run([process.execPath, "--hot", entry], { cwd: io.cwd, inherit: true, env: { MIU_ENV: "development" } })).code;
}

export async function runCli(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  const run = io.run ?? defaultRunner;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      io.out(HELP);
      return 0;
    }
    const spec = FLAGS[command];
    if (!spec) throw new CliError("MIU_E_CLI_UNKNOWN_COMMAND", `Unknown command "${command}"`, "Run `miu help` to see the commands.");
    const { positional, flags } = parseArgs(rest, spec, command);
    if (flags.help) {
      io.out(HELP);
      return 0;
    }
    switch (command) {
      case "inspect":
        return await cmdInspect(io, positional, flags);
      case "test":
        return await cmdTest(io, positional, flags);
      case "openapi":
        return await cmdOpenapi(io, positional, flags);
      case "check":
        return await cmdCheck(io, positional, flags, run);
      case "add":
        return cmdAdd(io, positional);
      case "new":
        return cmdNew(io, positional, flags);
      case "deploy":
        return await cmdDeploy(io, positional, flags, run);
      case "dev":
        return await cmdDev(io, positional, flags, run);
      case "db":
        return await cmdDb(io, positional, flags, run);
      case "loadtest":
        return await cmdLoadtest(io, positional, flags);
      case "logs":
        return await cmdLogs(io, flags, run);
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
