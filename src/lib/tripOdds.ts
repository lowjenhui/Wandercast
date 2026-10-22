// Trip odds: probabilities from many "sample trips" instead of one average.
//
// For each past year (up to ~25) the trip is slid ±`pad` days around the same calendar dates,
// giving many plausible trips of the same length. Each sample trip is weighted by
//   recency   (half-life in years: recent climate counts more),
//   day offset (closer to your exact dates counts more), and
//   ENSO      (years in the same El Niño / La Niña phase as expected for your trip count more).
// Odds are weighted shares of sample trips; ranges are weighted quantiles.

import type { DailyWeather } from '../types';
import { addDays, daysBetween, ERA5_SETTLED_DAYS, shiftYears, todayISO } from './dates';
import { ensoWeight, phaseOf, type EnsoOutlook, type EnsoPhase, type OniSeries } from './enso';
import { notNull } from './stats';
import { HEAVY_RAIN_MM, HOT_DAY_C, WET_DAY_MM } from './weatherAnalysis';

export interface OddsOptions {
  years?: number;
  pad?: number;
  halfLifeYears?: number;
  oni?: OniSeries | null;
  enso?: EnsoOutlook | null;
  today?: string;
}

export const ODDS_YEARS = 25;
export const ODDS_PAD_DAYS = 7;
export const HALF_LIFE_YEARS = 12;

interface Sample {
  year: number;
  weight: number;
  days: number;
  wetDays: number;
  rainMm: number;
  heavyDays: number;
  hotDays: number;
  tMax: number | null;
  tMin: number | null;
  rh: number | null;
  anom: number | null;
}

export interface Quartiles {
  p25: number;
  p50: number;
  p75: number;
}

export interface EnsoSignal {
  phase: EnsoPhase;
  years: number;
  wetShareSame: number;
  wetShareAll: number;
  rainSame: number;
  rainAll: number;
  /** Plain-language verdict about how much ENSO matters here, from this place's own record. */
  verdict: 'wetter' | 'drier' | 'little difference';
}

export interface TripOdds {
  tripDays: number;
  pad: number;
  halfLifeYears: number;
  samples: number;
  years: number;
  firstYear: number;
  lastYear: number;
  /** Kish effective number of years after weighting. */
  effectiveYears: number;
  ensoApplied: boolean;
  /** Most wet days that still count as a "mostly dry" trip. */
  dryMaxWetDays: number;
  pMostlyDry: number;
  pWashout: number;
  pRainMostDays: number;
  pHotDay: number;
  wetDays: Quartiles;
  rainMm: Quartiles;
  meanWetShare: number;
  meanHeavyPerWeek: number;
  meanTMax: number | null;
  meanTMin: number | null;
  meanRh: number | null;
  ensoSignal: EnsoSignal | null;
}

/** Most wet days a trip can have and still count as mostly dry (about 1 day in 5). */
export const dryMaxWetDays = (tripDays: number) => Math.max(1, Math.round(tripDays * 0.2));

/** Calendar windows the odds need, newest year first: the trip ±pad in each past year. */
export function oddsWindows(start: string, end: string, opts: OddsOptions = {}): { year: number; start: string; end: string }[] {
  const years = opts.years ?? ODDS_YEARS;
  const pad = opts.pad ?? ODDS_PAD_DAYS;
  const cutoff = addDays(opts.today ?? todayISO(), -ERA5_SETTLED_DAYS);
  const out: { year: number; start: string; end: string }[] = [];
  for (let k = 1; out.length < years && k <= years + 2; k++) {
    const s = shiftYears(start, -k);
    if (shiftYears(end, -k) > cutoff) continue; // that year's trip isn't in the archive yet
    const e = addDays(shiftYears(end, -k), pad);
    out.push({ year: Number(s.slice(0, 4)), start: addDays(s, -pad), end: e < cutoff ? e : cutoff });
  }
  return out;
}

function wQuantile(xs: { v: number; w: number }[], q: number): number {
  const s = [...xs].sort((a, b) => a.v - b.v);
  const total = s.reduce((a, x) => a + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= q * total) return x.v;
  }
  return s[s.length - 1].v;
}

function wMean(xs: { v: number | null; w: number }[]): number | null {
  let sw = 0;
  let sv = 0;
  for (const x of xs) if (x.v !== null) (sw += x.w), (sv += x.v * x.w);
  return sw ? sv / sw : null;
}

