// Recent rain vs normal, from stored data only (no API calls).
//
//   GET /api/recent-rain              every place with recent data, for the map (cached 1 h)
//   GET /api/recent-rain?lat=&lon=    one place, with 12 weeks of weekly rain, for the trip card
//
// Recent days come from ERA5 where it has settled (about 10 days behind) and from the past days
// stored with each forecast after that. The normal is the same calendar days in each of the
// past 10 years of ERA5.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { addDays, shiftYears } from '../src/lib/dates';
import { recentRainLevel, type RecentRain, type RecentRainWeek } from '../src/lib/recentRain';
import { WET_DAY_MM } from '../src/lib/weatherAnalysis';
import type { DB } from './db';
import type { Loc, WeatherCache } from './weatherCache';

const YEARS = 10;
/** Years needed for a normal; fewer and the place is left out. */
const MIN_YEARS = 5;
const WEEKS = 12;
/** Days of a 30-day window that must be stored (recent or in a past year) to count it. */
const MIN_DAYS_30 = 27;
const ALL_TTL_MS = 3600_000;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export class RecentRainStore {
  private allCache: { at: number; end: string; value: RecentRain[] } | null = null;

  constructor(
    private db: DB,
    private cache: WeatherCache,
  ) {}

  /** Daily rain by date for [start, end]: ERA5 first, then stored forecast days. */
  private daily(loc: Loc, start: string, end: string, forecast: boolean): Map<string, number> {
    const e = this.cache.resolve('era5', loc);
    const out = new Map<string, number>();
    const era5 = this.db.prepare('SELECT date, precip FROM era5_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ? AND precip IS NOT NULL').all(e.lat, e.lon, start, end) as {
      date: string;
      precip: number;
    }[];
    for (const r of era5) out.set(r.date, r.precip);
    if (forecast) {
      const f = this.cache.resolve('forecast', loc);
      const fc = this.db.prepare('SELECT date, precip FROM forecast_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ? AND precip IS NOT NULL').all(f.lat, f.lon, start, end) as {
        date: string;
        precip: number;
      }[];
      for (const r of fc) if (!out.has(r.date)) out.set(r.date, r.precip);
    }
    return out;
  }

  /** Recent rain vs normal for one place, or null when too little is stored. `end` is the last day counted. */
  compute(loc: Loc, end: string, opts: { weeks?: boolean } = {}): RecentRain | null {
    const span = opts.weeks ? WEEKS * 7 : 30;
    const start = addDays(end, -(span - 1));
    const dates = Array.from({ length: span }, (_, i) => addDays(start, i));
    const recent = this.daily(loc, start, end, true);
    const vals = (from: number, to: number, m: Map<string, number>, ds: string[]) => ds.slice(from, to).map((d) => m.get(d)).filter((x): x is number => x !== undefined);

    const last30 = vals(span - 30, span, recent, dates);
    if (last30.length < MIN_DAYS_30) return null;
    const last7 = vals(span - 7, span, recent, dates);
    const scaled = (xs: number[], n: number) => (xs.length ? (sum(xs) * n) / xs.length : 0);

    // The same calendar days in each past year.
    const years: { d30: number[]; d7: number[]; weeks: number[][] }[] = [];
    for (let k = 1; k <= YEARS; k++) {
      const s = shiftYears(start, -k);
      const ds = Array.from({ length: span }, (_, i) => addDays(s, i));
      const m = this.daily(loc, ds[0], ds[span - 1], false);
      const d30 = vals(span - 30, span, m, ds);
      if (d30.length < MIN_DAYS_30) continue;
      years.push({ d30, d7: vals(span - 7, span, m, ds), weeks: opts.weeks ? Array.from({ length: WEEKS }, (_, w) => vals(w * 7, w * 7 + 7, m, ds)) : [] });
    }
    if (years.length < MIN_YEARS) return null;

    const mm30 = scaled(last30, 30);
    const mm7 = scaled(last7, 7);
    const normal30 = mean(years.map((y) => scaled(y.d30, 30)));
    const normal7 = mean(years.filter((y) => y.d7.length >= 6).map((y) => scaled(y.d7, 7)));
    const r: RecentRain = {
      lat: loc.lat,
      lon: loc.lon,
      end,
      mm7,
      normal7,
      mm30,
      normal30,
      wetDays30: last30.filter((x) => x >= WET_DAY_MM).length,
      usualWetDays30: mean(years.map((y) => (y.d30.filter((x) => x >= WET_DAY_MM).length * 30) / y.d30.length)),
      years: years.length,
      level: recentRainLevel({ mm7, normal7, mm30, normal30 }),
    };
    if (opts.weeks) {
      r.weeks = Array.from({ length: WEEKS }, (_, w): RecentRainWeek => {
        const got = vals(w * 7, w * 7 + 7, recent, dates);
        return {
          start: dates[w * 7],
          mm: got.length >= 4 ? scaled(got, 7) : null,
          normalMm: mean(years.filter((y) => y.weeks[w].length >= 4).map((y) => scaled(y.weeks[w], 7))),
        };
      });
    }
    return r;
  }

  /** Every place with ERA5 stored for recent weeks (the seeded ones), for the map. */
  all(end: string): RecentRain[] {
    if (this.allCache && this.allCache.end === end && Date.now() - this.allCache.at < ALL_TTL_MS) return this.allCache.value;
    const places = this.db.prepare('SELECT lat, lon FROM era5_daily WHERE date >= ? GROUP BY lat, lon').all(addDays(end, -40)) as unknown as Loc[];
    const value = places.map((p) => this.compute(p, end)).filter((x): x is RecentRain => x !== null);
    this.allCache = { at: Date.now(), end, value };
    return value;
  }

  handler() {
    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/api/recent-rain') return next();
      const end = addDays(new Date().toISOString().slice(0, 10), -1);
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      const one = url.searchParams.has('lat') && url.searchParams.has('lon');
      res.writeHead(one && !(Number.isFinite(lat) && Number.isFinite(lon)) ? 400 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (one) res.end(JSON.stringify(Number.isFinite(lat) && Number.isFinite(lon) ? this.compute({ lat, lon }, end, { weeks: true }) : { error: true, reason: 'lat and lon must be numbers' }));
      else res.end(JSON.stringify({ end, places: this.all(end) }));
    };
  }
}
