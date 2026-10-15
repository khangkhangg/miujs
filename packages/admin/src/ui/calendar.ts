// Month grid for the calendar view (server-rendered). Dates are UTC calendar days.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** `month` is 1-12. */
export function parseMonth(raw: string | undefined | null, today: Date): { year: number; month: number } {
  const m = raw ? /^(\d{4})-(\d{2})$/.exec(raw) : null;
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  return { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };
}

/** Weeks (Monday first) covering the month, 7 days each. */
export function monthGrid(year: number, month: number): { date: string; inMonth: boolean }[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = Date.UTC(year, month - 1, 1 - offset);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = Math.ceil((offset + days) / 7);
  const out: { date: string; inMonth: boolean }[][] = [];
  for (let w = 0; w < weeks; w++) {
    const week: { date: string; inMonth: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start + (w * 7 + d) * 86_400_000);
      week.push({ date: iso(day), inMonth: day.getUTCMonth() === month - 1 });
    }
    out.push(week);
  }
  return out;
}

export function monthRange(year: number, month: number) {
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${year}-${pad(month)}-01`, last: `${year}-${pad(month)}-${pad(last)}`, prev, next, label: `${MONTHS[month - 1]} ${year}` };
}
