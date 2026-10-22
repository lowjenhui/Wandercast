// Weather outlook for a travel date range at many points, for the map and suggestions.
//
// - Trip starts within the 16-day forecast horizon → daily forecast (covered days only).
// - Otherwise → typical conditions for the same calendar dates over the last 5 years of ERA5
//   reanalysis (the same dataset as the trip analysis), with years in the same El Niño /
//   La Niña phase as expected for the trip counting more. History, not a forecast.
//   (The windows are deliberately not widened: every map point's saved-dates history is
//   stored for the exact dates, and widening would re-spend the API budget on all of them.)

import { addDays, daysBetween, historicalWindows, todayISO, type YearWindow } from '../lib/dates';
import { ensoOutlook, ensoWeight } from '../lib/enso';
import { HALF_LIFE_YEARS } from '../lib/tripOdds';
import { getEnso } from './enso';
import { HEAVY_RAIN_MM, WET_DAY_MM } from '../lib/weatherAnalysis';
import { mean, notNull } from '../lib/stats';
import { getJson, OPEN_METEO } from './http';
import { PointStore, type PointRequest } from './weatherStore';

export const FORECAST_HORIZON_DAYS = 16;
export const TYPICAL_YEARS = 5;
/** Long planning ranges (> 31 days) use fewer years so a map view stays within the API budget. */
export const TYPICAL_YEARS_LONG = 3;


export function typicalYears(start: string, end: string): number {
  return daysBetween(start, end) + 1 > 31 ? TYPICAL_YEARS_LONG : TYPICAL_YEARS;
}

/** Open-Meteo bills one call per location per 14 days requested. */
export function unitsPerPoint(plan: OutlookPlan): number {
  if (plan.basis === 'none') return 1;
  const chunks = Math.ceil((plan.basis === 'forecast' ? plan.coveredDays : plan.tripDays) / 14);
  return plan.basis === 'typical' ? plan.windows.length * chunks : chunks;
}

export type OutlookPlan =
  | { basis: 'forecast'; start: string; end: string; coveredDays: number; tripDays: number }
  | { basis: 'typical'; windows: YearWindow[]; tripDays: number; tripStart: string }
  | { basis: 'none'; tripDays: number; reason: string };

export function planOutlook(start: string, end: string, today = todayISO()): OutlookPlan {
  const tripDays = daysBetween(start, end) + 1;
  const lastForecastDay = addDays(today, FORECAST_HORIZON_DAYS - 1);
  if (start >= today && start <= lastForecastDay) {
    const fEnd = end < lastForecastDay ? end : lastForecastDay;
    return { basis: 'forecast', start, end: fEnd, coveredDays: daysBetween(start, fEnd) + 1, tripDays };
  }
  const windows = historicalWindows(start, end, typicalYears(start, end), 7, today);
  if (!windows.length) return { basis: 'none', tripDays, reason: 'No complete historical years are available for these dates.' };
  return { basis: 'typical', windows, tripDays, tripStart: start };
}

export function describePlan(plan: OutlookPlan): string {
  if (plan.basis === 'forecast') {
    return plan.coveredDays < plan.tripDays
      ? `Forecast. The 16-day forecast covers ${plan.coveredDays} of your ${plan.tripDays} days.`
      : 'Forecast for your dates.';
  }
  if (plan.basis === 'typical') {
    const ys = plan.windows.map((w) => w.year);
    return `Typical weather for these dates (${Math.min(...ys)}–${Math.max(...ys)} ERA5 history, weighted by El Niño / La Niña phase). Your dates are beyond the 16-day forecast, so this is not a forecast.`;
  }
  return plan.reason;
}

/** Summary of conditions over the trip window, normalised to the full trip length. */
export interface TripOutlook {
  basis: 'forecast' | 'typical';
  tripDays: number;
  sampleDays: number;
  years: number;
  wetDays: number;
  totalRainMm: number;
  heavyDays: number;
  tMaxC: number;
  tMinC: number;
  rhPct: number | null;
  /** Typical weather only: fewer than `yearsNeeded` years are stored yet (no rating). */
  pending?: boolean;
  yearsNeeded?: number;
}

