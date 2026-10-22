// Classifies a current-weather snapshot and explains which weather phenomena are at play.

import type { SeasonalRisk } from '../types';
import { haversineKm } from './geo';

export interface CurrentWeather {
  time: string; // local ISO time at the location
  utcOffsetSeconds: number;
  tempC: number;
  feelsLikeC: number;
  humidityPct: number;
  precipMm: number;
  weatherCode: number;
  windKmh: number;
  gustKmh?: number | null;
  visibilityM?: number | null;
  isDay: boolean;
  /** When this place's data was loaded into the database (ms since epoch). */
  loadedAt?: number;
  /** True when the stored data no longer covers the current hour, so it shows the hour it was loaded. */
  snapshot?: boolean;
}

export interface AirQuality {
  pm25: number;
  pm10: number | null;
  usAqi: number | null;
  dust: number | null;
  aod: number | null;
}

export interface NearbyHazard {
  kind: 'cyclone' | 'fire' | 'flood';
  name: string;
  alert: string;
  lat: number;
  lon: number;
  countries: string;
}

export type ConditionClass = 'good' | 'average' | 'bad';

export interface Classified {
  category: ConditionClass;
  reasons: string[];
}

export type PhenomenonSeverity = 'high' | 'moderate' | 'info';

export interface Phenomenon {
  /** 'now' = observed/modelled right now; 'season' = typical for this time of year. */
  basis: 'now' | 'season';
  title: string;
  detail: string;
  severity: PhenomenonSeverity;
  source?: { name: string; url: string };
}

/** WMO weather interpretation codes (as used by Open-Meteo). */
export function describeWeatherCode(code: number): string {
  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code === 56 || code === 57) return 'Freezing drizzle';
  if (code === 61) return 'Light rain';
  if (code === 63) return 'Rain';
  if (code === 65) return 'Heavy rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code === 71) return 'Light snow';
  if (code === 73) return 'Snow';
  if (code === 75) return 'Heavy snow';
  if (code === 77) return 'Snow grains';
  if (code === 80) return 'Light showers';
  if (code === 81) return 'Showers';
  if (code === 82) return 'Violent showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return 'Unknown';
}

/** US EPA AQI category name. */
export function aqiCategory(aqi: number): string {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

const SEVERE_CODES = new Set([65, 66, 67, 75, 82, 86, 95, 96, 99]);
const WET_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 71, 73, 77, 80, 81, 85]);

const SEA_HAZE = new Set(['SG', 'MY', 'ID', 'BN', 'TH']);

export const CYCLONE_RADIUS_KM = 800;
export const FIRE_RADIUS_KM = 500;

function nearest(hazards: NearbyHazard[], kind: NearbyHazard['kind'], lat: number, lon: number, radiusKm: number) {
  return hazards
    .filter((h) => h.kind === kind)
    .map((h) => ({ h, km: haversineKm(lat, lon, h.lat, h.lon) }))
    .filter((x) => x.km <= radiusKm)
    .sort((a, b) => a.km - b.km);
}

