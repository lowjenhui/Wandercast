// ENSO (El Niño–Southern Oscillation) helpers on the NOAA Oceanic Niño Index (ONI).
//
// ONI is a 3-month running mean of Niño-3.4 sea-surface temperature anomalies. ±0.5 °C marks
// El Niño / La Niña. For a future trip we assume the latest phase persists (persistence
// forecast), and fade that assumption out as the lead time grows, because ENSO can flip
// within a few seasons (especially across the northern spring).

import { parseISODate } from './dates';

export interface OniPoint {
  year: number;
  season: string;
  anom: number;
}

export type EnsoPhase = 'El Niño' | 'La Niña' | 'Neutral';

/** Each 3-letter season mapped to its centre month (DJF → Jan, …, NDJ → Dec). */
const SEASON_CENTRE: Record<string, number> = {
  DJF: 1, JFM: 2, FMA: 3, MAM: 4, AMJ: 5, MJJ: 6, JJA: 7, JAS: 8, ASO: 9, SON: 10, OND: 11, NDJ: 12,
};

export const ENSO_THRESHOLD = 0.5;

export function phaseOf(anom: number): EnsoPhase {
  return anom >= ENSO_THRESHOLD ? 'El Niño' : anom <= -ENSO_THRESHOLD ? 'La Niña' : 'Neutral';
}

export function strengthOf(anom: number): 'weak' | 'moderate' | 'strong' | 'very strong' | null {
  const a = Math.abs(anom);
  return a < ENSO_THRESHOLD ? null : a < 1 ? 'weak' : a < 1.5 ? 'moderate' : a < 2 ? 'strong' : 'very strong';
}

export class OniSeries {
  private byKey = new Map<string, number>();
  readonly latest: { year: number; month: number; season: string; anom: number } | null = null;

  constructor(points: OniPoint[]) {
    let best: { year: number; month: number; season: string; anom: number } | null = null;
    for (const p of points) {
      const month = SEASON_CENTRE[p.season];
      if (!month) continue;
      this.byKey.set(`${p.year}-${month}`, p.anom);
      if (!best || p.year * 12 + month > best.year * 12 + best.month) best = { year: p.year, month, season: p.season, anom: p.anom };
    }
    this.latest = best;
  }

  /** ONI for the 3-month season centred on (year, month 1–12), if published. */
  at(year: number, month: number): number | null {
    return this.byKey.get(`${year}-${month}`) ?? null;
  }

  get size(): number {
    return this.byKey.size;
  }
}

export interface EnsoOutlook {
  latest: { year: number; month: number; season: string; anom: number; phase: EnsoPhase; strength: ReturnType<typeof strengthOf> };
  /** Phase assumed for the trip (persistence of the latest reading). */
  tripPhase: EnsoPhase;
  tripAnom: number;
  /** Months from the latest ONI season to the trip's middle month. */
  leadMonths: number;
  /** 0–1: how much the ENSO phase is allowed to re-weight analog years. */
  influence: number;
  note: string;
}

/** Persistence outlook for a trip centred on `tripMid` (YYYY-MM-DD). */
export function ensoOutlook(series: OniSeries, tripMid: string): EnsoOutlook | null {
  const l = series.latest;
  if (!l) return null;
  const d = parseISODate(tripMid);
  const ty = d.getUTCFullYear();
  const tm = d.getUTCMonth() + 1;
  const lead = ty * 12 + tm - (l.year * 12 + l.month);
  // A trip whose season is already published uses the observed value.
  const observed = lead <= 0 ? series.at(ty, tm) : null;
  const anom = observed ?? l.anom;
  const influence = lead <= 4 ? 1 : lead <= 7 ? 0.5 : 0;
  const latest = { ...l, phase: phaseOf(l.anom), strength: strengthOf(l.anom) };
  const tripPhase = phaseOf(anom);
  const latestLabel = `${latest.strength ? `${latest.strength} ` : ''}${latest.phase}`;
  const note =
    observed !== null
      ? `Observed ENSO state for your dates: ${tripPhase} (ONI ${anom.toFixed(1)}).`
      : influence === 0
        ? `ENSO is currently ${latestLabel} (ONI ${l.anom.toFixed(1)}, ${l.season} ${l.year}), but your trip is ${lead} months later, too far ahead to assume it will persist, so all years count equally.`
        : `ENSO is currently ${latestLabel} (ONI ${l.anom.toFixed(1)}, ${l.season} ${l.year}). Assuming it persists ${lead} month${lead === 1 ? '' : 's'} to your trip${influence < 1 ? ' (weighted at half strength, as ENSO can change in that time)' : ''}, past ${tripPhase === 'Neutral' ? 'neutral' : tripPhase} years count more.`;
  return { latest, tripPhase, tripAnom: anom, leadMonths: lead, influence, note };
}

/**
 * Weight multiplier for an analog year with ONI `anom`, given the outlook. Same phase counts
 * 3×, opposite phase 0.3×, and anything in between 1×, all scaled toward 1 by `influence`.
 */
export function ensoWeight(anom: number | null, outlook: EnsoOutlook | null): number {
  if (!outlook || anom === null || outlook.influence === 0) return 1;
  const a = phaseOf(anom);
  const t = outlook.tripPhase;
  const raw = a === t ? (t === 'Neutral' ? 2 : 3) : a === 'Neutral' || t === 'Neutral' ? 1 : 0.3;
  return 1 + (raw - 1) * outlook.influence;
}