export function computeOdds(daily: DailyWeather[], tripStart: string, tripEnd: string, opts: OddsOptions = {}): TripOdds | null {
  const tripDays = daysBetween(tripStart, tripEnd) + 1;
  const pad = opts.pad ?? ODDS_PAD_DAYS;
  const halfLife = opts.halfLifeYears ?? HALF_LIFE_YEARS;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const mid = addDays(tripStart, Math.floor((tripDays - 1) / 2));
  const midMonth = Number(mid.slice(5, 7));
  const windows = oddsWindows(tripStart, tripEnd, opts);
  const samples: Sample[] = [];

  windows.forEach((win, k) => {
    const yearShift = Number(tripStart.slice(0, 4)) - win.year;
    const midYear = Number(shiftYears(mid, -yearShift).slice(0, 4));
    const anom = opts.oni?.at(midYear, midMonth) ?? null;
    const base = 0.5 ** (k / halfLife) * ensoWeight(anom, opts.enso ?? null);
    for (let o = -pad; o <= pad; o++) {
      const s = addDays(shiftYears(tripStart, -yearShift), o);
      const days: DailyWeather[] = [];
      for (let i = 0; i < tripDays; i++) {
        const d = byDate.get(addDays(s, i));
        if (d && d.precipMm !== null) days.push(d);
      }
      if (days.length < Math.ceil(tripDays * 0.8)) continue;
      const p = days.map((d) => d.precipMm!);
      const scale = tripDays / days.length;
      const tmax = days.map((d) => d.tMaxC).filter(notNull);
      const tmin = days.map((d) => d.tMinC).filter(notNull);
      const rh = days.map((d) => d.rhMeanPct).filter(notNull);
      samples.push({
        year: win.year,
        weight: base * (1 - Math.abs(o) / (pad + 1)),
        days: tripDays,
        wetDays: p.filter((x) => x >= WET_DAY_MM).length * scale,
        rainMm: p.reduce((a, b) => a + b, 0) * scale,
        heavyDays: p.filter((x) => x >= HEAVY_RAIN_MM).length,
        hotDays: tmax.filter((x) => x >= HOT_DAY_C).length,
        tMax: tmax.length ? tmax.reduce((a, b) => a + b, 0) / tmax.length : null,
        tMin: tmin.length ? tmin.reduce((a, b) => a + b, 0) / tmin.length : null,
        rh: rh.length ? rh.reduce((a, b) => a + b, 0) / rh.length : null,
        anom,
      });
    }
  });
  if (!samples.length) return null;

  const total = samples.reduce((a, s) => a + s.weight, 0);
  const share = (f: (s: Sample) => boolean) => samples.reduce((a, s) => a + (f(s) ? s.weight : 0), 0) / total;
  const perYear = new Map<number, number>();
  samples.forEach((s) => perYear.set(s.year, (perYear.get(s.year) ?? 0) + s.weight));
  const yw = [...perYear.values()];
  const effectiveYears = yw.reduce((a, b) => a + b, 0) ** 2 / yw.reduce((a, b) => a + b * b, 0);
  const yearsList = [...perYear.keys()];
  const dryMax = dryMaxWetDays(tripDays);

  // How did this place behave in past years of the phase expected now? Unweighted by ENSO,
  // so the comparison isn't circular; needs at least 3 such years.
  let ensoSignal: EnsoSignal | null = null;
  if (opts.enso && opts.oni && opts.enso.tripPhase !== 'Neutral') {
    const phase = opts.enso.tripPhase;
    const same = samples.filter((s) => s.anom !== null && phaseOf(s.anom) === phase);
    const sameYears = new Set(same.map((s) => s.year)).size;
    if (sameYears >= 3) {
      const avg = (xs: Sample[], f: (s: Sample) => number) => xs.reduce((a, s) => a + f(s), 0) / xs.length;
      const wetShareSame = avg(same, (s) => s.wetDays / s.days);
      const wetShareAll = avg(samples, (s) => s.wetDays / s.days);
      const rainSame = avg(same, (s) => s.rainMm);
      const rainAll = avg(samples, (s) => s.rainMm);
      const rel = rainAll > 5 ? (rainSame - rainAll) / rainAll : 0;
      const dShare = wetShareSame - wetShareAll;
      const verdict = rel > 0.2 || dShare > 0.08 ? 'wetter' : rel < -0.2 || dShare < -0.08 ? 'drier' : 'little difference';
      ensoSignal = { phase, years: sameYears, wetShareSame, wetShareAll, rainSame, rainAll, verdict };
    }
  }

  const ws = samples.map((s) => ({ v: s.wetDays, w: s.weight }));
  const rs = samples.map((s) => ({ v: s.rainMm, w: s.weight }));
  return {
    tripDays,
    pad,
    halfLifeYears: halfLife,
    samples: samples.length,
    years: perYear.size,
    firstYear: Math.min(...yearsList),
    lastYear: Math.max(...yearsList),
    effectiveYears,
    ensoApplied: Boolean(opts.enso && opts.enso.influence > 0 && samples.some((s) => s.anom !== null)),
    dryMaxWetDays: dryMax,
    pMostlyDry: share((s) => s.wetDays <= dryMax + 1e-9),
    pWashout: share((s) => s.heavyDays > 0),
    pRainMostDays: share((s) => s.wetDays > s.days / 2),
    pHotDay: share((s) => s.hotDays > 0),
    wetDays: { p25: wQuantile(ws, 0.25), p50: wQuantile(ws, 0.5), p75: wQuantile(ws, 0.75) },
    rainMm: { p25: wQuantile(rs, 0.25), p50: wQuantile(rs, 0.5), p75: wQuantile(rs, 0.75) },
    meanWetShare: wMean(samples.map((s) => ({ v: s.wetDays / s.days, w: s.weight })))!,
    meanHeavyPerWeek: (wMean(samples.map((s) => ({ v: s.heavyDays, w: s.weight })))! / tripDays) * 7,
    meanTMax: wMean(samples.map((s) => ({ v: s.tMax, w: s.weight }))),
    meanTMin: wMean(samples.map((s) => ({ v: s.tMin, w: s.weight }))),
    meanRh: wMean(samples.map((s) => ({ v: s.rh, w: s.weight }))),
    ensoSignal,
  };
}