export function classifyCurrent(w: CurrentWeather, aq?: AirQuality | null, hazards: NearbyHazard[] = [], at?: { lat: number; lon: number }): Classified {
  const bad: string[] = [];
  const meh: string[] = [];

  if (SEVERE_CODES.has(w.weatherCode)) bad.push(describeWeatherCode(w.weatherCode));
  else if (WET_CODES.has(w.weatherCode) || w.precipMm >= 0.2) meh.push(describeWeatherCode(w.weatherCode) === 'Unknown' ? 'Precipitation' : describeWeatherCode(w.weatherCode));
  else if (w.weatherCode === 45 || w.weatherCode === 48) meh.push('Fog');

  if (w.feelsLikeC >= 38) bad.push(`Very hot (feels like ${Math.round(w.feelsLikeC)} °C)`);
  else if (w.feelsLikeC <= 0) bad.push(`Freezing (feels like ${Math.round(w.feelsLikeC)} °C)`);
  else if (w.feelsLikeC > 31) meh.push(`Hot (feels like ${Math.round(w.feelsLikeC)} °C)`);
  else if (w.feelsLikeC < 12) meh.push(`Cold (feels like ${Math.round(w.feelsLikeC)} °C)`);

  const gust = w.gustKmh ?? 0;
  if (w.windKmh >= 50 || gust >= 80) bad.push(`Strong wind (${Math.round(w.windKmh)} km/h, gusts ${Math.round(gust)})`);
  else if (w.windKmh >= 30 || gust >= 55) meh.push(`Windy (${Math.round(w.windKmh)} km/h)`);

  if (w.humidityPct >= 85 && w.tempC >= 25) meh.push(`Muggy (${Math.round(w.humidityPct)}% humidity)`);

  // Particulate haze drives the rating; a high AQI from other pollutants (e.g. ozone) only lowers it to average.
  if (aq) {
    if (aq.pm25 >= 55.5) bad.push(`Unhealthy haze (PM2.5 ${Math.round(aq.pm25)} µg/m³)`);
    else if (aq.pm25 >= 35.5) meh.push(`Hazy air (PM2.5 ${Math.round(aq.pm25)} µg/m³)`);
    else if (aq.usAqi != null && aq.usAqi > 150) meh.push(`Elevated air pollution (US AQI ${Math.round(aq.usAqi)})`);
  }

  if (at) {
    const tc = nearest(hazards, 'cyclone', at.lat, at.lon, 300)[0];
    if (tc) bad.push(`${tc.h.name} ~${Math.round(tc.km)} km away`);
  }

  if (bad.length) return { category: 'bad', reasons: [...bad, ...meh] };
  if (meh.length) return { category: 'average', reasons: meh };
  return { category: 'good', reasons: ['Dry, comfortable temperature, light wind, clean air'] };
}

/**
 * Explains the weather phenomena at a point: live conditions (thunderstorms, haze,
 * dust, nearby cyclones) plus seasonal regimes typical for this month (monsoons etc.).
 */
