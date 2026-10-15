// Import wizard logic: header row, column → field mapping, request bodies and the dry-run
// report. Self-contained (see filters.ts).

export interface ImportField {
  name: string;
  label: string;
  readOnly: boolean;
  system: boolean;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: number;
  columns: Record<string, string>;
  ignored: string[];
  errors: { row: number; errors: { field: string; message: string }[] }[];
  imported?: number;
}

export type ImporterLib = ReturnType<typeof importerLib>;

export function importerLib() {
  /** The first CSV record (RFC 4180 quoting). */
  function headers(csv: string): string[] {
    const s = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
    if (!s.trim()) return [];
    const out: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"' && s[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") {
        out.push(cell);
        cell = "";
      } else if (c === "\n" || c === "\r") break;
      else cell += c;
    }
    out.push(cell);
    return out.map((h) => h.trim());
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  function targets<F extends ImportField>(fields: F[]): F[] {
    return fields.filter((f) => !f.system && !f.readOnly);
  }

  /** Header → field name (or null to skip), matching names and labels like the server does. */
  function guess(hs: string[], fields: ImportField[]): Record<string, string | null> {
    const list = targets(fields);
    const out: Record<string, string | null> = {};
    for (const h of hs) {
      const n = norm(h);
      const hit = list.find((f) => norm(f.name) === n) || list.find((f) => norm(f.label) === n);
      out[h] = hit ? hit.name : null;
    }
    return out;
  }

  function duplicates(mapping: Record<string, string | null>): string[] {
    const seen: Record<string, number> = {};
    for (const k of Object.keys(mapping)) {
      const v = mapping[k];
      if (v) seen[v] = (seen[v] || 0) + 1;
    }
    return Object.keys(seen).filter((k) => seen[k] > 1);
  }

  function body(csv: string, mapping: Record<string, string | null>, dryRun: boolean) {
    return { csv, mapping, dryRun };
  }

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  function summary(r: ImportReport): { title: string; canCommit: boolean; rows: { row: number; text: string }[] } {
    const rows = r.errors.map((e) => ({ row: e.row, text: e.errors.map((x) => `${x.field}: ${x.message}`).join("; ") }));
    if (!r.dryRun) return { title: `Imported ${r.imported ?? r.valid} ${plural(r.imported ?? r.valid, "row", "rows")}.`, canCommit: false, rows };
    const title = r.invalid
      ? `${r.valid} of ${r.total} rows are valid; ${r.invalid} ${plural(r.invalid, "has", "have")} errors. Nothing was written.`
      : `All ${r.total} ${plural(r.total, "row is", "rows are")} valid. Nothing was written yet.`;
    return { title, canCommit: r.invalid === 0 && r.total > 0, rows };
  }

  return { headers, guess, targets, duplicates, body, summary };
}
