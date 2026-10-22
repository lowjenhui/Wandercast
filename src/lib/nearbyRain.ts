// "Rain around here" on the rainfall map: the places near a pinned spot to compare, and which of
// them is driest in the chosen months. Rainfall comes from the bundled grid, so no API calls.

import { haversineKm } from './geo';

export interface NearbyCandidate {
  name: string;
  lat: number;
  lon: number;
  /** Destinations (flight, ferry, overland, via) come before plain map cities. */
  dest: boolean;
}

export interface NearbyPlace extends NearbyCandidate {
  km: number;
}

/**
 * Up to `max` places within `km` of a spot: destinations nearest first, then map cities to fill,
 * leaving out a place within 15 km of one already chosen (Otaru city next to Otaru the destination).
 */
export function nearbyPlaces(candidates: NearbyCandidate[], lat: number, lon: number, km = 350, max = 8): NearbyPlace[] {
  const near = candidates
    .map((c) => ({ ...c, km: haversineKm(lat, lon, c.lat, c.lon) }))
    .filter((c) => c.km <= km)
    .sort((a, b) => Number(b.dest) - Number(a.dest) || a.km - b.km);
  const out: NearbyPlace[] = [];
  for (const c of near) {
    if (out.length >= max) break;
    if (out.some((o) => o.name === c.name || haversineKm(o.lat, o.lon, c.lat, c.lon) < 15)) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Mean rain over the chosen months from twelve monthly values. */
export const monthsMean = (year: number[], months: number[]): number => months.reduce((a, m) => a + year[m - 1], 0) / Math.max(1, months.length);

/** The driest of the rows in the chosen months, when it is clearly drier (by 20%) than the wettest. */
export function driestNearby<T extends { name: string; year: number[] }>(rows: T[], months: number[]): { name: string; mm: number } | null {
  if (rows.length < 2) return null;
  const means = rows.map((r) => ({ name: r.name, mm: monthsMean(r.year, months) })).sort((a, b) => a.mm - b.mm);
  const dry = means[0];
  const wet = means[means.length - 1];
  return wet.mm >= dry.mm * 1.2 && wet.mm - dry.mm >= 15 ? dry : null;
}
