import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Route } from "../core/app.ts";
import type { AppLike } from "../core/context.ts";
import { generateLlmsFullTxt, generateLlmsTxt } from "../ai/llms.ts";
import { listTools } from "../ai/mcp.ts";
import { generateOpenAPI } from "../ai/openapi.ts";
import { operationId } from "../ai/shared.ts";
import { list, parseArgs, str, type ParsedArgs } from "./args.ts";
import { createProject, TEMPLATES } from "./scaffold.ts";
import { generateWranglerToml } from "./wrangler.ts";

/** The `miu` command line. Runs on Bun and on Node 22 (`--experimental-strip-types`). */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const HELP = `miu — MiuJS command line

Usage
  miu <command> [options]

Commands
  create <dir>          Scaffold a new app
      --template bun|node|workers   (default bun)
      --name <pkg>                  package name (default: directory name)
      --force                       allow a non-empty directory
  routes [entry]        Print the route table (METHOD PATH TOOL SUMMARY)
  openapi [entry]       Print the OpenAPI 3.1 document   [--out file] [--server url]
  llms [entry]          Print llms.txt                   [--full] [--out file] [--base-url url]
  tools [entry]         Print the MCP tool list as JSON  [--out file]
  wrangler              Generate wrangler.toml for Cloudflare Workers
      --name <worker> --main <file> --kv NAME --d1 NAME[:db] --r2 NAME[:bucket]
      --queue NAME[:queue] --do Class|NAME:Class --nodejs-compat --out file [--force]
  introspect <db-url>   Generate schemas from a database (sqlite:<path>)

  [entry] is a module whose default export (or named \`app\` export) is a Miu app.
  It defaults to src/app.ts.

Options
  -h, --help            Show this help
  -v, --version         Show the version
`;

const BOOLEAN = ["help", "version", "force", "full", "nodejs-compat"];

/** Output sink; tests and the bin entry use the process streams. */
export interface Io {
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
  cwd: string;
}

const write = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>((r) => (stream.write(text) ? r() : stream.once("drain", () => r())));

export const processIo: Io = {
  out: (t) => write(process.stdout, t),
  err: (t) => write(process.stderr, t),
  cwd: process.cwd(),
};

class CliError extends Error {}

const exists = (p: string) => stat(p).then(() => true, () => false);

export async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/** Import an app module: default export, else a named `app` export. */
export async function loadApp(entry: string | undefined, cwd: string): Promise<AppLike> {
  const candidates = entry ? [entry] : ["src/app.ts", "app.ts", "src/index.ts"];
  let file: string | undefined;
  for (const c of candidates) {
    const p = resolve(cwd, c);
    if (await exists(p)) {
      file = p;
      break;
    }
  }
  if (!file) throw new CliError(entry ? `Cannot find app entry: ${entry}` : "No entry given and src/app.ts not found. Usage: miu routes <entry>");
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; app?: unknown };
  for (const candidate of [mod.default, mod.app]) {
    const app = candidate as AppLike | undefined;
    if (app && Array.isArray(app.routes) && typeof app.fetch === "function") return app;
  }
  throw new CliError(`${entry ?? file} does not export a Miu app (export default app, or export const app)`);
}

async function output(io: Io, text: string, out: string | undefined): Promise<void> {
  if (!out) return io.out(text.endsWith("\n") ? text : `${text}\n`);
  await writeFile(resolve(io.cwd, out), text.endsWith("\n") ? text : `${text}\n`);
  await io.err(`Wrote ${out}\n`);
}

const TOOL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function routeTable(app: AppLike): string {
  const rows = [["METHOD", "PATH", "TOOL", "SUMMARY"]];
  for (const r of app.routes as Route[]) {
    const m = r.meta ?? {};
    const tool = m.tool === false || !TOOL_METHODS.has(r.method) ? "-" : (typeof m.tool === "object" && m.tool.name) || operationId(r);
    const summary = (m.summary ?? m.description ?? "") + (m.hidden ? " (hidden)" : "");
    rows.push([r.method, r.path, tool, summary]);
  }
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell)).join("  ").trimEnd()).join("\n") + "\n";
}

