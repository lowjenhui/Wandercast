// HTTP routes mirroring Open-Meteo's endpoints under /api/om/*, served from the cache.
//
//   /api/om/archive      ERA5 daily history  → era5_daily table (permanent)
//                        ?stored=1: database only; places not stored yet come back with
//                        `missing: true` and are queued for background fetching
// Multi-location responses are per location: a place the API couldn't fetch is marked
// `missing` with a `reason`, and every stored place is still returned.
//   /api/om/forecast     daily forecast      → forecast_daily table (3 h)
//                        current conditions  → response_cache (15 min)
//   /api/om/air-quality  current air quality → response_cache (30 min)
//   /api/om/status       cache and budget statistics
// Requests for a past trip (X-Wandercast-Archive) never call the API: archive and forecast days
// are served as stored.
// Requests the cache doesn't understand are passed through (still metered).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Seeder } from './seeder';
import type { WantedQueue } from './wanted';
import { archiveRangeOf } from './tripArchive';
import { UpstreamError, unitsFor } from './upstream';
import { dateRange, isDailyVarList, NOW_VARS, type NowKind, type DailyVar, type Loc, type WeatherCache } from './weatherCache';

const UPSTREAM: Record<string, string> = {
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  'air-quality': 'https://air-quality-api.open-meteo.com/v1/air-quality',
};

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function parseLocs(q: URLSearchParams): Loc[] {
  const lats = (q.get('latitude') ?? '').split(',').filter(Boolean).map(Number);
  const lons = (q.get('longitude') ?? '').split(',').filter(Boolean).map(Number);
  if (!lats.length || lats.length !== lons.length || [...lats, ...lons].some((x) => !Number.isFinite(x))) {
    throw new UpstreamError('latitude and longitude must be equal-length numeric lists', 400);
  }
  return lats.map((lat, i) => ({ lat, lon: lons[i] }));
}

const one = (arr: unknown[]) => (arr.length === 1 ? arr[0] : arr);

export function createHandler(cache: WeatherCache, seeder: Seeder, wanted?: WantedQueue) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const m = url.pathname.match(/^\/api\/om\/(archive|forecast|air-quality|status)$/);
    if (!m) return next();
    const route = m[1];
    const q = url.searchParams;
    try {
      if (route === 'status') return send(res, 200, { cache: cache.stats(), budget: cache.up.status(), seeding: seeder.status(), wanted: wanted?.status() });

      const locs = parseLocs(q);
      const daily = q.get('daily');
      const start = q.get('start_date');
      const end = q.get('end_date');

      // ERA5 daily history.
      if (route === 'archive' && q.get('models') === 'era5' && q.get('timezone') === 'auto' && isDailyVarList(daily) && start && end && !q.has('hourly')) {
        // Past trips (archive header) are shown from stored data only, without queueing fetches.
        const archived = archiveRangeOf(req) !== null;
        const storedOnly = archived || q.get('stored') === '1';
        const vars = daily.split(',') as DailyVar[];
        // Snowfall alone never holds up a request (Copernicus days and older Open-Meteo days don't
        // have it): what's stored is served now, and the blanks are queued for the background.
        const needed = vars.filter((v) => v !== 'snowfall_sum');
        const { errors } = storedOnly ? { errors: [] } : await cache.ensureEra5(locs, start, end, { settle: true, vars: needed });
        const resolved = locs.map((l) => cache.resolve('era5', l));
        const gaps = resolved.map((l) => cache.era5Gaps(l, start, end, needed));
        if (!archived && needed.length < vars.length) {
          const blank = resolved.filter((l, i) => gaps[i] === 0 && cache.era5Gaps(l, start, end, vars) > 0);
          if (blank.length) wanted?.add(blank, start, end, { snowfall: true });
        }
        // A single-place request (the trip analysis) keeps the plain error, so it can retry.
        if (errors.length && locs.length === 1 && gaps[0] > 0) throw errors[0];
        if (storedOnly && !archived) {
          const need = resolved.filter((_, i) => gaps[i] > 0);
          // Feels-like asked for: the background fetch must bring every variable, not just the basics.
          if (need.length) wanted?.add(need, start, end, { snowfall: needed.includes('apparent_temperature_max') });
        }
        const reason = errors[0]?.message ?? 'Not stored yet; queued for background download.';
        return send(
          res,
          200,
          one(resolved.map((l, i) => ({ ...(cache.readEra5(l, start, end, vars) as object), ...(gaps[i] > 0 ? { missing: true, reason } : {}) }))),
        );
      }

      // Daily forecast for a date range within the 16-day horizon.
      if (route === 'forecast' && isDailyVarList(daily) && start && end && !q.has('hourly') && !q.has('current')) {
        const { errors } = archiveRangeOf(req) !== null ? { errors: [] } : await cache.ensureForecast(locs, start, end, { settle: true });
        const vars = daily.split(',') as DailyVar[];
        const resolved = locs.map((l) => cache.resolve('forecast', l));
        const stale = resolved.map((l) => !cache.forecastFresh(l, start, end));
        if (errors.length && locs.length === 1 && stale[0]) throw errors[0];
        return send(
          res,
          200,
          one(resolved.map((l, i) => ({ ...(cache.readForecast(l, start, end, vars) as object), ...(stale[i] && errors.length ? { missing: true, reason: errors[0].message } : {}) }))),
        );
      }

      // "Right now": served only from stored hourly data. The API is called only when the user
      // presses Reload (refresh=1), and then only for places loaded more than an hour ago.
      if ((route === 'forecast' || route === 'air-quality') && q.has('current') && !daily && !q.has('hourly')) {
        const kind: NowKind = route === 'forecast' ? 'forecast' : 'air';
        const vars = (q.get('current') ?? '').split(',').filter(Boolean);
        if (vars.length && vars.every((v) => (NOW_VARS[kind] as readonly string[]).includes(v))) {
          if (q.get('refresh') === '1') await cache.ensureToday(kind, locs, { maxAgeMs: 60 * 60_000 });
          return send(res, 200, one(locs.map((l) => cache.readNow(kind, l, vars))));
        }
      }

      // Other current-condition queries: short per-location cache.
      if ((route === 'forecast' || route === 'air-quality') && q.has('current') && !daily && !q.has('hourly')) {
        const params = new URLSearchParams(q);
        params.delete('latitude');
        params.delete('longitude');
        const kind = route === 'forecast' ? 'forecast' : 'air';
        const out = await cache.cachedCurrent(kind, locs, params, kind === 'forecast' ? 15 * 60_000 : 30 * 60_000);
        return send(res, 200, one(out));
      }

      // Anything else: metered pass-through without caching.
      const days = start && end ? dateRange(start, end).length : Number(q.get('forecast_days') ?? 7);
      const vars = [daily, q.get('hourly'), q.get('current')].filter(Boolean).join(',').split(',').length;
      const data = await cache.up.fetchJson(`${UPSTREAM[route]}?${q}`, unitsFor(locs.length, days, vars));
      return send(res, 200, data);
    } catch (e) {
      const status = e instanceof UpstreamError ? e.status : 500;
      const retry = e instanceof UpstreamError && e.retryAfter ? e.retryAfter : 20;
      return send(res, status, { error: true, reason: (e as Error).message, retryAfter: status === 429 ? retry : undefined }, status === 429 ? { 'Retry-After': String(retry) } : {});
    }
  };
}
