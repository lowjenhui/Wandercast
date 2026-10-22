// Sunny windows ("When to go") history in the background, and the weather library.
//
// Sunny windows reads about 11 years of daily ERA5 for one place (src/lib/bestTime.ts). This
// tops that history up, one calendar year per request on the saved-dates budget lane, for:
//   1. destinations on your daydream dates, by trip start (most years are usually stored already
//      by their trip analysis prefetch, so this is mainly the current year), then
//   2. places queued from the weather library ("Download"), then
//   3. popular destinations from Singapore (seed tier 1), shortest flight first. These run after
//      the saved-dates map prefetch (see seeder.ts), so they never hold up your own dates.
//
// The library lists every place with stored history, named from the seed lists (destinations,
// direct-flight cities, capitals, large cities) plus saved and requested places, and how many
// of the years Sunny windows needs are complete.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bestTimeFetchRange } from '../src/lib/bestTime';
import { monthRatings, type MonthRating, type YearMonthStats } from '../src/lib/monthRatings';
import { curatedSeasonalRisks } from '../src/services/seasonalRisks';
import { haversineKm, SIN_AIRPORT } from '../src/lib/geo';
import type { DB } from './db';
import type { SavedRanges } from './savedRanges';
import { kmBetween, type SeedPoint } from './seeder';
import { unitsFor, type Upstream } from './upstream';
import { DAILY_VARS, type Loc, type WeatherCache } from './weatherCache';

/** ERA5 days newer than this are re-fetched by the cache anyway, so readiness stops short. */
const SETTLE_DAYS = 11;
/** A year counts as complete with this share of its days stored. */
const COMPLETE_SHARE = 0.95;
/** Library responses are reused this long (the coverage query scans the whole history table). */
const LIBRARY_TTL_MS = 30_000;
/** Monthly ratings change only as history arrives, so they're recomputed less often. */
const MONTHS_TTL_MS = 10 * 60_000;

const todayUTC = () => new Date().toISOString().slice(0, 10);
function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayCount = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
const key = (l: Loc) => `${l.lat},${l.lon}`;

export interface YearPart {
  year: number;
  start: string;
  end: string;
}

/**
 * One row per city: seed lists can name the same city with coordinates in neighbouring weather
 * cells (e.g. two Koh Samui points 13 km apart). Same name and country within 30 km are merged,
 * keeping the saved one, else the one with more history, else the one first in the download queue.
 */
export function dedupeByName<T extends { name: string; cc: string; lat: number; lon: number; saved: boolean; years: number; priority: number | null }>(places: T[]): T[] {
  const better = (a: T, b: T) => Number(b.saved) - Number(a.saved) || b.years - a.years || (a.priority ?? Infinity) - (b.priority ?? Infinity);
  const kept: T[] = [];
  for (const p of [...places].sort(better)) {
    if (p.cc && kept.some((k) => k.name === p.name && k.cc === p.cc && kmBetween(k, p) < 30)) continue;
    kept.push(p);
  }
  return kept;
}

