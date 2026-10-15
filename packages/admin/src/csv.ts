// CSV: RFC 4180 writing (with spreadsheet formula-injection protection) and parsing.

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * One CSV cell. Text starting with `= + - @` (or tab/CR) is prefixed with `'` so spreadsheets
 * show it as text instead of running it as a formula. Numbers are left alone.
 */
export function csvCell(value: unknown, o: { numeric?: boolean } = {}): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value !== "number" && typeof value !== "bigint" && !o.numeric && FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[], numeric?: boolean[]): string {
  return cells.map((c, i) => csvCell(c, { numeric: numeric?.[i] })).join(",") + "\r\n";
}

/** Undoes the formula guard on import: `'=x` → `=x`. */
export function unguard(s: string): string {
  return s.length > 1 && s[0] === "'" && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s;
}

/** Parses CSV text into rows of cells. Blank lines are skipped. Throws on an unterminated quote. */
export function parseCsv(text: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cellStarted = false;
  const endRow = () => {
    if (row.length > 0 || cellStarted || cell !== "") {
      row.push(cell);
      rows.push(row);
      if (rows.length > maxRows) throw new RangeError("too many rows");
    }
    row = [];
    cell = "";
    cellStarted = false;
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      cellStarted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      cellStarted = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += c;
      cellStarted = true;
    }
  }
  if (quoted) throw new SyntaxError("unterminated quote in CSV");
  endRow();
  return rows;
}