export function detectPhenomena(input: {
  weather: CurrentWeather;
  aq?: AirQuality | null;
  hazards: NearbyHazard[];
  lat: number;
  lon: number;
  seasonal: SeasonalRisk[];
  cc?: string;
}): Phenomenon[] {
  const { weather: w, aq, hazards, lat, lon } = input;
  const out: Phenomenon[] = [];
  const gdacs = { name: 'GDACS', url: 'https://www.gdacs.org/' };
  const cams = { name: 'Open-Meteo Air Quality (CAMS model)', url: 'https://open-meteo.com/en/docs/air-quality-api' };
  const asmc = { name: 'ASEAN Specialised Meteorological Centre: haze and hotspots', url: 'https://asmc.asean.org/' };

  // Tropical cyclones nearby.
  for (const { h, km } of nearest(hazards, 'cyclone', lat, lon, CYCLONE_RADIUS_KM).slice(0, 2)) {
    out.push({
      basis: 'now',
      title: h.name,
      detail: `Active tropical cyclone about ${Math.round(km)} km away (GDACS ${h.alert.toLowerCase()} alert${h.countries ? `, affecting ${h.countries}` : ''}). Expect squalls, heavy rain and possible flight disruption.`,
      severity: km < 300 || h.alert === 'Red' || h.alert === 'Orange' ? 'high' : 'moderate',
      source: gdacs,
    });
  }

  // Convective and precipitation phenomena.
  if (w.weatherCode >= 95) {
    out.push({ basis: 'now', title: w.weatherCode === 95 ? 'Thunderstorm' : 'Thunderstorm with hail', detail: 'Lightning, gusty winds and intense downpours are likely.', severity: 'high' });
  } else if (w.weatherCode === 82 || w.weatherCode === 65) {
    out.push({ basis: 'now', title: 'Heavy rain', detail: `${describeWeatherCode(w.weatherCode)}; localised flash flooding is possible.`, severity: 'high' });
  } else if (w.weatherCode === 75 || w.weatherCode === 86) {
    out.push({ basis: 'now', title: 'Heavy snow', detail: 'Travel disruption likely.', severity: 'high' });
  }

  // Haze / smoke / dust from the air-quality model.
  const hazy = aq && aq.pm25 >= 35.5;
  const lowVis = w.visibilityM != null && w.visibilityM < 5000;
  if (aq && aq.dust != null && aq.dust >= 100) {
    out.push({
      basis: 'now',
      title: 'Dust haze',
      detail: `High airborne dust (${Math.round(aq.dust)} µg/m³)${lowVis ? ` and reduced visibility (${(w.visibilityM! / 1000).toFixed(1)} km)` : ''}, typically from desert dust storms.`,
      severity: aq.dust >= 300 ? 'high' : 'moderate',
      source: cams,
    });
  } else if (hazy) {
    const fires = nearest(hazards, 'fire', lat, lon, FIRE_RADIUS_KM);
    const aqiTxt = aq.usAqi != null ? `US AQI ${Math.round(aq.usAqi)}, ${aqiCategory(aq.usAqi).toLowerCase()}` : 'elevated';
    const where = [...new Set(fires.map((f) => f.h.countries).filter(Boolean))].slice(0, 2).join(' / ');
    out.push({
      basis: 'now',
      title: fires.length ? 'Smoke haze' : 'Haze',
      detail: fires.length
        ? `PM2.5 ${Math.round(aq.pm25)} µg/m³ (${aqiTxt}). ${fires.length} active fire${fires.length === 1 ? '' : 's'} within ${FIRE_RADIUS_KM} km${where ? ` (${where})` : ''}, nearest about ${Math.round(fires[0].km)} km away, are a likely source.`
        : `PM2.5 ${Math.round(aq.pm25)} µg/m³ (${aqiTxt}). Possible sources include smoke drifting from distant fires, urban or industrial pollution, or stagnant air.${aq.aod != null && aq.aod >= 1 ? ' The atmosphere is also very turbid (aerosol optical depth ' + aq.aod.toFixed(1) + '), which is typical of regional smoke haze.' : ''}`,
      severity: aq.pm25 >= 55.5 ? 'high' : 'moderate',
      source: fires.length ? gdacs : SEA_HAZE.has(input.cc ?? '') ? asmc : cams,
    });
  } else if (aq && aq.usAqi != null && aq.usAqi > 150) {
    out.push({
      basis: 'now',
      title: 'Elevated air pollution',
      detail: `US AQI ${Math.round(aq.usAqi)} (${aqiCategory(aq.usAqi).toLowerCase()}) with low particulates. This is likely ozone or other gases rather than haze; sensitive people may want to limit exertion outdoors.`,
      severity: 'moderate',
      source: cams,
    });
  } else if (w.weatherCode === 45 || w.weatherCode === 48 || (w.visibilityM != null && w.visibilityM < 1000 && w.humidityPct >= 90)) {
    out.push({ basis: 'now', title: 'Fog', detail: `Visibility ${w.visibilityM != null ? `${(w.visibilityM / 1000).toFixed(1)} km` : 'reduced'}; early flights and ferries may be delayed.`, severity: 'moderate' });
  }

  // Temperature extremes.
  if (w.feelsLikeC >= 40) out.push({ basis: 'now', title: 'Extreme heat', detail: `Feels like ${Math.round(w.feelsLikeC)} °C. Heat-stress risk; limit time outdoors in the middle of the day.`, severity: 'high' });
  else if (w.feelsLikeC <= -10) out.push({ basis: 'now', title: 'Severe cold', detail: `Feels like ${Math.round(w.feelsLikeC)} °C. Frostbite risk on exposed skin.`, severity: 'high' });

  // Strong winds not already explained by a cyclone.
  if ((w.gustKmh ?? 0) >= 70 && !out.some((p) => p.source === gdacs && p.title !== 'Smoke haze')) {
    out.push({ basis: 'now', title: 'Gale-force gusts', detail: `Gusts up to ${Math.round(w.gustKmh!)} km/h.`, severity: 'high' });
  }

  // Seasonal regimes (deduplicated by title).
  const seen = new Set<string>();
  for (const r of input.seasonal) {
    if (seen.has(r.title)) continue;
    seen.add(r.title);
    out.push({ basis: 'season', title: r.title, detail: r.description, severity: r.severity, source: r.source });
  }
  return out;
}