/** The history Sunny windows reads, by calendar year, clipped to settled ERA5 days. */
export function sunnyParts(today = todayUTC()): YearPart[] {
  const r = bestTimeFetchRange(today);
  const last = addDays(today, -SETTLE_DAYS);
  const parts: YearPart[] = [];
  for (let y = Number(r.start.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    const start = r.start > `${y}-01-01` ? r.start : `${y}-01-01`;
    const end = last < `${y}-12-31` ? last : `${y}-12-31`;
    if (start <= end) parts.push({ year: y, start, end });
  }
  return parts;
}

/** Ready with all but one year complete (the scorer copes with a missing year). */
export const readyYears = (parts: YearPart[]) => Math.max(1, parts.length - 1);

export interface LibraryPlace {
  name: string;
  country: string;
  cc: string;
  lat: number;
  lon: number;
  /** Fare code, when known (saved and requested places). */
  code: string | null;
  /** Complete years of the ones Sunny windows needs. */
  years: number;
  needed: number;
  firstYear: number | null;
  lastYear: number | null;
  status: 'ready' | 'partial' | 'none';
  saved: boolean;
  /** Background state, for queued places that aren't ready. */
  queue: 'downloading' | 'queued' | 'waiting' | null;
  /** Position in the background queue (1 = first), or null for places not on it. */
  priority: number | null;
  /** Reached overland from Singapore (coach, bus or train), alone or beside a flight. */
  overland: boolean;
  /** Typical weather per calendar month (Jan first, Sunny windows scoring); null when nothing is stored. */
  months: (MonthRating | null)[] | null;
}

interface Wanted {
  name: string;
  country: string;
  cc: string;
  lat: number;
  lon: number;
  code: string | null;
  saved: boolean;
  popular: boolean;
}

export interface SunnyProgress {
  years: number;
  needed: number;
  ready: boolean;
  state: 'ready' | 'downloading' | 'queued' | 'waiting';
}

export class SunnyPrefetcher {
  private active: string | null = null;
  private waitingReason: string | null = null;
  private library: { at: number; body: unknown } | null = null;
  private months: { at: number; byLoc: Map<string, YearMonthStats[]> } | null = null;
  private countries: Map<string, string>;
  /** Overland places (public/land-destinations.json), to tag library rows. */
  private overland: { lat: number; lon: number }[] = [];

  constructor(
    private db: DB,
    private cache: WeatherCache,
    private up: Upstream,
    private saved: SavedRanges,
    private seedPoints: () => SeedPoint[],
    publicDir: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS sunny_requests (
      lat REAL NOT NULL, lon REAL NOT NULL, name TEXT NOT NULL, country TEXT NOT NULL, cc TEXT NOT NULL,
      code TEXT, requested_at INTEGER NOT NULL, PRIMARY KEY (lat, lon)
    ) WITHOUT ROWID`);
    this.countries = new Map();
    try {
      const caps = JSON.parse(readFileSync(join(publicDir, 'capitals.json'), 'utf8')) as { name: string; cc: string }[];
      caps.forEach((c) => this.countries.set(c.cc, c.name));
    } catch {
      /* country names fall back to codes */
    }
    try {
      this.overland = (JSON.parse(readFileSync(join(publicDir, 'land-destinations.json'), 'utf8')) as { destinations: { lat: number; lon: number }[] }).destinations;
    } catch {
      /* no overland tags */
    }
  }

  /** Daydream-date destinations (by trip start), library requests (oldest first), then popular
   *  destinations (nearest to Singapore first). */
  private wanted(): Wanted[] {
    const today = todayUTC();
    // list() is ordered by start, end, id: chronological.
    const order = new Map(this.saved.list().filter((r) => r.end >= today).map((r, i) => [r.id, i]));
    const saved = this.saved
      .destinations()
      .filter((d) => order.has(d.range_id))
      .sort((a, b) => order.get(a.range_id)! - order.get(b.range_id)! || a.id - b.id)
      .map((d) => ({ name: d.name, country: d.country, cc: d.cc, lat: d.lat, lon: d.lon, code: d.code || null, saved: true, popular: false }));
    const requested = (this.db.prepare('SELECT * FROM sunny_requests ORDER BY requested_at').all() as unknown as Omit<Wanted, 'saved' | 'popular'>[]).map((r) => ({ ...r, saved: false, popular: false }));
    const fromSin = (l: Loc) => haversineKm(SIN_AIRPORT.lat, SIN_AIRPORT.lon, l.lat, l.lon);
    const popular = this.seedPoints()
      .filter((p) => p.tier === 1)
      .sort((a, b) => fromSin(a) - fromSin(b))
      .map((p) => ({ name: p.name, country: this.countries.get(p.cc) ?? p.cc, cc: p.cc, lat: p.lat, lon: p.lon, code: null, saved: false, popular: true }));
    const seen = new Set<string>();
    return [...saved, ...requested, ...popular].filter((w) => {
      const k = key(this.cache.resolve('era5', w));
      return !seen.has(k) && seen.add(k);
    });
  }

  /** Years still to fetch for a place, newest first. */
  private missing(loc: Loc, parts = sunnyParts()): YearPart[] {
    const r = this.cache.resolve('era5', loc);
    return parts.filter((p) => this.cache.era5Gaps(r, p.start, p.end) > 0).reverse();
  }

  /** One request's worth of work for daydream destinations and library requests (popular: false)
   *  or for popular destinations (popular: true). True if it fetched something. */
  async step(opts: { popular?: boolean } = {}): Promise<boolean> {
    const parts = sunnyParts();
    for (const w of this.wanted()) {
      if (w.popular !== Boolean(opts.popular)) continue;
      const part = this.missing(w, parts)[0];
      if (!part) continue;
      const units = unitsFor(1, dayCount(part.start, part.end), DAILY_VARS.length);
      if (!this.up.canSpend(units, 'saved')) {
        const st = this.up.status();
        this.waitingReason =
          st.savedToday + 50 >= st.limits.savedPerDay || st.today + 50 >= st.limits.perDay - st.limits.interactiveReserve
            ? 'Waiting for the daily weather API allowance to reset (08:00 Singapore time).'
            : 'Waiting for spare API budget.';
        return false;
      }
      this.active = key(this.cache.resolve('era5', w));
      this.waitingReason = null;
      await this.cache.ensureEra5([w], part.start, part.end, { seed: true, lane: 'saved', maxUnitsPerRequest: 240 });
      this.library = null;
      return true;
    }
    this.active = null;
    this.waitingReason = null;
    return false;
  }

  hasWork(opts: { popular?: boolean } = {}): boolean {
    const parts = sunnyParts();
    return this.wanted().some((w) => (opts.popular === undefined || w.popular === opts.popular) && this.missing(w, parts).length > 0);
  }

  private queueState(loc: Loc): 'downloading' | 'queued' | 'waiting' {
    if (this.waitingReason) return 'waiting';
    return this.active === key(this.cache.resolve('era5', loc)) ? 'downloading' : 'queued';
  }

  /** For the compare table: how far a saved destination's Sunny windows history has got. */
  progress(loc: Loc): SunnyProgress {
    const parts = sunnyParts();
    const r = this.cache.resolve('era5', loc);
    const years = parts.filter((p) => this.cache.era5Gaps(r, p.start, p.end) <= dayCount(p.start, p.end) * (1 - COMPLETE_SHARE)).length;
    const needed = parts.length;
    const ready = years >= readyYears(parts);
    return { years, needed, ready, state: ready ? 'ready' : this.queueState(loc) };
  }

  /** Queue a place for download from the library. */
  request(input: Record<string, unknown>): string | null {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lat = num(input.lat);
    const lon = num(input.lon);
    const name = str(input.name);
    const cc = str(input.cc, 2).toUpperCase();
    if (!name || !/^[A-Z]{2}$/.test(cc) || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return 'name, cc, lat and lon are required';
    const r = this.cache.resolve('era5', { lat, lon });
    this.db
      .prepare('INSERT OR IGNORE INTO sunny_requests (lat, lon, name, country, cc, code, requested_at) VALUES (?,?,?,?,?,?,?)')
      .run(r.lat, r.lon, name, str(input.country) || this.countries.get(cc) || cc, cc, str(input.code, 4).toUpperCase() || null, Date.now());
    this.library = null;
    return null;
  }

  /** Every place with stored history (plus saved and requested ones), with its readiness. */
  libraryList(): { needed: number; readyYears: number; places: LibraryPlace[] } {
    const parts = sunnyParts();
    const ready = readyYears(parts);
    // Complete years per stored location, from one pass over the history table.
    const rows = this.db
      .prepare('SELECT lat, lon, substr(date, 1, 4) AS y, COUNT(*) AS n FROM era5_daily WHERE date BETWEEN ? AND ? GROUP BY lat, lon, y')
      .all(parts[0].start, parts[parts.length - 1].end) as { lat: number; lon: number; y: string; n: number }[];
    const stored = new Map<string, { complete: number; years: number[] }>();
    const partByYear = new Map(parts.map((p) => [p.year, p]));
    for (const r of rows) {
      const p = partByYear.get(Number(r.y));
      if (!p) continue;
      const s = stored.get(key(r)) ?? { complete: 0, years: [] };
      s.years.push(p.year);
      if (r.n >= dayCount(p.start, p.end) * COMPLETE_SHARE) s.complete++;
      stored.set(key(r), s);
    }

    const wanted = this.wanted();
    const priority = new Map(wanted.map((w, i) => [key(this.cache.resolve('era5', w)), i + 1]));
    const named = new Map<string, Omit<LibraryPlace, 'years' | 'needed' | 'firstYear' | 'lastYear' | 'status' | 'queue' | 'priority' | 'overland' | 'months'>>();
    for (const w of wanted) {
      const k = key(this.cache.resolve('era5', w));
      if (!named.has(k)) named.set(k, { name: w.name, country: w.country, cc: w.cc, lat: w.lat, lon: w.lon, code: w.code, saved: w.saved });
    }
    for (const p of this.seedPoints()) {
      const k = key(this.cache.resolve('era5', p));
      if (!named.has(k) && stored.has(k)) named.set(k, { name: p.name, country: this.countries.get(p.cc) ?? p.cc, cc: p.cc, lat: p.lat, lon: p.lon, code: null, saved: false });
    }
    // Stored places no list names (e.g. a search for a small town): labelled by coordinates.
    for (const k of stored.keys()) {
      if (named.has(k)) continue;
      const [lat, lon] = k.split(',').map(Number);
      const label = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
      named.set(k, { name: label, country: '', cc: '', lat, lon, code: null, saved: false });
    }

    const monthly = this.monthlyStats(parts);
    const places: LibraryPlace[] = [...named.entries()].map(([k, n]) => {
      const s = stored.get(k);
      const m = monthly.get(k);
      const years = s?.complete ?? 0;
      const status: LibraryPlace['status'] = years >= ready ? 'ready' : s ? 'partial' : 'none';
      return {
        ...n,
        years,
        needed: parts.length,
        firstYear: s ? Math.min(...s.years) : null,
        lastYear: s ? Math.max(...s.years) : null,
        status,
        queue: status !== 'ready' && priority.has(k) ? this.queueState(n) : null,
        priority: priority.get(k) ?? null,
        // Within 15 km, so Singapore itself (about 20 km from Johor Bahru) isn't tagged.
        overland: n.cc !== 'SG' && this.overland.some((l) => kmBetween(l, n) < 15),
        months: m ? monthRatings(m, (month) => curatedSeasonalRisks.risksFor({ countryCode: n.cc, latitude: n.lat, longitude: n.lon } as Parameters<typeof curatedSeasonalRisks.risksFor>[0], [month])) : null,
      };
    });
    return { needed: parts.length, readyYears: ready, places: dedupeByName(places) };
  }

  /** Rainfall, temperature and humidity per stored location and year-month, over Sunny windows' history. */
  private monthlyStats(parts: YearPart[]): Map<string, YearMonthStats[]> {
    if (this.months && Date.now() - this.months.at < MONTHS_TTL_MS) return this.months.byLoc;
    const rows = this.db
      .prepare(
        `SELECT lat, lon, substr(date, 1, 7) AS ym, COUNT(precip) AS valid, SUM(precip >= 1) AS wet, SUM(precip >= 20) AS heavy,
                AVG(tmax) AS tMax, AVG(tmin) AS tMin, AVG(rh) AS rh
         FROM era5_daily WHERE date BETWEEN ? AND ? GROUP BY lat, lon, ym`,
      )
      .all(parts[0].start, parts[parts.length - 1].end) as unknown as (YearMonthStats & { lat: number; lon: number })[];
    const byLoc = new Map<string, YearMonthStats[]>();
    for (const r of rows) {
      const k = key(r);
      if (!byLoc.has(k)) byLoc.set(k, []);
      byLoc.get(k)!.push({ ym: r.ym, valid: r.valid, wet: r.wet ?? 0, heavy: r.heavy ?? 0, tMax: r.tMax, tMin: r.tMin, rh: r.rh });
    }
    this.months = { at: Date.now(), byLoc };
    return byLoc;
  }

  /** GET /api/library, POST /api/library/download. */
  handler() {
    const send = (res: ServerResponse, status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    return async (req: IncomingMessage, res: ServerResponse, next: () => void, onQueued: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/api/library' && req.method === 'GET') {
        if (!this.library || Date.now() - this.library.at > LIBRARY_TTL_MS) this.library = { at: Date.now(), body: this.libraryList() };
        return send(res, 200, this.library.body);
      }
      if (url.pathname === '/api/library/download' && req.method === 'POST') {
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const err = this.request(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
          if (err) return send(res, 400, { error: true, reason: err });
          onQueued();
          return send(res, 202, { queued: true });
        } catch (e) {
          return send(res, 400, { error: true, reason: (e as Error).message });
        }
      }
      next();
    };
  }
}
