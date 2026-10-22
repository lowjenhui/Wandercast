// Sunny windows ("When to go"): the reverse search. For one place and a trip length, every start date over the
// next 12 months is scored with the same suitability score as the trip analysis.
//
// For each start date, the same calendar dates in each of the last 10 years (whose trip has
// reached the ERA5 archive) are slid ±`pad` days, giving ~70 sample trips. Samples are weighted
// by recency (half-life 12 years), closeness to the exact dates and, for trips within 7 months,
// ENSO phase (the same persistence rule as the trip odds). Window statistics come from prefix
// sums, so a whole year of start dates costs a few thousand O(1) lookups.

import type { DailyWeather, SeasonalRisk } from '../types';
import { addDays, daysBetween, monthsInRange, parseISODate, shiftYears, todayISO } from './dates';
import { ensoOutlook, ensoWeight, type EnsoOutlook, type OniSeries } from './enso';
import { dryMaxWetDays, HALF_LIFE_YEARS } from './tripOdds';
import { HEAVY_RAIN_MM, scoreSuitability, WET_DAY_MM, type Suitability, type SuitabilityRating } from './weatherAnalysis';

export const BEST_YEARS = 10;
export const BEST_PAD_DAYS = 3;
export const HORIZON_DAYS = 365;
/** Best windows must start at least this many days apart, so they aren't near-duplicates. */
export const MIN_GAP_DAYS = 14;
/** Best and worst scores this close together count as "about the same all year". */
export const FLAT_SPREAD = 6;
export const MIN_TRIP_DAYS = 2;
export const MAX_TRIP_DAYS = 30;
/** A start date needs at least this many years with data to be scored. */
const MIN_YEARS = 3;

/** Weekend trips: which day they start and how long they are. */
export type WeekendKind = 'sat-sun' | 'fri-sun' | 'fri-mon';
export const WEEKENDS: Record<WeekendKind, { startDow: number; days: number; label: string; nights: string }> = {
  'sat-sun': { startDow: 6, days: 2, label: 'Sat–Sun', nights: '2D1N' },
  'fri-sun': { startDow: 5, days: 3, label: 'Fri–Sun', nights: '3D2N' },
  'fri-mon': { startDow: 5, days: 4, label: 'Fri–Mon', nights: '4D3N' },
};
/** Places this close (hours of travel) open Sunny windows in weekend mode. */
export const WEEKEND_DEFAULT_MAX_HOURS = 3;

export interface WindowScore {
  start: string;
  end: string;
  score: number;
  rating: SuitabilityRating;
  suitability: Suitability;
  /** Expected wet days over the trip. */
  wetDays: number;
  /** Chance the trip is mostly dry (at most ~1 day in 5 wet). */
  pMostlyDry: number;
  tMax: number | null;
  tMin: number | null;
  rh: number | null;
  years: number;
  risks: SeasonalRisk[];
}

export interface AvoidStretch {
  /** First and last trip start dates in the stretch. */
  from: string;
  to: string;
  meanScore: number;
  reason: string;
}

export interface BestTimeResult {
  tripDays: number;
  horizonStart: string;
  /** Weekend mode (only Friday or Saturday starts), or null for any day. */
  weekend: WeekendKind | null;
  /** The start date of each column: every day from `horizonStart`, or each weekend. */
  starts: string[];
  /** One entry per column in `starts`; null when there isn't enough data. */
  days: (WindowScore | null)[];
  best: WindowScore[];
  avoid: AvoidStretch | null;
  /** Little seasonal difference: no winners are named. */
  flat: boolean;
  flatLabel: string | null;
  spread: number;
  firstYear: number | null;
  lastYear: number | null;
  /** Fewest years behind any scored start date. */
  minYears: number;
  /** Note about ENSO weighting, when it changed anything. */
  ensoNote: string | null;
}

export interface BestTimeOptions {
  tripDays: number;
  /** Score only weekend trips of this kind (its length replaces `tripDays`). */
  weekend?: WeekendKind | null;
  /** Seasonal risks for the months a trip touches (curated reference). */
  risksFor: (months: number[]) => SeasonalRisk[];
  oni?: OniSeries | null;
  today?: string;
  horizonDays?: number;
  years?: number;
  pad?: number;
  halfLifeYears?: number;
}