/** Fewest stored years that still give a usable typical-weather rating (3 of 5, 2 of 3). */
export function minTypicalYears(windows: number): number {
  return Math.max(1, Math.ceil(windows * 0.6));
}

/** An outlook that can be rated (not still waiting for history to be stored). */
export function usableOutlook(o: TripOutlook | null | undefined): TripOutlook | null | undefined {
  return o?.pending ? null : o;
}

interface DailyResponse {
  /** Set by the cache server when this place isn't (fully) stored. */
  missing?: boolean;
  daily?: {
    time: string[];
    precipitation_sum: (number | null)[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    relative_humidity_2m_mean?: (number | null)[];
  };
}

const DAILY = 'precipitation_sum,temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean';

function coordParams(points: PointRequest[]) {
  return {
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
  };
}

async function fetchDaily(base: string, points: PointRequest[], start: string, end: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ ...coordParams(points), start_date: start, end_date: end, daily: DAILY, timezone: 'auto', ...extra });
  const data = await getJson<DailyResponse | DailyResponse[]>(`${base}?${params}`, {}, 90_000);
  const arr = Array.isArray(data) ? data : [data];
  // Places the server marks missing (not stored, or the API couldn't fetch them) are skipped
  // individually; everyone else in the batch is still used.
  return arr.map((r) => (r?.missing ? {} : r));
}

const PENDING: TripOutlook = { basis: 'typical', tripDays: 0, sampleDays: 0, years: 0, wetDays: 0, totalRainMm: 0, heavyDays: 0, tMaxC: 0, tMinC: 0, rhPct: null, pending: true };

/** One run (a year's window, or the forecast) per point, with its weight. */
interface Run {
  /** Calendar days the window covers (to judge how complete it is). */
  days: number;
  precip: number[];
  tmax: number | null;
  tmin: number | null;
  rh: number | null;
  w: number;
}
type Acc = Run[];

function wAvg(runs: Run[], f: (r: Run) => number | null): number | null {
  let sw = 0;
  let sv = 0;
  for (const r of runs) {
    const v = f(r);
    if (v !== null) (sw += r.w), (sv += v * r.w);
  }
  return sw ? sv / sw : null;
}

function summarise(acc: Acc, plan: Exclude<OutlookPlan, { basis: 'none' }>): TripOutlook | null {
  // A year counts once most of its window is stored.
  const runs = acc.filter((r) => r.w > 0 && r.precip.length >= Math.ceil(r.days * 0.8));
  if (plan.basis === 'typical') {
    const need = minTypicalYears(plan.windows.length);
    if (runs.length < need) return { ...PENDING, basis: 'typical', tripDays: plan.tripDays, years: runs.length, yearsNeeded: need };
  }
  const tMaxC = wAvg(runs, (r) => r.tmax);
  const tMinC = wAvg(runs, (r) => r.tmin);
  if (!runs.length || tMaxC === null || tMinC === null) return null;
  const perRun = (f: (p: number[]) => number) => wAvg(runs, (r) => (f(r.precip) / r.precip.length) * plan.tripDays)!;
  return {
    basis: plan.basis,
    tripDays: plan.tripDays,
    sampleDays: runs.reduce((a, r) => a + r.precip.length, 0),
    years: runs.length,
    wetDays: perRun((p) => p.filter((x) => x >= WET_DAY_MM).length),
    totalRainMm: perRun((p) => p.reduce((a, b) => a + b, 0)),
    heavyDays: perRun((p) => p.filter((x) => x >= HEAVY_RAIN_MM).length),
    tMaxC,
    tMinC,
    rhPct: wAvg(runs, (r) => r.rh),
  };
}

