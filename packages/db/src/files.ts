// Migrations from `NNNN_name.sql` files: read from a directory (Bun/Node/Deno), or from a
// `{ path: text }` map that a bundler produced (Workers, where there is no filesystem).
// Same naming as drizzle-kit and `wrangler d1 migrations`, so their folders load as-is.

import { detectRuntime, errors, type Runtime } from "miujs";
import type { Migration } from "./index.ts";

const FILE = /^(\d+)_[^/\\]*\.sql$/i;

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function fromFiles(files: { name: string; sql: string }[], where: string): Migration[] {
  const parsed = files.map((f) => {
    const m = FILE.exec(f.name);
    if (!m) {
      throw errors.config(
        "MIU_E_DB_MIGRATION_NAME",
        `Migration file "${f.name}" in ${where} has no number prefix`,
        `Rename ${f.name} to NNNN_name.sql (e.g. 0003_${f.name}), or move it out of the migrations folder.`,
      );
    }
    return { n: Number(m[1]), name: f.name, id: f.name.slice(0, -4), sql: f.sql };
  });
  parsed.sort((a, b) => a.n - b.n || (a.name < b.name ? -1 : 1));
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].n === parsed[i - 1].n) {
      throw errors.config(
        "MIU_E_DB_MIGRATION_DUPLICATE",
        `Two migrations in ${where} share number ${parsed[i].n}`,
        `Renumber one of ${parsed[i - 1].name} and ${parsed[i].name} so every number is unique (never renumber one already applied).`,
      );
    }
  }
  return parsed.map(({ id, sql }) => ({ id, sql }));
}

export interface LoadMigrationsOptions {
  /** @internal Override runtime detection (tests). */
  runtime?: Runtime;
}

/**
 * Reads `NNNN_name.sql` files from `dir`, ordered by number. The id is the file name without
 * `.sql`. Other files (README, drizzle-kit's `meta/`) are ignored; a `.sql` file without a number
 * is an error. Bun, Node and Deno only; on Workers use `migrationsFromGlob`.
 */
export async function loadMigrations(dir: string, opts: LoadMigrationsOptions = {}): Promise<Migration[]> {
  const runtime = opts.runtime ?? detectRuntime();
  if (runtime !== "bun" && runtime !== "node" && runtime !== "deno") {
    throw errors.config(
      "MIU_E_DB_UNSUPPORTED",
      `loadMigrations() reads the filesystem, which ${runtime} does not have`,
      "Bundle the SQL as text and use migrationsFromGlob({ \"0001_init.sql\": sqlText, ... }) instead (e.g. import sql from \"./migrations/0001_init.sql\" with a text loader).",
    );
  }
  const mod = "node:fs/promises";
  const fs = (await import(/* @vite-ignore */ mod)) as typeof import("node:fs/promises");
  let entries: { name: string; isFile(): boolean }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw errors.config(
      "MIU_E_DB_MIGRATIONS_DIR",
      `Cannot read migrations directory ${dir}: ${(err as Error)?.message ?? err}`,
      `Create ${dir} (relative paths resolve from the working directory) or pass the right path to loadMigrations().`,
    );
  }
  const names = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sql")).map((e) => e.name);
  const files = await Promise.all(names.map(async (name) => ({ name, sql: await fs.readFile(`${dir}/${name}`, "utf8") })));
  return fromFiles(files, dir);
}

/**
 * Migrations from a `{ path: sqlText }` map, for runtimes without a filesystem (Workers): keys are
 * paths or file names (only the base name counts), values are the SQL text or a module whose
 * `default` is the text (`import.meta.glob(..., { query: "?raw" })` style). Non-`.sql` keys are ignored.
 */
export function migrationsFromGlob(files: Record<string, string | { default: string }>): Migration[] {
  const list: { name: string; sql: string }[] = [];
  for (const [path, value] of Object.entries(files)) {
    const name = basename(path);
    if (!name.toLowerCase().endsWith(".sql")) continue;
    const sql = typeof value === "string" ? value : typeof value?.default === "string" ? value.default : undefined;
    if (sql === undefined) {
      throw errors.config(
        "MIU_E_DB_MIGRATION_INVALID",
        `Migration "${path}" is not text`,
        'Pass the file contents as a string: import the .sql file as text (Wrangler: rules = [{ type = "Text", globs = ["**/*.sql"] }]; Bun: with { type: "text" }).',
      );
    }
    list.push({ name, sql });
  }
  return fromFiles(list, "migrationsFromGlob()");
}
