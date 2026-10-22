import type { Place } from '../types';
import { getJson } from './http';

export interface GeocodingService {
  search(query: string, signal?: AbortSignal): Promise<Place[]>;
}

interface OpenMeteoGeoResponse {
  results?: Array<{
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    country_code?: string;
    admin1?: string;
    timezone?: string;
    population?: number;
  }>;
}

/** Open-Meteo geocoding (GeoNames-based, free, CORS-enabled, no key). */
export const openMeteoGeocoding: GeocodingService = {
  async search(query, signal) {
    const q = query.trim();
    if (q.length < 2) return [];
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
    const data = await getJson<OpenMeteoGeoResponse>(url, { signal });
    return (data.results ?? [])
      .filter((r) => r.country_code)
      .map((r) => ({
        id: String(r.id),
        name: r.name,
        admin1: r.admin1,
        country: r.country ?? r.country_code!,
        countryCode: r.country_code!.toUpperCase(),
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone,
      }));
  },
};
