// Date helpers working on plain YYYY-MM-DD strings in UTC to avoid timezone drift.

const DAY_MS = 86_400_000;

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  return toISODate(new Date(parseISODate(s).getTime() + n * DAY_MS));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / DAY_MS);
}

export function todayISO(): string {
  const now = new Date();
  return toISODate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

/** Same calendar date shifted by whole years; Feb 29 falls back to Feb 28. */
export function shiftYears(s: string, years: number): string {
  const [y, m, d] = s.split('-').map(Number);
  const ty = y + years;
  const isLeap = (ty % 4 === 0 && ty % 100 !== 0) || ty % 400 === 0;
  const day = m === 2 && d === 29 && !isLeap ? 28 : d;
  return `${ty}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface YearWindow {
  /** Year of the window's start date. */
  year: number;
  start: string;
  end: string;
}

/**
 * The most recent `count` historical windows matching the trip's calendar dates,
 * keeping only windows that ended at least `lagDays` ago (reanalysis publishes
 * with a delay). Ordered newest first.
 */
/**
 * ERA5 days newer than this are provisional, and the cache server always asks Open-Meteo for
 * them again (ERA5_SETTLE_DAYS in server/weatherCache.ts). The trip analysis stops here, so it
 * can be served from the database alone.
 */
export const ERA5_SETTLED_DAYS = 10;

export function historicalWindows(
  start: string,
  end: string,
  count = 10,
  lagDays = 7,
  today = todayISO(),
): YearWindow[] {
  const cutoff = addDays(today, -lagDays);
  const windows: YearWindow[] = [];
  for (let k = 1; windows.length < count && k <= count + 3; k++) {
    const s = shiftYears(start, -k);
    const e = shiftYears(end, -k);
    if (e <= cutoff) windows.push({ year: Number(s.slice(0, 4)), start: s, end: e });
  }
  return windows;
}

/** Months (1–12) touched by a date range, in order. */
export function monthsInRange(start: string, end: string): number[] {
  const months: number[] = [];
  let cur = start.slice(0, 7) + '-01';
  while (cur <= end) {
    months.push(Number(cur.slice(5, 7)));
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return [...new Set(months)];
}

/** First-of-month dates (YYYY-MM-01) for each month touched by a range. */
export function monthStartsInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start.slice(0, 7) + '-01';
  while (cur <= end) {
    out.push(cur);
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthName(m: number): string {
  return MONTH_NAMES[m - 1];
}

export function formatDate(s: string): string {
  const d = parseISODate(s);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatShortDate(s: string): string {
  const d = parseISODate(s);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}
