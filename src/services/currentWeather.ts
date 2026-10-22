import type { AirQuality, CurrentWeather } from '../lib/currentConditions';
import { getJson, OPEN_METEO } from './http';

export interface CountryPoint {
  ccn3: string; // ISO 3166-1 numeric, matches world-atlas feature ids
  cc: string;
  name: string;
  capital: string;
  lat: number;
  lon: number;
  point: 'capital' | 'centre';
}

export interface CityPoint {
  id: string;
  name: string;
  cc: string;
  lat: number;
  lon: number;
  population: number;
  /** Population, boosted ×4 around Singapore so smaller regional destinations appear sooner when zooming. */
  weight: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CurrentWeatherService {
  /** Reads stored data; `refresh` asks the server to load newer data from the API. */
  getCurrent(points: LatLon[], signal?: AbortSignal, refresh?: boolean): Promise<(CurrentWeather | null)[]>;
}

export interface AirQualityService {
  getCurrent(points: LatLon[], signal?: AbortSignal, refresh?: boolean): Promise<(AirQuality | null)[]>;
}

// Uninhabited territories are left out of the weather request.
const SKIP = new Set(['AQ', 'BV', 'HM', 'UM', 'GS', 'TF', 'IO']);

let pointsCache: Promise<CountryPoint[]> | null = null;
let citiesCache: Promise<CityPoint[]> | null = null;

/** Representative points per country, built by scripts/build-capitals.mjs. */
export function loadCountryPoints(): Promise<CountryPoint[]> {
  pointsCache ??= fetch(`${import.meta.env.BASE_URL}capitals.json`).then((r) => {
    if (!r.ok) throw new Error(`Country list failed to load (HTTP ${r.status})`);
    return (r.json() as Promise<CountryPoint[]>).then((pts) => pts.filter((p) => !SKIP.has(p.cc)));
  });
  pointsCache.catch(() => (pointsCache = null));
  return pointsCache;
}

/** Cities from GeoNames, built by scripts/build-cities.mjs; sorted by population, largest first. */
export function loadCities(): Promise<CityPoint[]> {
  citiesCache ??= fetch(`${import.meta.env.BASE_URL}cities.json`).then((r) => {
    if (!r.ok) throw new Error(`City list failed to load (HTTP ${r.status})`);
    const inRegion = (lat: number, lon: number) => lon >= 90 && lon <= 135 && lat >= -11 && lat <= 28;
    return (r.json() as Promise<[string, string, number, number, number][]>).then((rows) =>
      rows
        .map(([name, cc, lat, lon, population]) => ({
          id: `${cc}:${name}:${lat}`,
          name,
          cc,
          lat,
          lon,
          population,
          weight: population * (inRegion(lat, lon) ? 4 : 1),
        }))
        .sort((a, b) => b.weight - a.weight),
    );
  });
  citiesCache.catch(() => (citiesCache = null));
  return citiesCache;
}

function coordParams(points: LatLon[]) {
  return {
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
  };
}

interface ForecastCurrent {
  utc_offset_seconds: number;
  fetched_at?: number;
  snapshot?: boolean;
  current?: {
    time: string;
    temperature_2m: number | null;
    apparent_temperature: number | null;
    relative_humidity_2m: number | null;
    precipitation: number | null;
    weather_code: number | null;
    wind_speed_10m: number | null;
    wind_gusts_10m: number | null;
    visibility: number | null;
    is_day: number | null;
  };
}

/** Open-Meteo forecast API, `current` block (model-based, updated every 15 min). */
export const openMeteoCurrent: CurrentWeatherService = {
  async getCurrent(points, signal, refresh) {
    const params = new URLSearchParams({
      ...coordParams(points),
      ...(refresh ? { refresh: '1' } : {}),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility,is_day',
      timezone: 'auto',
    });
    const data = await getJson<ForecastCurrent | null | (ForecastCurrent | null)[]>(`${OPEN_METEO.forecast}?${params}`, { signal }, 30_000);
    return (Array.isArray(data) ? data : [data]).map((r) => {
      const c = r?.current;
      if (!c || c.temperature_2m === null || c.weather_code === null) return null;
      return {
        time: c.time,
        utcOffsetSeconds: r!.utc_offset_seconds,
        tempC: c.temperature_2m,
        feelsLikeC: c.apparent_temperature ?? c.temperature_2m,
        humidityPct: c.relative_humidity_2m ?? 0,
        precipMm: c.precipitation ?? 0,
        weatherCode: c.weather_code,
        windKmh: c.wind_speed_10m ?? 0,
        gustKmh: c.wind_gusts_10m,
        visibilityM: c.visibility,
        isDay: c.is_day === 1,
        loadedAt: r!.fetched_at,
        snapshot: r!.snapshot,
      };
    });
  },
};

interface AirQualityCurrent {
  current?: {
    pm2_5: number | null;
    pm10: number | null;
    us_aqi: number | null;
    dust: number | null;
    aerosol_optical_depth: number | null;
  };
}

/** Open-Meteo Air Quality API (CAMS atmospheric model), `current` block. */
export const openMeteoAirQuality: AirQualityService = {
  async getCurrent(points, signal, refresh) {
    const params = new URLSearchParams({
      ...coordParams(points),
      ...(refresh ? { refresh: '1' } : {}),
      current: 'pm2_5,pm10,us_aqi,dust,aerosol_optical_depth',
      timezone: 'auto',
    });
    const data = await getJson<AirQualityCurrent | null | (AirQualityCurrent | null)[]>(`${OPEN_METEO.airQuality}?${params}`, { signal }, 30_000);
    return (Array.isArray(data) ? data : [data]).map((r) => {
      const c = r?.current;
      if (!c || c.pm2_5 === null) return null;
      return { pm25: c.pm2_5, pm10: c.pm10, usAqi: c.us_aqi, dust: c.dust, aod: c.aerosol_optical_depth };
    });
  },
};