/** Inclusive date range of history the search reads, for a given day. */
export function bestTimeFetchRange(today = todayISO(), years = BEST_YEARS): { start: string; end: string } {
  // The oldest sample is a trip starting about a year from now, `years + 1` years back (its
  // most recent year isn't archived yet): about `years` years ago, less the longest trip and slide.
  return { start: addDays(shiftYears(today, -years), -(MAX_TRIP_DAYS + BEST_PAD_DAYS + 7)), end: addDays(today, -6) };
}

/** Prefix sums over a contiguous day grid, so any window's totals are O(1). */
class DayGrid {
  readonly first: string;
  readonly n: number;
  private sums: Float64Array[];

  constructor(daily: DailyWeather[]) {
    const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));
    this.first = sorted[0]?.date ?? '1970-01-01';
    this.n = sorted.length ? daysBetween(this.first, sorted[sorted.length - 1].date) + 1 : 0;
    // valid, wet, heavy, tmaxSum, tmaxN, tminSum, tminN, rhSum, rhN
    this.sums = Array.from({ length: 9 }, () => new Float64Array(this.n + 1));
    const row = Array.from({ length: 9 }, () => new Float64Array(this.n));
    for (const d of sorted) {
      const i = daysBetween(this.first, d.date);
      if (d.precipMm !== null) {
        row[0][i] = 1;
        row[1][i] = d.precipMm >= WET_DAY_MM ? 1 : 0;
        row[2][i] = d.precipMm >= HEAVY_RAIN_MM ? 1 : 0;
      }
      if (d.tMaxC !== null) (row[3][i] = d.tMaxC), (row[4][i] = 1);
      if (d.tMinC !== null) (row[5][i] = d.tMinC), (row[6][i] = 1);
      if (d.rhMeanPct !== null) (row[7][i] = d.rhMeanPct), (row[8][i] = 1);
    }
    for (let k = 0; k < 9; k++) for (let i = 0; i < this.n; i++) this.sums[k][i + 1] = this.sums[k][i] + row[k][i];
  }

  /** Totals for `len` days from `start`, or null when the window falls outside the grid. */
  window(start: string, len: number): number[] | null {
    const i = daysBetween(this.first, start);
    if (i < 0 || i + len > this.n) return null;
    return this.sums.map((s) => s[i + len] - s[i]);
  }
}

interface Acc {
  w: number;
  wet: number;
  heavyPerWeek: number;
  dry: number;
  tMax: [number, number];
  tMin: [number, number];
  rh: [number, number];
  years: Set<number>;
}

