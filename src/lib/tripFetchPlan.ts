// Which days of ERA5 history the full trip analysis reads, in one place, so the server's
// background prefetch for saved destinations stores exactly what the analysis will ask for.
//
//   main:  whole calendar years covering the last 10 same-date windows (for the monthly
//          climatology), widened for the ≥30-day rainfall context and the ±7-day odds pad
//   older: small ±7-day windows for the remaining years of the 25-year odds

import { addDays, ERA5_SETTLED_DAYS, historicalWindows, todayISO, type YearWindow } from './dates';
import { contextWindow } from './rainContext';
import { ODDS_PAD_DAYS, oddsWindows } from './tripOdds';

export const HISTORY_YEARS = 10;

export interface FetchRange {
  start: string;
  end: string;
}

export interface TripFetchPlan {
  /** The last 10 same-date windows (newest first), used for charts and comparisons. */
  windows: YearWindow[];
  main: FetchRange | null;
  older: (FetchRange & { year: number })[];
}

export function tripFetchPlan(start: string, end: string, today = todayISO()): TripFetchPlan {
  const windows = historicalWindows(start, end, HISTORY_YEARS, ERA5_SETTLED_DAYS, today);
  if (!windows.length) return { windows, main: null, older: [] };
  const oldest = windows[windows.length - 1];
  const newest = windows[0];
  const ctx = contextWindow(start, end);
  const yearStart = `${oldest.start.slice(0, 4)}-01-01`;
  const ctxStart = addDays(oldest.start, -Math.max(ctx.before, ODDS_PAD_DAYS));
  const yearEnd = `${newest.end.slice(0, 4)}-12-31`;
  const ctxEnd = addDays(newest.end, Math.max(ctx.after, ODDS_PAD_DAYS));
  const latest = addDays(today, -ERA5_SETTLED_DAYS);
  const wantedEnd = ctxEnd > yearEnd ? ctxEnd : yearEnd;
  const main = { start: ctxStart < yearStart ? ctxStart : yearStart, end: wantedEnd < latest ? wantedEnd : latest };
  const older = oddsWindows(start, end, { today }).filter((w) => w.start < main.start || w.end > main.end);
  return { windows, main, older };
}
