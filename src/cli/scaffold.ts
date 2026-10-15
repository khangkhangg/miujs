import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Project scaffolding from `templates/<name>/`. */

export const TEMPLATES = ["bun", "node", "workers", "admin", "tour"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** One-line descriptions for `miu --help`. */
export const TEMPLATE_INFO: Record<TemplateName, string> = {
  bun: "minimal API on Bun",
  node: "minimal API on Node 22",
  workers: "minimal API on Cloudflare Workers",
  admin: "Bun + SQLite back-office: resources, login, uploads",
  tour: "Bun + SQLite virtual-tour site (add --with-admin for a back-office)",
};

/** Optional features per template, enabled with `--with-<feature>`. */
export const FEATURES: Partial<Record<TemplateName, readonly string[]>> = { tour: ["admin"] };

export interface CreateOptions {
  template?: string;
  name?: string;
  force?: boolean;
  /** Version of miujs written into package.json. */
  version: string;
  /** Root of the templates directory. */
  templatesDir: string;
  /** Optional features (see `FEATURES`), e.g. `["admin"]` for `tour --with-admin`. */
  features?: string[];
}

/** Files stored under a different name so npm packing keeps them (npm drops `.gitignore`). */
const RENAME: Record<string, string> = { gitignore: ".gitignore" };
/** A `.tmpl` suffix is dropped on copy; it keeps template tests (`app.test.ts.tmpl`) out of this repo's `bun test`. */
const outName = (base: string) => RENAME[base] ?? base.replace(/\.tmpl$/, "");

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

const MARKER = /^[ \t]*(?:\/\/|#|<!--)?[ \t]*\{\{([#^/])([\w-]+)\}\}[ \t]*(?:-->)?[ \t]*$/;

/**
 * Fill `{{var}}` placeholders and resolve feature blocks. A block is a pair of marker lines (optionally written
 * as a `//`, `#` or `<!-- -->` comment): `{{#admin}}` ... `{{/admin}}` keeps its lines when the feature is on,
 * `{{^admin}}` ... `{{/admin}}` when it is off. Marker lines are removed; unknown variables are left as is.
 */
export function renderTemplate(text: string, vars: Record<string, string>, features: ReadonlySet<string>): string {
  const out: string[] = [];
  const stack: { name: string; keep: boolean }[] = [];
  for (const line of text.split("\n")) {
    const m = MARKER.exec(line);
    if (m) {
      const [, kind, name] = m as unknown as [string, string, string];
      if (kind === "/") {
        if (stack.pop()?.name !== name) throw new Error(`Template block {{/${name}}} has no matching opener`);
      } else stack.push({ name, keep: features.has(name) === (kind === "#") });
      continue;
    }
    if (stack.every((b) => b.keep)) out.push(line);
  }
  if (stack.length) throw new Error(`Template block {{#${stack.at(-1)!.name}}} is not closed`);
  return out.join("\n").replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

/** Copy a template into `dir`, filling `{{name}}`, `{{version}}` and `{{date}}`. Returns written paths. */
export async function createProject(dir: string, o: CreateOptions): Promise<string[]> {
  const template = o.template ?? "bun";
  if (!(TEMPLATES as readonly string[]).includes(template)) {
    throw new Error(`Unknown template "${template}". Choose one of: ${TEMPLATES.join(", ")}`);
  }
  const features = new Set(o.features ?? []);
  const supported = FEATURES[template as TemplateName] ?? [];
  for (const f of features) {
    if (!supported.includes(f)) {
      const ok = TEMPLATES.filter((x) => FEATURES[x]?.includes(f));
      throw new Error(`--with-${f} is not available for the ${template} template${ok.length ? ` (use --template ${ok.join("|")})` : ""}`);
    }
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
    // Files under a `_with-<feature>/` directory are only copied (without that segment) when the feature is on.
    const parts = relative(src, file).split(sep);
    const gated = parts.filter((p) => p.startsWith("_with-")).map((p) => p.slice(6));
    if (!gated.every((f) => features.has(f))) continue;
    const rel = parts.filter((p) => !p.startsWith("_with-")).join(sep);
    const out = join(target, dirname(rel), outName(basename(rel)));
    const text = renderTemplate(await readFile(file, "utf8"), vars, features);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text);
    written.push(relative(target, out));
  }
  return written.sort();
}