export function bestTimes(daily: DailyWeather[], opts: BestTimeOptions): BestTimeResult {
  const today = opts.today ?? todayISO();
  const weekend = opts.weekend ?? null;
  const tripDays = weekend ? WEEKENDS[weekend].days : Math.min(MAX_TRIP_DAYS, Math.max(MIN_TRIP_DAYS, Math.round(opts.tripDays)));
  const horizon = opts.horizonDays ?? HORIZON_DAYS;
  const nYears = opts.years ?? BEST_YEARS;
  const pad = opts.pad ?? BEST_PAD_DAYS;
  const halfLife = opts.halfLifeYears ?? HALF_LIFE_YEARS;
  const cutoff = addDays(today, -6);
  const grid = new DayGrid(daily);
  const dryMax = dryMaxWetDays(tripDays);

  const riskCache = new Map<string, SeasonalRisk[]>();
  const outlookCache = new Map<string, EnsoOutlook | null>();
  let ensoUsed: EnsoOutlook | null = null;
  const allYears = new Set<number>();

  const days: (WindowScore | null)[] = [];
  const starts: string[] = [];
  for (let h = 0; h < horizon; h++) {
    const start = addDays(today, h);
    if (weekend && parseISODate(start).getUTCDay() !== WEEKENDS[weekend].startDow) continue;
    starts.push(start);
    const end = addDays(start, tripDays - 1);
    const mid = addDays(start, Math.floor((tripDays - 1) / 2));
    const midMonth = Number(mid.slice(5, 7));
    const midKey = mid.slice(0, 7);
    if (opts.oni && !outlookCache.has(midKey)) outlookCache.set(midKey, ensoOutlook(opts.oni, mid));
    const outlook = outlookCache.get(midKey) ?? null;

    const acc: Acc = { w: 0, wet: 0, heavyPerWeek: 0, dry: 0, tMax: [0, 0], tMin: [0, 0], rh: [0, 0], years: new Set() };
    let used = 0;
    for (let k = 1; used < nYears && k <= nYears + 2; k++) {
      const s = shiftYears(start, -k);
      if (addDays(s, tripDays - 1 + pad) > cutoff) continue; // that year's trip isn't archived yet
      const anom = opts.oni?.at(Number(shiftYears(mid, -k).slice(0, 4)), midMonth) ?? null;
      const ew = ensoWeight(anom, outlook);
      if (ew !== 1) ensoUsed ??= outlook;
      const base = 0.5 ** (used / halfLife) * ew;
      used++;
      for (let o = -pad; o <= pad; o++) {
        const t = grid.window(addDays(s, o), tripDays);
        if (!t || t[0] < Math.ceil(tripDays * 0.8)) continue;
        const [valid, wet, heavy, txs, txn, tns, tnn, rhs, rhn] = t;
        const w = base * (1 - Math.abs(o) / (pad + 1));
        const wetShare = wet / valid;
        acc.w += w;
        acc.wet += w * wetShare;
        acc.heavyPerWeek += w * (heavy / valid) * 7;
        acc.dry += wetShare * tripDays <= dryMax + 1e-9 ? w : 0;
        if (txn) (acc.tMax[0] += w * (txs / txn)), (acc.tMax[1] += w);
        if (tnn) (acc.tMin[0] += w * (tns / tnn)), (acc.tMin[1] += w);
        if (rhn) (acc.rh[0] += w * (rhs / rhn)), (acc.rh[1] += w);
        acc.years.add(Number(s.slice(0, 4)));
      }
    }
    if (acc.years.size < MIN_YEARS || !acc.tMax[1] || !acc.tMin[1]) {
      days.push(null);
      continue;
    }
    acc.years.forEach((y) => allYears.add(y));
    const months = monthsInRange(start, end);
    const key = months.join(',');
    if (!riskCache.has(key)) riskCache.set(key, opts.risksFor(months));
    const risks = riskCache.get(key)!;
    const wetShare = acc.wet / acc.w;
    const tMax = acc.tMax[0] / acc.tMax[1];
    const tMin = acc.tMin[0] / acc.tMin[1];
    const rh = acc.rh[1] ? acc.rh[0] / acc.rh[1] : null;
    const suitability = scoreSuitability({ wetShare, heavyPerWeek: acc.heavyPerWeek / acc.w, tMax, tMin, rh }, risks);
    days.push({
      start,
      end,
      score: suitability.score,
      rating: suitability.rating,
      suitability,
      wetDays: wetShare * tripDays,
      pMostlyDry: acc.dry / acc.w,
      tMax,
      tMin,
      rh,
      years: acc.years.size,
      risks,
    });
  }

  const scored = days.filter((d): d is WindowScore => d !== null);
  const max = scored.length ? Math.max(...scored.map((d) => d.score)) : 0;
  const min = scored.length ? Math.min(...scored.map((d) => d.score)) : 0;
  const spread = max - min;
  const flat = scored.length > 0 && spread < FLAT_SPREAD;
  const flatLabel = !flat ? null : min >= 60 ? 'Good most of the year' : max < 45 ? 'Challenging most of the year' : 'Little difference through the year';
  const years = [...allYears];

  return {
    tripDays,
    horizonStart: today,
    weekend,
    starts,
    days,
    best: flat ? [] : pickBest(scored, 3),
    avoid: flat ? null : findAvoid(days, max),
    flat,
    flatLabel,
    spread,
    firstYear: years.length ? Math.min(...years) : null,
    lastYear: years.length ? Math.max(...years) : null,
    minYears: scored.length ? Math.min(...scored.map((d) => d.years)) : 0,
    ensoNote: ensoUsed
      ? `ENSO is currently ${ensoUsed.latest.phase} (ONI ${ensoUsed.latest.anom.toFixed(1)}). For trips in the next 7 months, past years in the same phase count more; later trips weigh all years equally.`
      : null,
  };
}