function accumulate(accs: Acc[], responses: DailyResponse[], days: number, w = 1) {
  responses.forEach((r, i) => {
    const d = r.daily;
    if (!d || !accs[i]) return;
    accs[i].push({
      days,
      precip: d.precipitation_sum.filter(notNull),
      tmax: mean(d.temperature_2m_max.filter(notNull)),
      tmin: mean(d.temperature_2m_min.filter(notNull)),
      rh: mean((d.relative_humidity_2m_mean ?? []).filter(notNull)),
      w,
    });
  });
}

/** Per-window weights: recency, times the ENSO phase match (if the index is available). */
async function windowWeights(plan: Extract<OutlookPlan, { basis: 'typical' }>): Promise<number[]> {
  const enso = await getEnso().catch(() => null);
  const mid = addDays(plan.tripStart, Math.floor((plan.tripDays - 1) / 2));
  const outlook = enso ? ensoOutlook(enso.series, mid) : null;
  const tripYear = Number(plan.tripStart.slice(0, 4));
  const midYear = Number(mid.slice(0, 4));
  const midMonth = Number(mid.slice(5, 7));
  return plan.windows.map((w, k) => {
    const anom = enso?.series.at(midYear - (tripYear - w.year), midMonth) ?? null;
    return 0.5 ** (k / HALF_LIFE_YEARS) * ensoWeight(anom, outlook);
  });
}

export function makeOutlookFetcher(plan: OutlookPlan) {
  return async (points: PointRequest[]): Promise<(TripOutlook | null)[]> => {
    if (plan.basis === 'none') return points.map(() => null);
    const accs: Acc[] = points.map(() => []);
    if (plan.basis === 'forecast') {
      // Forecasts change, so they're fetched live (and stored for 3 h); places the API can't
      // fetch right now come back marked missing rather than failing the whole batch.
      accumulate(accs, await fetchDaily(OPEN_METEO.forecast, points, plan.start, plan.end), daysBetween(plan.start, plan.end) + 1);
    } else {
      // Typical weather is read from the database only (stored=1): no API calls while you browse.
      // Missing years are queued on the server and filled in the background.
      const weights = await windowWeights(plan);
      const all = await Promise.allSettled(
        plan.windows.map((w) => fetchDaily(OPEN_METEO.archive, points, w.start, w.end, { models: 'era5', stored: '1' })),
      );
      if (all.every((r) => r.status === 'rejected')) throw (all[0] as PromiseRejectedResult).reason;
      all.forEach((r, i) => r.status === 'fulfilled' && accumulate(accs, r.value, daysBetween(plan.windows[i].start, plan.windows[i].end) + 1, weights[i]));
    }
    return accs.map((acc) => summarise(acc, plan));
  };
}

const stores = new Map<string, PointStore<TripOutlook>>();

/** One cached store per travel date range. */
export function getOutlookStore(start: string, end: string): { store: PointStore<TripOutlook>; plan: OutlookPlan } {
  const plan = planOutlook(start, end);
  const key = `${start}|${end}|${plan.basis}`;
  let store = stores.get(key);
  if (!store) {
    store = new PointStore<TripOutlook>({
      fetchBatch: makeOutlookFetcher(plan),
      // Typical weather is database-only, so it costs no API budget; forecasts do.
      costPerPoint: plan.basis === 'forecast' ? unitsPerPoint(plan) : 0,
      batchSize: plan.basis === 'forecast' ? Math.max(5, Math.min(100, Math.floor(240 / unitsPerPoint(plan)))) : 60,
      // Forecasts change; history doesn't. Places still waiting for history are re-read soon.
      ttlMs: plan.basis === 'forecast' ? 3 * 3600_000 : 7 * 24 * 3600_000,
      ttlFor: (v) => (v?.pending ? 90_000 : undefined),
      storageKey: `wandercast.outlook.v3.${key}`,
    });
    stores.set(key, store);
  }
  return { store, plan };
}
