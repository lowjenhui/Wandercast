// Typical weather per calendar month for a place, rated with the same scoring as Sunny windows
// (scoreSuitability: rain, temperature, humidity and curated seasonal risks), from stored ERA5
// history aggregated by year and month. Used by the weather library's Best months strip,
// "Good in a month" filter and "Driest in a month" sort.

import { daysBetween } from './dates';
import { scoreSuitability, type SuitabilityRating } from './weatherAnalysis';
import type { SeasonalRisk } from '../types';

/** One calendar month of one year, as summed by the database. */
export interface YearMonthStats {
  /** "YYYY-MM". */
  ym: string;
  /** Days with rainfall stored. */
  valid: number;
  wet: number;
  heavy: number;
  tMax: number | null;
  tMin: number | null;
  rh: number | null;
}

export interface MonthRating {
  rating: SuitabilityRating;
  score: number;
  /** Share of days wet (≥ 1 mm), for "Driest in a month". */
  wetShare: number;
}

/** Fewest complete years a month needs to be rated (as Sunny windows). */
export const MONTH_MIN_YEARS = 3;

const daysIn = (ym: string) => daysBetween(`${ym}-01`, nextMonth(ym));
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Twelve ratings (January first), null for months with too few complete years. */
export function monthRatings(rows: YearMonthStats[], risksFor: (month: number) => SeasonalRisk[]): (MonthRating | null)[] {
  const acc = Array.from({ length: 12 }, () => ({ n: 0, wet: 0, heavyPerWeek: 0, tMax: [0, 0], tMin: [0, 0], rh: [0, 0] }));
  for (const r of rows) {
    // Complete months only, like the Through the year normals.
    if (r.valid < daysIn(r.ym) * 0.9) continue;
    const a = acc[Number(r.ym.slice(5, 7)) - 1];
    a.n++;
    a.wet += r.wet / r.valid;
    a.heavyPerWeek += (r.heavy / r.valid) * 7;
    if (r.tMax !== null) (a.tMax[0] += r.tMax), a.tMax[1]++;
    if (r.tMin !== null) (a.tMin[0] += r.tMin), a.tMin[1]++;
    if (r.rh !== null) (a.rh[0] += r.rh), a.rh[1]++;
  }
  return acc.map((a, i) => {
    if (a.n < MONTH_MIN_YEARS || !a.tMax[1] || !a.tMin[1]) return null;
    const wetShare = a.wet / a.n;
    const s = scoreSuitability(
      { wetShare, heavyPerWeek: a.heavyPerWeek / a.n, tMax: a.tMax[0] / a.tMax[1], tMin: a.tMin[0] / a.tMin[1], rh: a.rh[1] ? a.rh[0] / a.rh[1] : null },
      risksFor(i + 1),
    );
    return { rating: s.rating, score: s.score, wetShare };
  });
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isGreen = (r: MonthRating | null) => r?.rating === 'Pleasant' || r?.rating === 'Generally pleasant';

/** Month runs (wrapping December → January) where `pick` holds, as "Dec–Mar" or "May". */
function runs(ratings: (MonthRating | null)[], pick: (r: MonthRating | null) => boolean): string[] {
  const on = ratings.map(pick);
  if (on.every(Boolean)) return ['All year'];
  if (!on.some(Boolean)) return [];
  // Start just after an "off" month, so a run across the new year stays whole.
  const start = (on.findIndex((x) => !x) + 1) % 12;
  const out: string[] = [];
  let first = -1;
  for (let k = 0; k <= 12; k++) {
    const i = (start + k) % 12;
    if (k < 12 && on[i]) {
      if (first < 0) first = i;
    } else if (first >= 0) {
      const last = (i + 11) % 12;
      out.push(first === last ? MON[first] : `${MON[first]}–${MON[last]}`);
      first = -1;
    }
  }
  return out;
}

/** "Best Dec–Mar": Pleasant months, else Generally pleasant ones, else null (no standout month). */
export function bestMonthsLabel(ratings: (MonthRating | null)[]): string | null {
  const best = runs(ratings, (r) => r?.rating === 'Pleasant');
  const pick = best.length ? best : runs(ratings, (r) => r?.rating === 'Generally pleasant');
  return pick.length ? pick.slice(0, 2).join(', ') : null;
}

/** The next good (either shade of green) month from `month` (1–12): 'now', a month name, or null. */
export function nextGoodMonth(ratings: (MonthRating | null)[], month: number): 'now' | string | null {
  for (let k = 0; k < 12; k++) {
    const i = (month - 1 + k) % 12;
    if (isGreen(ratings[i])) return k === 0 ? 'now' : MON[i];
  }
  return null;
}

/** Whether a month (1–12) is typically good (either shade of green). */
export const goodIn = (ratings: (MonthRating | null)[] | undefined, month: number) => Boolean(ratings && isGreen(ratings[month - 1]));