/** Highest scores first (ties: drier, then sooner), at least MIN_GAP_DAYS apart. */
export function pickBest(scored: WindowScore[], n: number): WindowScore[] {
  const ranked = [...scored].sort((a, b) => b.score - a.score || b.pMostlyDry - a.pMostlyDry || (a.start < b.start ? -1 : 1));
  const out: WindowScore[] = [];
  for (const d of ranked) {
    if (out.length >= n) break;
    if (out.every((p) => Math.abs(daysBetween(p.start, d.start)) >= MIN_GAP_DAYS)) out.push(d);
  }
  return out;
}

/**
 * The worst stretch: start dates around the lowest score that stay within the bottom 30% of
 * this place's range and below "Generally pleasant". Only reported when it is clearly worse
 * (at least 10 points) than the best.
 */
export function findAvoid(days: (WindowScore | null)[], max: number): AvoidStretch | null {
  let worst = -1;
  days.forEach((d, i) => {
    if (d && (worst < 0 || d.score < days[worst]!.score)) worst = i;
  });
  if (worst < 0) return null;
  const w = days[worst]!;
  if (w.score >= 60 || max - w.score < 10) return null;
  const limit = Math.min(59, w.score + 0.3 * (max - w.score));
  const bad = (i: number) => days[i] !== null && days[i]!.score <= limit;
  let a = worst;
  let b = worst;
  while (a > 0 && bad(a - 1)) a--;
  while (b < days.length - 1 && bad(b + 1)) b++;
  const run = days.slice(a, b + 1) as WindowScore[];
  const meanScore = run.reduce((s, d) => s + d.score, 0) / run.length;
  const riskTitles = [...new Set(run.flatMap((d) => d.risks.filter((r) => r.severity !== 'info').map((r) => r.title)))];
  const weakest = w.suitability.components.filter((c) => c.key !== 'risk').sort((x, y) => x.score - y.score)[0];
  const reason = [riskTitles.slice(0, 2).join('; '), weakest?.note].filter(Boolean).join(' · ');
  return { from: run[0].start, to: run[run.length - 1].start, meanScore, reason };
}

export interface MonthNormal {
  month: number;
  /** Average monthly rainfall total, mm. */
  rainMm: number | null;
  wetDays: number | null;
  tMax: number | null;
  tMin: number | null;
  /** Mean relative humidity, %. */
  rh: number | null;
  /** Mean feels-like (apparent) high, when the history has it. */
  feelsMax: number | null;
}

/** Average rainfall, wet days, highs, lows, humidity and feels-like highs for each calendar month, from complete months only. */
export function monthlyNormals(daily: DailyWeather[]): MonthNormal[] {
  const byMonth = new Map<string, DailyWeather[]>();
  for (const d of daily) {
    const k = d.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k)!.push(d);
  }
  const acc = Array.from({ length: 12 }, () => ({ rain: [] as number[], wet: [] as number[], tMax: [] as number[], tMin: [] as number[], rh: [] as number[], feels: [] as number[] }));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  for (const [k, days] of byMonth) {
    const [y, m] = k.split('-').map(Number);
    const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const p = days.map((d) => d.precipMm).filter((v): v is number => v !== null);
    if (p.length < inMonth * 0.9) continue; // incomplete month
    const a = acc[m - 1];
    a.rain.push((p.reduce((s, v) => s + v, 0) / p.length) * inMonth);
    a.wet.push((p.filter((v) => v >= WET_DAY_MM).length / p.length) * inMonth);
    const tx = avg(days.map((d) => d.tMaxC).filter((v): v is number => v !== null));
    const tn = avg(days.map((d) => d.tMinC).filter((v): v is number => v !== null));
    const rh = avg(days.map((d) => d.rhMeanPct).filter((v): v is number => v !== null));
    const feels = days.map((d) => d.feelsMaxC).filter((v): v is number => v != null);
    if (tx !== null) a.tMax.push(tx);
    if (tn !== null) a.tMin.push(tn);
    if (rh !== null) a.rh.push(rh);
    // Feels-like only counts for months where most days have it (older stored days may not).
    if (feels.length >= inMonth * 0.9) a.feels.push(avg(feels)!);
  }
  return acc.map((a, i) => ({ month: i + 1, rainMm: avg(a.rain), wetDays: avg(a.wet), tMax: avg(a.tMax), tMin: avg(a.tMin), rh: avg(a.rh), feelsMax: avg(a.feels) }));
}
