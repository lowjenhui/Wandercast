import { haversineKm } from '../lib/geo';
import type { RecentRain } from '../lib/recentRain';
import { getJson } from './http';

/** Places stored together are within this distance of the map's points (the server reuses 10 km). */
const MATCH_KM = 15;

let allCache: { at: number; value: Promise<RecentRain[]> } | null = null;
const CACHE_MS = 30 * 60_000;

/** Recent rain vs normal for every place with stored data (the map's seeded places). */
export function getRecentRainAll(): Promise<RecentRain[]> {
  if (allCache && Date.now() - allCache.at < CACHE_MS) return allCache.value;
  const value = getJson<{ places: RecentRain[] }>('/api/recent-rain').then((d) => d.places);
  allCache = { at: Date.now(), value };
  value.catch(() => (allCache = null));
  return value;
}

/** One place, with 12 weeks of weekly rain; null when too little is stored. */
export function getRecentRain(lat: number, lon: number, signal?: AbortSignal): Promise<RecentRain | null> {
  return getJson<RecentRain | null>(`/api/recent-rain?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, { signal });
}

/** The stored place nearest a map point, within MATCH_KM. */
export function nearestRecentRain(list: RecentRain[], lat: number, lon: number): RecentRain | null {
  let best: RecentRain | null = null;
  let bestKm = MATCH_KM;
  for (const r of list) {
    if (Math.abs(r.lat - lat) > 0.2 || Math.abs(r.lon - lon) > 0.25) continue;
    const km = haversineKm(r.lat, r.lon, lat, lon);
    if (km <= bestKm) (best = r), (bestKm = km);
  }
  return best;
}
