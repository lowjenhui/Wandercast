// Rainfall in the weeks around the trip: a centred window of at least 30 days, built from the
// same historical years as the trip analysis, so travellers can see whether nearby dates are
// usually wetter or drier.

import type { DailyWeather } from '../types';
import { addDays, daysBetween, formatShortDate, type YearWindow } from './dates';
import { mean, notNull } from './stats';
import { WET_DAY_MM } from './weatherAnalysis';

export const MIN_CONTEXT_DAYS = 30;
export const MIN_PAD_DAYS = 3;

export interface ContextWindow {
  start: string;
  end: string;
  before: number;
  after: number;
  tripDays: number;
  totalDays: number;
}

/** Pads the trip equally on both sides so the window is ≥30 days (and ≥3 days each side). */
export function contextWindow(tripStart: string, tripEnd: string): ContextWindow {
  const tripDays = daysBetween(tripStart, tripEnd) + 1;
  const pad = Math.max(MIN_CONTEXT_DAYS - tripDays, 2 * MIN_PAD_DAYS);
  const before = Math.ceil(pad / 2);
  const after = Math.floor(pad / 2);
  return { start: addDays(tripStart, -before), end: addDays(tripEnd, after), before, after, tripDays, totalDays: tripDays + before + after };
}

export interface ContextDay {
  /** Calendar date in the trip's year (for labels). */
  date: string;
  segment: 'before' | 'trip' | 'after';
  wetPct: number | null;
  meanMm: number | null;
  years: number;
}

export interface SegmentStats {
  days: number;
  wetShare: number | null;
  meanMm: number | null;
}

export interface RainContext {
  window: ContextWindow;
  days: ContextDay[];
  before: SegmentStats;
  trip: SegmentStats;
  after: SegmentStats;
  /** Driest trip-length stretch within the window, if clearly drier than the trip itself. */
  drierAlternative: { start: string; end: string; wetShare: number; reductionPts: number } | null;
  summary: string[];
  years: number;
}

function segmentStats(days: ContextDay[]): SegmentStats {
  const withData = days.filter((d) => d.wetPct !== null);
  return {
    days: days.length,
    wetShare: withData.length ? mean(withData.map((d) => d.wetPct! / 100)) : null,
    meanMm: withData.length ? mean(withData.map((d) => d.meanMm!)) : null,
  };
}

export function analyseRainContext(daily: DailyWeather[], windows: YearWindow[], tripStart: string, tripEnd: string): RainContext {
  const w = contextWindow(tripStart, tripEnd);
  const precip = new Map(daily.map((d) => [d.date, d.precipMm]));

  const days: ContextDay[] = Array.from({ length: w.totalDays }, (_, i) => {
    const vals = windows.map((yw) => precip.get(addDays(addDays(yw.start, -w.before), i))).filter(notNull);
    return {
      date: addDays(w.start, i),
      segment: i < w.before ? 'before' : i < w.before + w.tripDays ? 'trip' : 'after',
      wetPct: vals.length ? Math.round((vals.filter((v) => v >= WET_DAY_MM).length / vals.length) * 100) : null,
      meanMm: vals.length ? mean(vals) : null,
      years: vals.length,
    };
  });

  const before = segmentStats(days.filter((d) => d.segment === 'before'));
  const trip = segmentStats(days.filter((d) => d.segment === 'trip'));
  const after = segmentStats(days.filter((d) => d.segment === 'after'));

  // Slide a trip-length window across the context range and find the driest stretch.
  let best: { i: number; share: number } | null = null;
  for (let i = 0; i + w.tripDays <= days.length; i++) {
    const slice = days.slice(i, i + w.tripDays).filter((d) => d.wetPct !== null);
    if (slice.length < w.tripDays * 0.8) continue;
    const share = mean(slice.map((d) => d.wetPct! / 100))!;
    if (!best || share < best.share) best = { i, share };
  }
  const drierAlternative =
    best && trip.wetShare !== null && best.i !== w.before && trip.wetShare - best.share >= 0.1
      ? {
          start: days[best.i].date,
          end: days[best.i + w.tripDays - 1].date,
          wetShare: best.share,
          reductionPts: Math.round((trip.wetShare - best.share) * 100),
        }
      : null;

  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const compare = (a: number | null, b: number | null) => {
    if (a === null || b === null) return 'about the same';
    const d = Math.round((a - b) * 100);
    return Math.abs(d) < 5 ? 'about as wet as' : d > 0 ? `wetter than` : `drier than`;
  };
  const summary: string[] = [];
  if (trip.wetShare !== null) {
    summary.push(
      `During your dates, ${pct(trip.wetShare)} of days are typically wet, vs ${pct(before.wetShare)} in the ${w.before} days before and ${pct(after.wetShare)} in the ${w.after} days after.`,
    );
    summary.push(`Your dates are ${compare(trip.wetShare, before.wetShare)} the days before and ${compare(trip.wetShare, after.wetShare)} the days after.`);
  }
  if (drierAlternative) {
    summary.push(`A drier stretch is nearby: ${formatShortDate(drierAlternative.start)} – ${formatShortDate(drierAlternative.end)} has typically ${drierAlternative.reductionPts} percentage points fewer wet days.`);
  }

  return { window: w, days, before, trip, after, drierAlternative, summary, years: Math.max(0, ...days.map((d) => d.years)) };
}
