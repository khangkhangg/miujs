import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Project scaffolding from `templates/<name>/`. */

export const TEMPLATES = ["bun", "node", "workers"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface CreateOptions {
  template?: string;
  name?: string;
  force?: boolean;
  /** Version of miujs written into package.json. */
  version: string;
  /** Root of the templates directory. */
  templatesDir: string;
}

/** Files stored under a different name so npm packing keeps them (npm drops `.gitignore`). */
const RENAME: Record<string, string> = { gitignore: ".gitignore" };

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Valid npm package name derived from a directory name. */
export function packageName(dir: string): string {
  const n = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[-._]+|-+$/g, "");
  return n || "miu-app";
}

/** Copy a template into `dir`, filling `{{name}}`, `{{version}}` and `{{date}}`. Returns written paths. */
export async function createProject(dir: string, o: CreateOptions): Promise<string[]> {
  const template = o.template ?? "bun";
  if (!(TEMPLATES as readonly string[]).includes(template)) {
    throw new Error(`Unknown template "${template}". Choose one of: ${TEMPLATES.join(", ")}`);
  }
  const target = resolve(dir);
  const existing = await readdir(target).catch(() => [] as string[]);
  if (existing.length && !o.force) throw new Error(`${dir} is not empty (use --force to scaffold anyway)`);

  const name = o.name ?? packageName(target);
  if (!/^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)) {
    throw new Error(`Invalid package name "${name}" (lowercase letters, digits, - . _ ~)`);
  }
  const vars: Record<string, string> = {
    name,
    version: o.version,
    date: new Date().toISOString().slice(0, 10),
  };
  const src = join(o.templatesDir, template);
  const written: string[] = [];
  for (const file of await walk(src)) {
    const rel = relative(src, file);
    const out = join(target, dirname(rel), RENAME[basename(rel)] ?? basename(rel));
    const text = (await readFile(file, "utf8")).replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text);
    written.push(relative(target, out));
  }
  return written.sort();
}
