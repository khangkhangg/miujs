#!/usr/bin/env node
// create-miu: `npm create miu@latest my-app` / `bun create miu my-app`.
// Delegates to the `create` command of the installed miujs CLI, so templates and flags
// always match the miujs version that the new app will depend on.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELP = `create-miu — scaffold a new MiuJS app

Usage
  npm create miu@latest [dir] -- [--template bun|node|workers|admin|tour] [--with-admin] [--name pkg] [--force]
  bun create miu [dir] [--template bun|node|workers|admin|tour] [--with-admin] [--name pkg] [--force]

  dir defaults to ./miu-app; template defaults to bun.
`;

/** Root directory of the installed miujs package. */
function miujsRoot() {
  // "miujs/package.json" is not exported, so resolve the main entry and walk up to its package.json.
  let dir = dirname(fileURLToPath(import.meta.resolve("miujs")));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "miujs") return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("create-miu: cannot locate the miujs package");
    dir = up;
  }
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
// First argument that is not a flag (or a flag's value) is the target directory.
const VALUE_FLAGS = new Set(["--template", "-t", "--name"]);
const hasDir = args.some((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(args[i - 1] ?? ""));

const root = miujsRoot();
// Published builds ship dist/; a Bun checkout of miujs can run the TypeScript source directly.
const entry = [join(root, "dist/cli/main.js"), join(root, "src/cli/main.ts")].find((f) => existsSync(f));
if (!entry) throw new Error(`create-miu: miujs at ${root} has no CLI (dist/cli/main.js)`);
const { main } = await import(pathToFileURL(entry).href);
process.exit(await main(["create", ...(hasDir ? [] : ["miu-app"]), ...args]));
