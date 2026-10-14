/** Tiny argv parser: positionals, `--flag value`, `--flag=value`, booleans, repeats, `-x` aliases, `--`. */

export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

export interface ParseSpec {
  /** Flags that take no value. */
  boolean?: string[];
  /** Single-letter aliases, e.g. `{ h: "help" }`. */
  alias?: Record<string, string>;
}

export function parseArgs(argv: string[], spec: ParseSpec): ParsedArgs {
  const bools = new Set(spec.boolean ?? []);
  const out: ParsedArgs = { _: [], flags: {} };
  const set = (k: string, v: string | boolean) => {
    const cur = out.flags[k];
    if (cur === undefined || typeof v === "boolean") out.flags[k] = v;
    else out.flags[k] = Array.isArray(cur) ? [...cur, v] : [String(cur), v];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) set(key, a.slice(eq + 1));
      else if (bools.has(key)) set(key, true);
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`--${key} requires a value`);
        set(key, v);
      }
    } else if (a.length === 2 && a[0] === "-" && a !== "--") {
      const key = spec.alias?.[a[1]!] ?? a[1]!;
      if (bools.has(key)) set(key, true);
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`${a} requires a value`);
        set(key, v);
      }
    } else out._.push(a);
  }
  return out;
}

/** Last value of a flag as a string (repeated flags keep the last). */
export function str(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  if (Array.isArray(v)) return v[v.length - 1];
  return typeof v === "string" ? v : undefined;
}

/** All values of a repeatable flag. */
export function list(flags: ParsedArgs["flags"], key: string): string[] {
  const v = flags[key];
  if (v === undefined || typeof v === "boolean") return [];
  return Array.isArray(v) ? v : [v];
}
