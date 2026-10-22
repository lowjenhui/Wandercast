// Pre-fetches weather for saved travel date ranges, so the map and suggestions for those dates
// load from the database. Runs inside the seeder, ahead of general seeding.
//
// For each saved range it stores, for every map destination and country capital:
//   - ERA5 history for the same calendar dates in recent years (what "typical weather" uses:
//     5 years, or 3 for ranges longer than a month — matching the app's outlook logic)
//   - the daily forecast, when the range starts within the 16-day forecast horizon.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBooked, type SavedRange, type SavedRanges } from './savedRanges';
import { climateZoneCities, gateways, landOnlyPlaces } from './seeder';
import { unitsFor, type Upstream } from './upstream';
import { DAILY_VARS, FORECAST_DAYS, roundLoc, type Loc, type WeatherCache } from './weatherCache';

const SEA = new Set(['BN', 'KH', 'ID', 'LA', 'MY', 'MM', 'PH', 'SG', 'TH', 'TL', 'VN']);
const ASIA = new Set([...SEA, 'CN', 'HK', 'MO', 'TW', 'JP', 'KR', 'MN', 'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV', 'AE', 'QA', 'SA', 'OM', 'KW', 'BH', 'TR', 'KZ', 'UZ']);
const SKIP = new Set(['AQ', 'BV', 'HM', 'UM', 'GS', 'TF', 'IO']);

export interface MapPoint extends Loc {
  name: string;
  cc: string;
}

function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Progress recounts what's stored at most this often, so data added by something other than
 *  this prefetcher (searches, scripts/import-era5-cds.py) shows up while it is idle or waiting. */
const RESCAN_MS = 60_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const todayUTC = () => new Date().toISOString().slice(0, 10);

function shiftYears(s: string, years: number): string {
  const [y, m, d] = s.split('-').map(Number);
  const ty = y + years;
  const leap = (ty % 4 === 0 && ty % 100 !== 0) || ty % 400 === 0;
  return `${ty}-${String(m).padStart(2, '0')}-${String(m === 2 && d === 29 && !leap ? 28 : d).padStart(2, '0')}`;
}

/** Same-date windows in previous years — mirrors src/services/tripOutlook.ts planOutlook. */
export function typicalWindows(start: string, end: string, today = todayUTC()): { start: string; end: string }[] {
  const count = daysBetween(start, end) + 1 > 31 ? 3 : 5;
  const cutoff = addDays(today, -7);
  const out: { start: string; end: string }[] = [];
  for (let k = 1; out.length < count && k <= count + 3; k++) {
    const s = shiftYears(start, -k);
    const e = shiftYears(end, -k);
    if (e <= cutoff) out.push({ start: s, end: e });
  }
  return out;
}

/**
 * The points the map's travel-dates view and the suggestions request: destinations (curated,
 * direct-flight cities, ferry and gateway destinations) and country capitals, ordered popular → Southeast Asia → Asia → rest.
 */
