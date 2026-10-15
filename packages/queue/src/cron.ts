import { queueErrors } from "./errors.ts";

/** A parsed 5-field cron expression. Matching is done in UTC, like Cloudflare Cron Triggers. */
export interface Cron {
  /** Normalized expression (single spaces). */
  readonly source: string;
  readonly minute: number[];
  readonly hour: number[];
  readonly dayOfMonth: number[];
  readonly month: number[];
  /** 0 = Sunday. `7` in the expression is folded into 0. */
  readonly dayOfWeek: number[];
  /** True when `date` (seconds ignored) is a time this expression fires. */
  matches(date: Date): boolean;
}

const FIELDS: { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function num(expr: string, field: string, s: string): number {
  if (!/^\d+$/.test(s)) throw queueErrors.cron(expr, `${field}: expected a number, got ${JSON.stringify(s)}`);
  return Number(s);
}

function parseField(expr: string, text: string, f: { name: string; min: number; max: number }): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [rangeText, stepText, extra] = part.split("/");
    if (extra !== undefined) throw queueErrors.cron(expr, `${f.name}: too many "/" in ${JSON.stringify(part)}`);
    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = f.min;
      hi = f.max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      lo = num(expr, f.name, a);
      hi = num(expr, f.name, b);
      if (lo > hi) throw queueErrors.cron(expr, `${f.name}: range ${rangeText} is backwards`);
    } else {
      lo = num(expr, f.name, rangeText);
      hi = stepText === undefined ? lo : f.max; // "5/20" means "from 5, every 20"
    }
    if (lo < f.min || hi > f.max) throw queueErrors.cron(expr, `${f.name}: ${part} is out of range ${f.min}-${f.max}`);
    const step = stepText === undefined ? 1 : num(expr, f.name, stepText);
    if (step < 1) throw queueErrors.cron(expr, `${f.name}: step must be at least 1`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): Cron {
  const source = expr.trim().split(/\s+/).join(" ");
  const parts = source.split(" ");
  if (parts.length !== 5) throw queueErrors.cron(expr, `expected 5 fields, got ${parts.length}`);
  const [minute, hour, dayOfMonth, month, dowRaw] = parts.map((p, i) => parseField(expr, p, FIELDS[i]));
  const dayOfWeek = [...new Set(dowRaw.map((d) => d % 7))].sort((a, b) => a - b);
  const domStar = parts[2] === "*";
  const dowStar = parts[4] === "*";
  const sets = [minute, hour, dayOfMonth, month, dayOfWeek].map((a) => new Set(a));

  return {
    source,
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    matches(date) {
      if (!sets[0].has(date.getUTCMinutes()) || !sets[1].has(date.getUTCHours()) || !sets[3].has(date.getUTCMonth() + 1)) return false;
      const domOk = sets[2].has(date.getUTCDate());
      const dowOk = sets[4].has(date.getUTCDay());
      // Standard cron: if both day fields are restricted, either one matching is enough.
      if (!domStar && !dowStar) return domOk || dowOk;
      return domOk && dowOk;
    },
  };
}
