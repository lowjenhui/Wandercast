import { RISK_ENTRIES, type RiskEntry } from '../data/seasonalRisks';
import type { Place, SeasonalRisk } from '../types';

export interface SeasonalRiskService {
  risksFor(place: Place, tripMonths: number[]): SeasonalRisk[];
}

function inBox(entry: RiskEntry, lat: number, lon: number): boolean {
  if (!entry.box) return true;
  const [latMin, latMax, lonMin, lonMax] = entry.box;
  return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
}

const ORDER = { high: 0, moderate: 1, info: 2 } as const;

export const curatedSeasonalRisks: SeasonalRiskService = {
  risksFor(place, tripMonths) {
    return RISK_ENTRIES.filter(
      (e) =>
        e.countries.includes(place.countryCode) &&
        inBox(e, place.latitude, place.longitude) &&
        e.months.some((m) => tripMonths.includes(m)),
    )
      .map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        severity: e.severity,
        inPeak: Boolean(e.peakMonths?.some((m) => tripMonths.includes(m))),
        source: e.source,
        basis: 'reference' as const,
      }))
      .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || Number(b.inPeak) - Number(a.inPeak));
  },
};

/** Every curated risk for a place over the whole year, with the months it covers (Sunny windows). */
export function risksThroughYear(place: Place): (SeasonalRisk & { months: number[]; peakMonths: number[] })[] {
  return RISK_ENTRIES.filter((e) => e.countries.includes(place.countryCode) && inBox(e, place.latitude, place.longitude))
    .map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      severity: e.severity,
      inPeak: false,
      source: e.source,
      basis: 'reference' as const,
      months: e.months,
      peakMonths: e.peakMonths ?? [],
    }))
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.months[0] - b.months[0]);
}
