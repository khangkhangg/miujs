import { workflowErrors } from "./errors.ts";

/** "1d", "12h", "3 days", or milliseconds. */
export type Duration = string | number;

const UNITS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** Longest duration accepted: 100 years. Keeps wake-up times exact integers in every store. */
export const MAX_DURATION_MS = 100 * 365 * 86_400_000;

/** Milliseconds in `value`. Throws MIU_E_WORKFLOW_DURATION. */
export function parseDuration(value: Duration): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS) return value;
    throw workflowErrors.duration(value);
  }
  const m = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value) : null;
  const unit = m ? UNITS[m[2].toLowerCase()] : undefined;
  if (!m || unit === undefined) throw workflowErrors.duration(value);
  const ms = Math.round(Number(m[1]) * unit);
  if (!(ms <= MAX_DURATION_MS)) throw workflowErrors.duration(value);
  return ms;
}