export function buildMapPoints(publicDir: string): MapPoint[] {
  const read = <T,>(f: string): T => JSON.parse(readFileSync(join(publicDir, f), 'utf8')) as T;
  const dests = read<{ name: string; cc: string; lat: number; lon: number }[]>('destinations.json');
  const direct = read<{ cities: { name: string; cc: string; lat: number; lon: number; airlines: string[] }[] }>('direct-cities.json').cities;
  const capitals = read<{ name: string; cc: string; lat: number; lon: number }[]>('capitals.json').filter((c) => !SKIP.has(c.cc));
  const tier = (cc: string, popular: boolean) => (popular ? 0 : SEA.has(cc) ? 1 : ASIA.has(cc) ? 2 : 3);
  let ferries: { name: string; cc: string; lat: number; lon: number }[] = [];
  try {
    ferries = read<{ destinations: typeof ferries }>('ferry-destinations.json').destinations;
  } catch {
    /* optional */
  }
  const all = [
    ...ferries.map((f) => ({ p: f, t: 0 })),
    ...landOnlyPlaces(read).map((l) => ({ p: l, t: 0 })),
    ...direct.map((c) => ({ p: c, t: tier(c.cc, c.airlines.length >= 2) })),
    ...dests.map((d) => ({ p: d, t: tier(d.cc, true) })),
    // Climate-zone cities colour whole regions of the map, so they come with the popular ones.
    ...climateZoneCities(read).map((z) => ({ p: z, t: 0 })),
    // Gateway places are an optional map layer ("Via places"), so they're stored last.
    ...gateways(read).map((g) => ({ p: g, t: 4 })),
    ...capitals.map((c) => ({ p: c, t: tier(c.cc, false) })),
  ].sort((a, b) => a.t - b.t);
  const seen = new Set<string>();
  const out: MapPoint[] = [];
  for (const { p } of all) {
    // Keep the exact coordinates the browser requests (rounded like the server's keys).
    const loc = roundLoc({ lat: p.lat, lon: p.lon });
    const key = `${loc.lat},${loc.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, cc: p.cc, ...loc });
  }
  return out;
}

export interface RangeProgress {
  id: number;
  places: number;
  placesDone: number;
  years: number;
  forecast: boolean;
  /** Share of place-years (and forecasts) stored, 0–100; moves with every batch. */
  pct: number;
  state: 'complete' | 'fetching' | 'queued' | 'waiting' | 'past';
  detail: string;
}

interface RangeState {
  key: string;
  windows: { start: string; end: string }[];
  forecast: { start: string; end: string } | null;
  done: boolean[]; // per point: all windows (and forecast) stored
  parts: number[]; // per point: how many windows (+ forecast) are stored
  scanned: boolean;
  scannedAt: number;
}

export class SavedPrefetcher {
  private states = new Map<number, RangeState>();
  private priority: number[] = [];
  private waitingReason: string | null = null;
  private activeId: number | null = null;

  constructor(
    private cache: WeatherCache,
    private up: Upstream,
    private saved: SavedRanges,
    private points: MapPoint[],
  ) {}

  /** Move a range to the front of the queue ("Retrieve now"). */
  prioritize(id: number) {
    this.priority = [id, ...this.priority.filter((x) => x !== id)];
  }

  private stateFor(r: SavedRange): RangeState {
    const key = `${r.start}|${r.end}`;
    let s = this.states.get(r.id);
    if (!s || s.key !== key) {
      const today = todayUTC();
      const lastForecast = addDays(today, FORECAST_DAYS - 2); // stay inside the horizon in all timezones
      const forecast = r.start >= today && r.start <= lastForecast ? { start: r.start, end: r.end < lastForecast ? r.end : lastForecast } : null;
      s = { key, windows: typicalWindows(r.start, r.end), forecast, done: this.points.map(() => false), parts: this.points.map(() => 0), scanned: false, scannedAt: 0 };
      this.states.set(r.id, s);
    }
    return s;
  }

  /** Number of stored parts (history windows, plus the forecast if needed) for a point. */
  private pointParts(s: RangeState, p: MapPoint): number {
    const loc = this.cache.resolve('era5', p);
    let n = s.windows.filter((w) => !this.cache.era5Missing(loc, w.start, w.end)).length;
    if (s.forecast && this.cache.forecastFresh(this.cache.resolve('forecast', p), s.forecast.start, s.forecast.end)) n++;
    return n;
  }

  private totalParts(s: RangeState) {
    return s.windows.length + (s.forecast ? 1 : 0);
  }

  private rescan(s: RangeState) {
    const total = this.totalParts(s);
    this.points.forEach((p, i) => {
      if (s.done[i]) return;
      s.parts[i] = this.pointParts(s, p);
      s.done[i] = s.parts[i] >= total;
    });
    s.scanned = true;
    s.scannedAt = Date.now();
  }

  /** Ranges that still matter (not already over), in queue order. */
  private queue(): SavedRange[] {
    const today = todayUTC();
    // Booked trips don't need map-wide weather any more (Puff's Lookout watches one place).
    const list = this.saved.list().filter((r) => r.end >= today && !isBooked(r));
    const pri = new Map(this.priority.map((id, i) => [id, i]));
    return list.sort((a, b) => (pri.get(a.id) ?? 1e9) - (pri.get(b.id) ?? 1e9) || a.start.localeCompare(b.start));
  }

  /**
   * Does one batch of work for the first incomplete range. Returns true if it fetched
   * something, false if everything is stored (or no budget is available right now).
   */
  async step(): Promise<boolean> {
    for (const r of this.queue()) {
      const s = this.stateFor(r);
      if (!s.scanned) this.rescan(s);
      const idx = s.done.findIndex((d) => !d);
      if (idx < 0) continue;

      // Forecast first (cheap), for up to 60 places at a time.
      if (s.forecast) {
        const need = this.points.filter((p, i) => !s.done[i] && !this.cache.forecastFresh(this.cache.resolve('forecast', p), s.forecast!.start, s.forecast!.end)).slice(0, 60);
        if (need.length) {
          const units = unitsFor(need.length, FORECAST_DAYS, DAILY_VARS.length);
          if (!this.up.canSpend(units, 'saved')) return this.wait();
          this.activeId = r.id;
          await this.cache.ensureForecast(need, s.forecast.start, s.forecast.end, { seed: true, lane: 'saved' });
          return this.finish(s);
        }
      }

      // History: newest window first, batching places that are missing it.
      for (const w of s.windows) {
        const days = daysBetween(w.start, w.end) + 1;
        const perLoc = unitsFor(1, days, DAILY_VARS.length);
        const max = Math.max(1, Math.floor(240 / perLoc));
        const need: MapPoint[] = [];
        for (let i = 0; i < this.points.length && need.length < max; i++) {
          if (!s.done[i] && this.cache.era5Missing(this.cache.resolve('era5', this.points[i]), w.start, w.end)) need.push(this.points[i]);
        }
        if (!need.length) continue;
        if (!this.up.canSpend(perLoc * need.length, 'saved')) return this.wait();
        this.activeId = r.id;
        await this.cache.ensureEra5(need, w.start, w.end, { seed: true, lane: 'saved', maxUnitsPerRequest: 240 });
        return this.finish(s);
      }
      // Nothing missing after all (e.g. filled by the app meanwhile).
      this.rescan(s);
    }
    this.activeId = null;
    this.waitingReason = null;
    return false;
  }

  private finish(s: RangeState): true {
    this.waitingReason = null;
    this.rescan(s);
    return true;
  }

  private wait(): false {
    const st = this.up.status();
    this.waitingReason =
      st.savedToday + 50 >= st.limits.savedPerDay || st.today + 50 >= st.limits.perDay - st.limits.interactiveReserve
        ? 'Waiting for the daily weather API allowance to reset (00:00 UTC, 08:00 Singapore time).'
        : 'Waiting for spare API budget (your own searches come first).';
    return false;
  }

  hasWork(): boolean {
    return this.queue().some((r) => {
      const s = this.stateFor(r);
      if (!s.scanned) this.rescan(s);
      return s.done.some((d) => !d);
    });
  }

  progress(r: SavedRange): RangeProgress {
    const today = todayUTC();
    const s = this.stateFor(r);
    if (!s.scanned || Date.now() - s.scannedAt > RESCAN_MS) this.rescan(s);
    const placesDone = s.done.filter(Boolean).length;
    const total = this.totalParts(s) * this.points.length;
    const stored = s.done.reduce((a, d, i) => a + (d ? this.totalParts(s) : s.parts[i]), 0);
    const pct = total ? Math.floor((stored / total) * 100) : 100;
    const base = { id: r.id, places: this.points.length, placesDone, years: s.windows.length, forecast: Boolean(s.forecast), pct };
    if (r.end < today) return { ...base, state: 'past', detail: 'These dates have passed.' };
    if (placesDone === this.points.length) return { ...base, state: 'complete', detail: 'Weather data saved for all map places.' };
    if (this.activeId === r.id && !this.waitingReason) return { ...base, state: 'fetching', detail: 'Fetching weather data…' };
    if (this.waitingReason) return { ...base, state: 'waiting', detail: this.waitingReason };
    return { ...base, state: 'queued', detail: 'Queued behind other saved dates.' };
  }
}