async function introspectCmd(args: ParsedArgs, io: Io): Promise<number> {
  const url = new URL("../migrate/introspect.ts", import.meta.url);
  let mod: { introspect?: Function; toSchemaSource?: Function } | undefined;
  if (await exists(fileURLToPath(url))) mod = await import(url.href);
  if (!mod || typeof mod.introspect !== "function" || typeof mod.toSchemaSource !== "function") {
    await io.err("miu introspect is available once the migration kit lands; see `miujs/migrate`.\n");
    return 1;
  }
  const target = args._[1];
  if (!target) throw new CliError("Usage: miu introspect sqlite:<path>");
  const m = /^sqlite:(?:\/\/)?(.+)$/.exec(target);
  if (!m) throw new CliError(`Unsupported database URL: ${target} (supported: sqlite:<path>)`);
  const path = resolve(io.cwd, m[1]!);
  if (!(await exists(path))) throw new CliError(`SQLite database not found: ${path}`);
  const { openDatabase } = await import("../batteries/sqlite.ts");
  const db = await openDatabase(path);
  try {
    const query = (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params);
    const result = (await mod.introspect({ dialect: "sqlite", query })) as { tables: unknown[] };
    const sources = await Promise.all(result.tables.map((t) => mod!.toSchemaSource!(t) as string));
    await output(io, sources.join("\n\n"), str(args.flags, "out"));
  } finally {
    db.close();
  }
  return 0;
}

/** Run the CLI; returns the exit code. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, { boolean: BOOLEAN, alias: { h: "help", v: "version", o: "out" } });
  } catch (e) {
    await io.err(`${(e as Error).message}\n`);
    return 1;
  }
  const f = args.flags;
  const [cmd, entry] = args._;
  try {
    if (f.version && !cmd) {
      await io.out(`${await version()}\n`);
      return 0;
    }
    if (f.help || !cmd || cmd === "help") {
      await io.out(HELP);
      return 0;
    }
    switch (cmd) {
      case "create": {
        if (!entry) throw new CliError("Usage: miu create <dir> [--template bun|node|workers] [--name pkg] [--force]");
        const template = str(f, "template") ?? "bun";
        const files = await createProject(resolve(io.cwd, entry), {
          template,
          name: str(f, "name"),
          force: f.force === true,
          version: await version(),
          templatesDir: resolve(ROOT, "templates"),
        });
        const install = template === "bun" ? "bun install" : "npm install";
        const dev = template === "bun" ? "bun run dev" : "npm run dev";
        await io.out(`Created ${entry} (${template} template)\n${files.map((x) => `  ${x}`).join("\n")}\n\nNext:\n  cd ${entry}\n  ${install}\n  ${dev}\n`);
        return 0;
      }
      case "routes":
        await io.out(routeTable(await loadApp(entry, io.cwd)));
        return 0;
      case "openapi": {
        const server = str(f, "server");
        const doc = generateOpenAPI(await loadApp(entry, io.cwd), server ? { servers: [{ url: server }] } : {});
        await output(io, JSON.stringify(doc, null, 2), str(f, "out"));
        return 0;
      }
      case "llms": {
        const app = await loadApp(entry, io.cwd);
        const opts = { baseUrl: str(f, "base-url"), intro: str(f, "intro") };
        await output(io, f.full ? generateLlmsFullTxt(app, opts) : generateLlmsTxt(app, opts), str(f, "out"));
        return 0;
      }
      case "tools":
        await output(io, JSON.stringify(listTools(await loadApp(entry, io.cwd)), null, 2), str(f, "out"));
        return 0;
      case "wrangler": {
        const toml = generateWranglerToml({
          name: str(f, "name") ?? "miu-app",
          main: str(f, "main"),
          nodejsCompat: f["nodejs-compat"] === true,
          kv: list(f, "kv"),
          d1: list(f, "d1"),
          r2: list(f, "r2"),
          queue: list(f, "queue"),
          do: list(f, "do"),
        });
        const out = str(f, "out");
        if (out && !f.force && (await exists(resolve(io.cwd, out)))) throw new CliError(`${out} already exists (use --force to overwrite)`);
        await output(io, toml, out);
        return 0;
      }
      case "introspect":
        return await introspectCmd(args, io);
      default:
        throw new CliError(`Unknown command "${cmd}". Run \`miu --help\` for usage.`);
    }
  } catch (e) {
    // Expected failures print one line; set MIU_DEBUG=1 for stack traces of unexpected ones.
    const debug = !(e instanceof CliError) && process.env.MIU_DEBUG;
    await io.err(`miu: ${debug ? (e as Error).stack : ((e as Error)?.message ?? String(e))}\n`);
    return 1;
  }
}

export { TEMPLATES };
