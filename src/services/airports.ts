import { haversineKm } from '../lib/geo';
import type { Airport } from '../types';

export { haversineKm };

export const ORIGIN = { iata: 'SIN', name: 'Singapore Changi Airport' } as const;

type Row = [iata: string, cityCode: string, name: string, lat: number, lon: number, cc: string];

let cache: Promise<Row[]> | null = null;

function loadAirports(): Promise<Row[]> {
  // Built by scripts/build-airports.mjs from the public Travelpayouts airport directory.
  cache ??= fetch(`${import.meta.env.BASE_URL}airports.json`).then((r) => {
    if (!r.ok) throw new Error(`Airport list failed to load (HTTP ${r.status})`);
    return r.json() as Promise<Row[]>;
  });
  cache.catch(() => (cache = null));
  return cache;
}

/** Nearest airports with scheduled service, closest first, excluding Singapore. */
export async function nearestAirports(lat: number, lon: number, limit = 5, maxKm = 250): Promise<Airport[]> {
  const rows = await loadAirports();
  return rows
    .filter((r) => r[1] !== ORIGIN.iata)
    .map((r) => ({
      iata: r[0],
      cityCode: r[1],
      name: r[2],
      latitude: r[3],
      longitude: r[4],
      countryCode: r[5],
      distanceKm: haversineKm(lat, lon, r[3], r[4]),
    }))
    .filter((a) => a.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/** Airport code → country code, for telling which country a connection is in. */
export async function airportCountries(): Promise<Map<string, string>> {
  return new Map((await loadAirports()).map((r) => [r[0], r[5]]));
}
