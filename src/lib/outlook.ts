// Rating trip-date outlooks and ranking destination suggestions.

import type { TripOutlook } from '../services/tripOutlook';
import type { SeasonalRisk } from '../types';
import type { ConditionClass } from './currentConditions';
import { haversineKm, SIN_AIRPORT } from './geo';
import { scoreSuitability, type Suitability, type SuitabilityRating } from './weatherAnalysis';

export { SIN_AIRPORT };

/**
 * Rough direct-flight time from Changi: great-circle distance at ~800 km/h cruise
 * plus ~30 min for taxi, climb and descent, rounded to the nearest half hour.
 * Real itineraries (routing, connections) can be much longer.
 */
export function estimateFlightHours(lat: number, lon: number): number {
  const km = haversineKm(SIN_AIRPORT.lat, SIN_AIRPORT.lon, lat, lon);
  return Math.max(1, Math.round((km / 800 + 0.5) * 2) / 2);
}

export function formatHours(h: number): string {
  const whole = Math.floor(h);
  return h % 1 ? `${whole}h 30m` : `${whole}h`;
}

export const RATING_CLASS: Record<SuitabilityRating, ConditionClass> = {
  Pleasant: 'good',
  'Generally pleasant': 'good',
  Mixed: 'average',
  Challenging: 'bad',
};

/** Same scoring as the full trip analysis, applied to a forecast or typical-weather outlook. */
export function rateOutlook(o: TripOutlook, risks: SeasonalRisk[]): Suitability {
  return scoreSuitability(
    {
      wetShare: o.wetDays / o.tripDays,
      heavyPerWeek: (o.heavyDays / o.tripDays) * 7,
      tMax: o.tMaxC,
      tMin: o.tMinC,
      rh: o.rhPct,
    },
    risks,
  );
}

export type SortMode = 'balanced' | 'weather' | 'flight';

export interface Candidate<D> {
  dest: D;
  hours: number;
  suitability: Suitability | null;
}

/** Balanced: weather score minus 3 points per flight hour beyond two hours. */
export function rankScore(c: Candidate<unknown>, mode: SortMode): number {
  const s = c.suitability?.score ?? -Infinity;
  if (mode === 'weather') return s;
  if (mode === 'flight') return -c.hours;
  return s - 3 * Math.max(0, c.hours - 2);
}

export function rankCandidates<D>(items: Candidate<D>[], mode: SortMode, maxHours: number | null): Candidate<D>[] {
  return items
    .filter((c) => maxHours === null || c.hours <= maxHours)
    .sort((a, b) => {
      // Places still loading go last, except when sorting purely by flight time.
      if (mode !== 'flight' && !a.suitability !== !b.suitability) return a.suitability ? -1 : 1;
      return rankScore(b, mode) - rankScore(a, mode) || a.hours - b.hours;
    });
}
