// Weather cache in front of Open-Meteo.
//
// History (ERA5) is stored day by day per location, so any overlapping date range is served
// from the database and only genuinely missing days are fetched. Forecasts are stored per
// day for 3 hours; current conditions and air quality per location for 15–30 minutes.

import { CDS_BLANK, type DB } from './db';
import { UpstreamError, unitsFor, type Upstream } from './upstream';

// Every fetch asks for all of these (7 variables cost the same as 4: Open-Meteo meters per 10).
export const DAILY_VARS = [
  'precipitation_sum',
  'temperature_2m_max',
  'temperature_2m_min',
  'relative_humidity_2m_mean',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'snowfall_sum',
] as const;
type DailyVar = (typeof DAILY_VARS)[number];
const COL: Record<DailyVar, string> = {
  precipitation_sum: 'precip',
  temperature_2m_max: 'tmax',
  temperature_2m_min: 'tmin',
  relative_humidity_2m_mean: 'rh',
  apparent_temperature_max: 'atmax',
  apparent_temperature_min: 'atmin',
  snowfall_sum: 'snow',
};
const UNITS: Record<DailyVar, string> = {
  precipitation_sum: 'mm',
  temperature_2m_max: '°C',
  temperature_2m_min: '°C',
  relative_humidity_2m_mean: '%',
  apparent_temperature_max: '°C',
  apparent_temperature_min: '°C',
  snowfall_sum: 'cm',
};
/** Added later: days stored before then have NULLs, so a request for them refetches those days. */
const LATE_VARS: readonly DailyVar[] = ['apparent_temperature_max', 'apparent_temperature_min', 'snowfall_sum'];
const COLS = DAILY_VARS.map((v) => COL[v]).join(', ');
/** SQL condition for a stored day having every requested variable. Copernicus days (source
 *  'cds') leave out what it can't provide, so for them every requested variable is checked. */
function storedCond(vars?: readonly DailyVar[]): string {
  const late = (vars ?? []).filter((v) => LATE_VARS.includes(v)).map((v) => `${COL[v]} IS NOT NULL`);
  const rest = (vars ?? []).filter((v) => !LATE_VARS.includes(v)).map((v) => `${COL[v]} IS NOT NULL`);
  const conds = [...late, ...(rest.length ? [`(source IS NOT 'cds' OR (${rest.join(' AND ')}))`] : [])];
  return conds.length ? ` AND ${conds.join(' AND ')}` : '';
}
/** On a Copernicus day, Open-Meteo only fills blanks; any other day it replaces. */
const UPSERT_SET = [
  ...DAILY_VARS.map((v) => `${COL[v]} = CASE WHEN era5_daily.source = 'cds' THEN COALESCE(era5_daily.${COL[v]}, excluded.${COL[v]}) ELSE excluded.${COL[v]} END`),
  `source = CASE WHEN era5_daily.source = 'cds' THEN 'cds' ELSE 'om' END`,
].join(', ');

export const FORECAST_TTL_MS = 6 * 3600_000; // models update about every 6 h
/** Hourly data for the "Right now" map is fetched for 48 h and refreshed after this long. */
export const TODAY_TTL_MS = 12 * 3600_000;

/** Variables the "Right now" map uses; each is available hourly with the same name. */
export const NOW_VARS = {
  forecast: ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'visibility', 'is_day'],
  air: ['pm2_5', 'pm10', 'us_aqi', 'dust', 'aerosol_optical_depth'],
} as const;
export type NowKind = keyof typeof NOW_VARS;

interface HourlyBody {
  latitude: number;
  longitude: number;
  elevation?: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation?: string;
  hourly: { time: string[] } & Record<string, (number | null)[]>;
}
export const FORECAST_DAYS = 16;
/** Past days fetched with each forecast: they bridge the gap until ERA5 settles, for the recent
 *  rain signal. 12 + 16 days still costs the same 2 units as 16 alone. */
export const FORECAST_PAST_DAYS = 12;
/** Past forecast days kept, so the last 30 days are covered even where ERA5 lags. */
const FORECAST_KEEP_DAYS = 35;
/** ERA5 days younger than this may still be missing or preliminary, so they are not stored. */
const ERA5_SETTLE_DAYS = 10;

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';

export interface Loc {
  lat: number;
  lon: number;
}

/** Locations are keyed at 0.01° (~1 km); ERA5's grid is ~25 km, so nothing is lost. */
export const roundLoc = (l: Loc): Loc => ({ lat: Math.round(l.lat * 100) / 100, lon: Math.round(l.lon * 100) / 100 });

function addDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
const todayUTC = () => new Date().toISOString().slice(0, 10);

interface DailyResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation?: string;
  daily?: { time: string[] } & Partial<Record<DailyVar, (number | null)[]>>;
}

interface Meta {
  grid_lat: number;
  grid_lon: number;
  elevation: number | null;
  utc_offset: number;
  timezone: string;
  tz_abbr: string | null;
}

/** Requests within this distance of an already-stored place reuse its data. */
const REUSE_KM = 10;

function distKm(a: Loc, b: Loc) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export class WeatherCache {
  constructor(
    private db: DB,
    readonly up: Upstream,
  ) {}

  /**
   * Snap a requested location to the nearest place already stored (within REUSE_KM), so a
   * geocoded "Kaohsiung City" reuses history saved for the seeded "Kaohsiung". ERA5 cells are
   * ~25 km wide, so this doesn't change which data is returned in practice.
   */
  resolve(kind: 'era5' | 'forecast', loc: Loc): Loc {
    const r = roundLoc(loc);
    const rows = this.db
      .prepare('SELECT lat, lon FROM point_meta WHERE kind = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
      .all(kind, r.lat - 0.1, r.lat + 0.1, r.lon - 0.12, r.lon + 0.12) as unknown as Loc[];
    let best: Loc | null = null;
    let bestD = REUSE_KM;
    for (const p of rows) {
      const d = distKm(r, p);
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    return best ?? r;
  }

  private coordQuery(locs: Loc[]) {
    return { latitude: locs.map((l) => l.lat.toFixed(2)).join(','), longitude: locs.map((l) => l.lon.toFixed(2)).join(',') };
  }

  private saveMeta(kind: string, loc: Loc, r: DailyResponse | Record<string, unknown>) {
    const x = r as DailyResponse;
    this.db
      .prepare('INSERT OR REPLACE INTO point_meta (kind, lat, lon, grid_lat, grid_lon, elevation, utc_offset, timezone, tz_abbr) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(kind, loc.lat, loc.lon, x.latitude, x.longitude, x.elevation ?? null, x.utc_offset_seconds ?? 0, x.timezone ?? 'GMT', x.timezone_abbreviation ?? null);
  }

  private meta(kind: string, loc: Loc): Meta | undefined {
    return this.db.prepare('SELECT grid_lat, grid_lon, elevation, utc_offset, timezone, tz_abbr FROM point_meta WHERE kind = ? AND lat = ? AND lon = ?').get(kind, loc.lat, loc.lon) as
      | Meta
      | undefined;
  }

  private buildDaily(kind: string, loc: Loc, rows: Record<string, number | string | null>[], vars: DailyVar[]) {
    const m = this.meta(kind, loc);
    const daily: Record<string, unknown[]> = { time: rows.map((r) => r.date) };
    for (const v of vars) daily[v] = rows.map((r) => r[COL[v]] ?? null);
    return {
      latitude: m?.grid_lat ?? loc.lat,
      longitude: m?.grid_lon ?? loc.lon,
      generationtime_ms: 0,
      utc_offset_seconds: m?.utc_offset ?? 0,
      timezone: m?.timezone ?? 'GMT',
      timezone_abbreviation: m?.tz_abbr ?? undefined,
      elevation: m?.elevation ?? undefined,
      daily_units: Object.fromEntries([['time', 'iso8601'], ...vars.map((v) => [v, UNITS[v]])]),
      daily,
      cached: true,
    };
  }

  // ---------------------------------------------------------------- ERA5 history

  /**
   * First and last missing day for a location within [start, end], or null if complete. With
   * `vars`, a stored day lacking one of the later-added variables counts as missing.
   */
  era5Missing(loc: Loc, start: string, end: string, vars?: readonly DailyVar[]): { from: string; to: string } | null {
    const settled = addDays(todayUTC(), -ERA5_SETTLE_DAYS);
    const have = new Set(
      (this.db.prepare(`SELECT date FROM era5_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ?${storedCond(vars)}`).all(loc.lat, loc.lon, start, end) as { date: string }[]).map(
        (r) => r.date,
      ),
    );
    // Days after the settle cutoff are always refetched (they may have been preliminary).
    const missing = dateRange(start, end).filter((d) => !have.has(d) || d > settled);
    return missing.length ? { from: missing[0], to: missing[missing.length - 1] } : null;
  }

  /** Settled days (older than the ERA5 settle cutoff) not yet stored for a location. */
  era5Gaps(loc: Loc, start: string, end: string, vars?: readonly DailyVar[]): number {
    const settled = addDays(todayUTC(), -ERA5_SETTLE_DAYS);
    const last = end < settled ? end : settled;
    if (last < start) return 0;
    const n = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM era5_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ?${storedCond(vars)}`).get(loc.lat, loc.lon, start, last) as { n: number }
    ).n;
    return dateRange(start, last).length - n;
  }

  /** Upstream fetches in progress, per location and range, so concurrent callers share them. */
  private inflight = new Map<string, Promise<void>>();

  /**
   * Fetch and store missing ERA5 days. Each group of locations is its own upstream request; with
   * `settle`, a failing group doesn't stop the others and the errors are returned instead of
   * thrown, so callers can still serve every location that is stored.
   */
  async ensureEra5(
    locsIn: Loc[],
    start: string,
    end: string,
    opts: { seed?: boolean; lane?: 'saved'; maxUnitsPerRequest?: number; settle?: boolean; vars?: readonly DailyVar[] } = {},
  ): Promise<{ errors: UpstreamError[] }> {
    const locs = [...new Map(locsIn.map((l) => this.resolve('era5', l)).map((l) => [`${l.lat},${l.lon}`, l])).values()];
    const errors: UpstreamError[] = [];
    const waits: Promise<void>[] = [];
    const groups = new Map<string, Loc[]>();
    for (const l of locs) {
      const miss = this.era5Missing(l, start, end, opts.vars);
      if (!miss) continue;
      const key = `${miss.from}|${miss.to}`;
      const running = this.inflight.get(`${l.lat},${l.lon}|${key}`);
      if (running) {
        waits.push(running.catch(() => undefined));
        continue;
      }
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    const maxUnits = opts.maxUnitsPerRequest ?? (opts.seed ? 240 : 450);
    for (const [key, group] of groups) {
      const [from, to] = key.split('|');
      const days = dateRange(from, to).length;
      const perLoc = unitsFor(1, days, DAILY_VARS.length);
      const chunk = Math.max(1, Math.floor(maxUnits / perLoc));
      for (let i = 0; i < group.length; i += chunk) {
        const part = group.slice(i, i + chunk);
        const params = new URLSearchParams({ ...this.coordQuery(part), start_date: from, end_date: to, daily: DAILY_VARS.join(','), models: 'era5', timezone: 'auto' });
        const job = this.up
          .fetchJson<DailyResponse | DailyResponse[]>(`${ARCHIVE}?${params}`, perLoc * part.length, { seed: opts.seed, lane: opts.lane, maxWaitMs: opts.seed ? 0 : undefined })
          .then((data) => this.storeEra5(part, Array.isArray(data) ? data : [data]));
        const keys = part.map((l) => `${l.lat},${l.lon}|${key}`);
        keys.forEach((k) => this.inflight.set(k, job));
        try {
          await job;
        } catch (e) {
          const err = e instanceof UpstreamError ? e : new UpstreamError((e as Error).message, 502);
          if (!opts.settle) throw err;
          errors.push(err);
          // Out of budget or rate-limited: the remaining groups would fail the same way.
          if (err.status === 429) break;
        } finally {
          keys.forEach((k) => this.inflight.get(k) === job && this.inflight.delete(k));
        }
      }
      if (errors.some((e) => e.status === 429)) break;
    }
    await Promise.all(waits);
    return { errors };
  }

  private storeEra5(locs: Loc[], arr: DailyResponse[]) {
    const settled = addDays(todayUTC(), -ERA5_SETTLE_DAYS);
    const ins = this.db.prepare(
      `INSERT INTO era5_daily (lat, lon, date, ${COLS}, source) VALUES (?,?,?${',?'.repeat(DAILY_VARS.length)},'om') ON CONFLICT (lat, lon, date) DO UPDATE SET ${UPSERT_SET}`,
    );
    this.db.exec('BEGIN');
    try {
      arr.forEach((r, i) => {
        const loc = locs[i];
        if (!loc || !r.daily) return;
        this.saveMeta('era5', loc, r);
        r.daily.time.forEach((date, j) => {
          const vals = DAILY_VARS.map((v) => r.daily![v]?.[j] ?? null);
          if (date > settled && vals.every((v) => v === null)) return; // not published yet
          ins.run(loc.lat, loc.lon, date, ...vals);
        });
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Where the seeder's Copernicus blank-filling has got to (see cdsBlank). */
  private cdsCursor: [number, number, string] = [-999, -999, ''];

  /**
   * The next Copernicus-imported place and calendar year with a blank Open-Meteo can fill
   * (snowfall), for the seeder. After trying it, the seeder calls cdsBlankDone, so each
   * place-year is tried once per server run and one Open-Meteo can't fill isn't retried in a loop.
   */
  cdsBlank(): { loc: Loc; start: string; end: string } | null {
    const r = this.db
      .prepare(`SELECT lat, lon, date FROM era5_daily WHERE source = 'cds' AND (${CDS_BLANK}) AND (lat, lon, date) > (?, ?, ?) ORDER BY lat, lon, date LIMIT 1`)
      .get(...this.cdsCursor) as { lat: number; lon: number; date: string } | undefined;
    if (!r) return null;
    const y = r.date.slice(0, 4);
    const settled = addDays(todayUTC(), -ERA5_SETTLE_DAYS);
    return { loc: { lat: r.lat, lon: r.lon }, start: r.date, end: `${y}-12-31` < settled ? `${y}-12-31` : settled };
  }

  cdsBlankDone(b: { loc: Loc; start: string }) {
    this.cdsCursor = [b.loc.lat, b.loc.lon, `${b.start.slice(0, 4)}-12-31`];
  }

  readEra5(loc: Loc, start: string, end: string, vars: DailyVar[]) {
    const rows = this.db
      .prepare(`SELECT date, ${COLS} FROM era5_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ? ORDER BY date`)
      .all(loc.lat, loc.lon, start, end) as Record<string, number | string | null>[];
    return this.buildDaily('era5', loc, rows, vars);
  }

  // ---------------------------------------------------------------- daily forecast

  forecastFresh(loc: Loc, start: string, end: string): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n, MIN(fetched_at) AS oldest FROM forecast_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ?')
      .get(loc.lat, loc.lon, start, end) as { n: number; oldest: number | null };
    return row.n === dateRange(start, end).length && row.oldest !== null && Date.now() - row.oldest < FORECAST_TTL_MS;
  }

  /** Refresh the full 16-day daily forecast for locations whose stored forecast is stale. */
  async ensureForecast(locsIn: Loc[], start: string, end: string, opts: { seed?: boolean; lane?: 'saved'; settle?: boolean } = {}): Promise<{ errors: UpstreamError[] }> {
    if (opts.settle) {
      try {
        await this.ensureForecast(locsIn, start, end, { ...opts, settle: false });
        return { errors: [] };
      } catch (e) {
        return { errors: [e instanceof UpstreamError ? e : new UpstreamError((e as Error).message, 502)] };
      }
    }
    const unique = [...new Map(locsIn.map((l) => this.resolve('forecast', l)).map((l) => [`${l.lat},${l.lon}`, l])).values()];
    const stale = unique.filter((l) => !this.forecastFresh(l, start, end));
    const perLoc = unitsFor(1, FORECAST_PAST_DAYS + FORECAST_DAYS, DAILY_VARS.length);
    const chunk = opts.seed ? 60 : 100;
    for (let i = 0; i < stale.length; i += chunk) {
      const part = stale.slice(i, i + chunk);
      const params = new URLSearchParams({ ...this.coordQuery(part), forecast_days: String(FORECAST_DAYS), past_days: String(FORECAST_PAST_DAYS), daily: DAILY_VARS.join(','), timezone: 'auto' });
      const data = await this.up.fetchJson<DailyResponse | DailyResponse[]>(`${FORECAST}?${params}`, perLoc * part.length, { seed: opts.seed, lane: opts.lane, maxWaitMs: opts.seed ? 0 : undefined });
      const arr = Array.isArray(data) ? data : [data];
      const now = Date.now();
      const ins = this.db.prepare(`INSERT OR REPLACE INTO forecast_daily (lat, lon, date, ${COLS}, fetched_at) VALUES (?,?,?${',?'.repeat(DAILY_VARS.length)},?)`);
      this.db.exec('BEGIN');
      arr.forEach((r, j) => {
        const loc = part[j];
        if (!loc || !r.daily) return;
        this.saveMeta('forecast', loc, r);
        r.daily.time.forEach((date, k) => ins.run(loc.lat, loc.lon, date, ...DAILY_VARS.map((v) => r.daily![v]?.[k] ?? null), now));
      });
      this.db.exec('COMMIT');
    }
    return { errors: [] };
  }

  readForecast(loc: Loc, start: string, end: string, vars: DailyVar[]) {
    const rows = this.db
      .prepare(`SELECT date, ${COLS} FROM forecast_daily WHERE lat = ? AND lon = ? AND date BETWEEN ? AND ? ORDER BY date`)
      .all(loc.lat, loc.lon, start, end) as Record<string, number | string | null>[];
    return this.buildDaily('forecast', loc, rows, vars);
  }

  // ---------------------------------------------------------------- short-lived responses

  /**
   * Per-location cache for current conditions / air quality. `params` excludes coordinates;
   * missing locations are fetched together in one upstream request.
   */
  async cachedCurrent(kind: 'forecast' | 'air', locsIn: Loc[], params: URLSearchParams, ttlMs: number, opts: { seed?: boolean } = {}): Promise<unknown[]> {
    const locs = locsIn.map(roundLoc);
    const sorted = new URLSearchParams([...params].sort(([a], [b]) => a.localeCompare(b))).toString();
    const keyOf = (l: Loc) => `${kind}|${l.lat}|${l.lon}|${sorted}`;
    const now = Date.now();
    const get = this.db.prepare('SELECT body FROM response_cache WHERE key = ? AND expires_at > ?');
    const out: unknown[] = locs.map((l) => {
      const row = get.get(keyOf(l), now) as { body: string } | undefined;
      return row ? JSON.parse(row.body) : undefined;
    });
    const missingIdx = out.map((v, i) => (v === undefined ? i : -1)).filter((i) => i >= 0);
    const variables = (params.get('current') ?? '').split(',').filter(Boolean).length;
    for (let s = 0; s < missingIdx.length; s += 100) {
      const idx = missingIdx.slice(s, s + 100);
      const part = idx.map((i) => locs[i]);
      const q = new URLSearchParams(params);
      const c = this.coordQuery(part);
      q.set('latitude', c.latitude);
      q.set('longitude', c.longitude);
      const data = await this.up.fetchJson<unknown>(`${kind === 'air' ? AIR : FORECAST}?${q}`, unitsFor(part.length, 1, variables), { seed: opts.seed, maxWaitMs: opts.seed ? 0 : undefined });
      const arr = (Array.isArray(data) ? data : [data]) as unknown[];
      const put = this.db.prepare('INSERT OR REPLACE INTO response_cache (key, body, fetched_at, expires_at) VALUES (?,?,?,?)');
      arr.forEach((r, j) => {
        out[idx[j]] = r;
        put.run(keyOf(part[j]), JSON.stringify(r), Date.now(), Date.now() + ttlMs);
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- today's hourly data ("Right now")

  private nearestHourly(kind: NowKind, loc: Loc): { lat: number; lon: number; fetched_at: number; body: string } | null {
    const r = roundLoc(loc);
    const rows = this.db
      .prepare('SELECT lat, lon, fetched_at, body FROM hourly_cache WHERE kind = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
      .all(kind, r.lat - 0.1, r.lat + 0.1, r.lon - 0.12, r.lon + 0.12) as { lat: number; lon: number; fetched_at: number; body: string }[];
    let best: (typeof rows)[number] | null = null;
    let bestD = REUSE_KM;
    for (const row of rows) {
      const d = distKm(r, row);
      if (d <= bestD) {
        best = row;
        bestD = d;
      }
    }
    return best;
  }

  /** Index of the current local hour in a stored body, or -1. */
  private hourIndex(body: HourlyBody): number {
    const local = new Date(Date.now() + body.utc_offset_seconds * 1000).toISOString().slice(0, 13) + ':00';
    return body.hourly.time.indexOf(local);
  }

  /**
   * Stored data covers 48 h from local midnight on the day it was fetched, so anything fetched
   * within the last 12 h always contains the current hour.
   */
  todayFresh(kind: NowKind, loc: Loc, maxAgeMs = TODAY_TTL_MS): boolean {
    const r = roundLoc(loc);
    const row = this.db
      .prepare('SELECT MAX(fetched_at) AS t FROM hourly_cache WHERE kind = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
      .get(kind, r.lat - 0.05, r.lat + 0.05, r.lon - 0.05, r.lon + 0.05) as { t: number | null };
    return row.t !== null && Date.now() - row.t < maxAgeMs;
  }

  /** Fetch 48 h of hourly data (one call per place) for places without a fresh copy. */
  async ensureToday(kind: NowKind, locsIn: Loc[], opts: { seed?: boolean; maxAgeMs?: number } = {}) {
    const stale = [...new Map(locsIn.map(roundLoc).map((l) => [`${l.lat},${l.lon}`, l])).values()].filter((l) => !this.todayFresh(kind, l, opts.maxAgeMs));
    const vars = NOW_VARS[kind];
    for (let i = 0; i < stale.length; i += 100) {
      const part = stale.slice(i, i + 100);
      const params = new URLSearchParams({ ...this.coordQuery(part), hourly: vars.join(','), forecast_days: '2', timezone: 'auto' });
      const data = await this.up.fetchJson<HourlyBody | HourlyBody[]>(`${kind === 'air' ? AIR : FORECAST}?${params}`, unitsFor(part.length, 2, vars.length), {
        seed: opts.seed,
        maxWaitMs: opts.seed ? 0 : undefined,
      });
      const arr = Array.isArray(data) ? data : [data];
      const put = this.db.prepare('INSERT OR REPLACE INTO hourly_cache (kind, lat, lon, fetched_at, body) VALUES (?,?,?,?,?)');
      this.db.exec('BEGIN');
      arr.forEach((r, j) => part[j] && r.hourly && put.run(kind, part[j].lat, part[j].lon, Date.now(), JSON.stringify(r)));
      this.db.exec('COMMIT');
    }
  }

  /**
   * A `current`-shaped response for the current local hour, built from stored hourly data.
   * When the stored 48 h no longer cover the current hour, the hour it was loaded is used
   * instead (`snapshot: true`), so the map still shows what was loaded, with its date.
   */
  readNow(kind: NowKind, loc: Loc, vars: string[]): unknown {
    const row = this.nearestHourly(kind, loc);
    if (!row) return null;
    const body = JSON.parse(row.body) as HourlyBody;
    let i = this.hourIndex(body);
    const snapshot = i < 0;
    if (snapshot) {
      const loaded = new Date(row.fetched_at + body.utc_offset_seconds * 1000).toISOString().slice(0, 13) + ':00';
      i = body.hourly.time.indexOf(loaded);
      if (i < 0) return null;
    }
    const current: Record<string, unknown> = { time: body.hourly.time[i], interval: 3600 };
    for (const v of vars) current[v] = body.hourly[v]?.[i] ?? null;
    return {
      latitude: body.latitude,
      longitude: body.longitude,
      elevation: body.elevation,
      utc_offset_seconds: body.utc_offset_seconds,
      timezone: body.timezone,
      timezone_abbreviation: body.timezone_abbreviation,
      current,
      source: 'hourly-forecast',
      fetched_at: row.fetched_at,
      snapshot,
    };
  }

  pruneExpired() {
    this.db.prepare('DELETE FROM hourly_cache WHERE fetched_at < ?').run(Date.now() - 3 * 24 * 3600_000);
    this.db.prepare('DELETE FROM response_cache WHERE expires_at < ?').run(Date.now());
    this.db.prepare('DELETE FROM forecast_daily WHERE date < ?').run(addDays(todayUTC(), -FORECAST_KEEP_DAYS));
  }

  stats() {
    const era5 = this.db.prepare('SELECT COUNT(*) AS days, COUNT(DISTINCT lat || \',\' || lon) AS places FROM era5_daily').get() as { days: number; places: number };
    const fc = this.db.prepare('SELECT COUNT(DISTINCT lat || \',\' || lon) AS places FROM forecast_daily WHERE fetched_at > ?').get(Date.now() - FORECAST_TTL_MS) as { places: number };
    const rc = this.db.prepare('SELECT COUNT(*) AS n FROM response_cache WHERE expires_at > ?').get(Date.now()) as { n: number };
    const today = this.db.prepare("SELECT COUNT(*) AS n FROM hourly_cache WHERE kind = 'forecast' AND fetched_at > ?").get(Date.now() - TODAY_TTL_MS) as { n: number };
    return { historyDays: era5.days, historyPlaces: era5.places, forecastPlaces: fc.places, liveResponses: rc.n, todayPlaces: today.n };
  }
}

export function isDailyVarList(s: string | null): s is string {
  if (!s) return false;
  return s.split(',').every((v) => (DAILY_VARS as readonly string[]).includes(v));
}
export type { DailyVar };
