// Vite plugin: mounts the weather cache API (/api/om/*) and the fare caches (/api/fares/*,
// /api/live-fares/*), and
// starts the background seeder and fare prefetch in both `vite` (dev) and `vite preview`.
// The database lives in data/weather.db.

import { join } from 'node:path';
import type { Plugin } from 'vite';
import { CalendarStore } from './calendar';
import { createCalendarHandler } from './calendarHandler';
import { AdvisoryStore } from './advisories';
import { AlertStore } from './alerts';
import { openDb } from './db';
import { DestinationPrefetcher } from './destPrefetch';
import { EnsoStore } from './enso';
import { FareCache, travelpayouts } from './fareCache';
import { FarePrefetcher } from './farePrefetch';
import { FlightRulesStore } from './flightRulesStore';
import { fareRequestPlan, liveFarePath, liveLegPaths, liveLegPlan, planPaths } from '../src/lib/fareRequests';
import { cityAirports, serpapiEvents, serpapiFlights } from './serpapi';
import { Lookout } from './lookout';
import { FxStore, loadCurrencies } from './fx';
import { RecentRainStore } from './recentRain';
import { WantedQueue } from './wanted';
import { buildMapPoints, SavedPrefetcher } from './savedPrefetch';
import { SavedRanges } from './savedRanges';
import { createHandler } from './handler';
import { buildSeedPoints, Seeder, type SeedPoint } from './seeder';
import { SunnyPrefetcher } from './sunnyWindows';
import { archiveRangeOf, TripArchive } from './tripArchive';
import { Upstream } from './upstream';
import { WeatherCache } from './weatherCache';

/** Stops the background work of the previous plugin instance: a dev-server restart builds a new
 *  one, and the old server's 'close' event can wait on open connections, leaving its timers
 *  running (two prefetchers sending the same searches). */
const g = globalThis as { __wandercastStop?: () => void };

export function weatherCachePlugin(opts: {
  root: string;
  seed?: boolean;
  faresToken?: string;
  serpapiKey?: string;
  serpapiMonthlyLimit?: number;
  /** Fare currency (FARE_CURRENCY); must match the one built into the browser bundle. */
  currency?: string;
}): Plugin {
  let handler: ((req: Parameters<ReturnType<typeof createHandler>>[0], res: Parameters<ReturnType<typeof createHandler>>[1], next: () => void) => void) | null = null;
  let seeder: Seeder | null = null;
  let farePrefetch: FarePrefetcher[] = [];
  let pruneTimer: NodeJS.Timeout | null = null;

  const init = () => {
    if (handler) return handler;
    g.__wandercastStop?.();
    const db = openDb(join(opts.root, 'data', 'weather.db'));
    const up = new Upstream(db);
    const cache = new WeatherCache(db, up);
    seeder = new Seeder(cache, up, join(opts.root, 'public'));
    const savedStore = new SavedRanges(db);
    let prefetch: SavedPrefetcher | null = null;
    try {
      prefetch = new SavedPrefetcher(cache, up, savedStore, buildMapPoints(join(opts.root, 'public')));
      seeder.saved = prefetch;
    } catch {
      /* map point lists unavailable: saved dates are still stored, just not pre-fetched */
    }
    const destPrefetch = new DestinationPrefetcher(cache, up, savedStore);
    seeder.destinations = destPrefetch;
    const wanted = new WantedQueue(db, cache, up);
    seeder.wanted = wanted;
    let seedPoints: SeedPoint[] | null = null;
    const sunny = new SunnyPrefetcher(db, cache, up, savedStore, () => {
      try {
        return (seedPoints ??= buildSeedPoints(join(opts.root, 'public')));
      } catch {
        return [];
      }
    }, join(opts.root, 'public'));
    seeder.sunny = sunny;
    const library = sunny.handler();
    if (opts.seed !== false) seeder.start();
    // Fares: saved in the DB as they're looked up, and pre-fetched for saved destinations.
    // Travelpayouts (cached fares) is refreshed every 6 h; SerpApi (live Google Flights, small
    // monthly allowance) is fetched once per saved trip: the one-way legs the flight rules rank.
    const fares = new FareCache(db, travelpayouts(opts.faresToken ?? ''));
    let airports = new Map<string, string[]>();
    try {
      airports = cityAirports(join(opts.root, 'public'));
    } catch {
      /* airport list unavailable: city codes are sent as-is */
    }
    const live = new FareCache(db, serpapiFlights(opts.serpapiKey ?? '', airports, opts.serpapiMonthlyLimit));
    // Past trips: copy each saved trip's fares into the archive before pruning drops passed
    // departures, and fill in the weather that actually happened (server/tripArchive.ts).
    const archive = new TripArchive(db);
    savedStore.archive = archive;
    const archivePlans = [
      { cache: fares, plan: (o: string, d: string, s: string, e: string, t: string) => planPaths(fareRequestPlan(o, d, s, e, t, opts.currency)) },
      { cache: live, plan: (o: string, d: string, s: string, e: string) => [...liveLegPaths(liveLegPlan(o, d, s, e, opts.currency)), liveFarePath(o, d, s, e, opts.currency)] },
    ];
    const captureAndPrune = () => {
      try {
        archive.captureFares(savedStore, archivePlans);
      } catch {
        /* never let archiving block pruning */
      }
      for (const c of [fares, live]) c.prune();
    };
    captureAndPrune();
    const archivedFares = { rangeOf: archiveRangeOf, fare: (id: number, key: string) => archive.fare(id, key) };
    farePrefetch = [
      new FarePrefetcher(fares, savedStore, (o, d, s, e, t) => planPaths(fareRequestPlan(o, d, s, e, t, opts.currency)), { refresh: true, tickMs: 20_000 }),
      new FarePrefetcher(live, savedStore, (o, d, s, e) => liveLegPaths(liveLegPlan(o, d, s, e, opts.currency)), { refresh: false, tickMs: 60_000 }),
    ];
    if (opts.seed !== false) for (const p of farePrefetch) p.start();
    const fareRoute = fares.handler(archivedFares);
    const liveRoute = live.handler(archivedFares);
    const flightRules = new FlightRulesStore(db).handler();
    // SerpApi reports its own monthly usage; keep the local count in line with it.
    void live.syncUsage();
    pruneTimer = setInterval(() => {
      cache.pruneExpired();
      captureAndPrune();
      if (opts.seed !== false) void archive.fillActualWeather(savedStore, cache).catch(() => undefined);
      if (opts.seed !== false) void alerts.ensure();
      void live.syncUsage();
    }, 30 * 60_000);

    // Holidays & events: build event rows now, then warm holiday calendars in the background,
    // China and Singapore first, then countries in seed-priority order.
    const cal = new CalendarStore(db);
    cal.rebuildEvents();
    if (opts.seed !== false) void warmHolidays(cal, join(opts.root, 'public'));

    const weather = createHandler(cache, seeder, wanted);
    // Recent rain vs normal (map ring and trip card), from stored data only.
    const recentRoute = new RecentRainStore(db, cache).handler();
    const calendar = createCalendarHandler(cal);
    // ENSO index (NOAA ONI): stored in the DB, refreshed at most weekly.
    const enso = new EnsoStore(db);
    if (opts.seed !== false) void enso.ensure().catch(() => undefined);
    const ensoRoute = enso.handler();
    // MFA travel advisories: checked at most daily, only changed country pages are re-read.
    const advisories = new AdvisoryStore(db, opts.root);
    if (opts.seed !== false) void advisories.ensure();
    const advisoryRoute = advisories.handler();
    // Unrest and security alerts (US embassies, UK FCDO): informational, checked twice a day.
    const alerts = new AlertStore(db, join(opts.root, 'public'));
    if (opts.seed !== false) void alerts.ensure();
    const alertRoute = alerts.handler();

    // Puff's Lookout: booked trips are watched for forecast, air-quality, event and MFA changes.
    // Events come from SerpApi Google Events and share the flight searches' monthly allowance.
    const events = new FareCache(db, serpapiEvents(opts.serpapiKey ?? '', opts.serpapiMonthlyLimit));
    const lookout = new Lookout(db, savedStore, up, { advisories, alerts, events, archive, captureFares: () => archive.captureFares(savedStore, archivePlans) });
    savedStore.onRemove = (id) => lookout.removeRange(id);
    if (opts.seed !== false) lookout.startTimer();
    const lookoutRoute = lookout.handler();
    // SGD exchange rates for page subtitles: one request a day for every currency.
    let fxRoute: (req: Parameters<ReturnType<typeof createHandler>>[0], res: Parameters<ReturnType<typeof createHandler>>[1], next: () => void) => void = (_q, _s, n) => n();
    try {
      fxRoute = new FxStore(db, loadCurrencies(opts.root)).handler();
    } catch {
      /* world-countries unavailable: no rates */
    }

    const s0 = seeder;
    const prefetchers = farePrefetch;
    const timer = pruneTimer;
    g.__wandercastStop = () => {
      s0.stop();
      for (const p of prefetchers) p.stop();
      clearInterval(timer);
      lookout.stop();
    };

    const s = seeder;
    const saved = savedStore.handler({
      progress: prefetch && opts.seed !== false ? (r) => prefetch!.progress(r) : undefined,
      destProgress: opts.seed !== false ? (r, d) => destPrefetch.progress(r, d) : undefined,
      sunnyProgress: (d) => sunny.progress(d),
      lookout: (r) => ({ unread: lookout.unread(r) }),
      prioritize: (id) => prefetch?.prioritize(id),
      onChange: () => s.wake(),
    });
    handler = (req, res, next) => void flightRules(req, res, () => void liveRoute(req, res, () => void fareRoute(req, res, () => void ensoRoute(req, res, () => void advisoryRoute(req, res, () => void alertRoute(req, res, () => void lookoutRoute(req, res, () => void fxRoute(req, res, () => void saved(req, res, () => void calendar(req, res, () => void library(req, res, () => void recentRoute(req, res, () => void weather(req, res, next)), () => s.wake())))))))))));
    return handler;
  };

  return {
    name: 'wandercast-weather-cache',
    configureServer(server) {
      const h = init();
      server.middlewares.use((req, res, next) => h(req, res, next));
      server.httpServer?.on('close', () => {
        seeder?.stop();
        for (const p of farePrefetch) p.stop();
        if (pruneTimer) clearInterval(pruneTimer);
      });
    },
    configurePreviewServer(server) {
      const h = init();
      server.middlewares.use((req, res, next) => h(req, res, next));
    },
  };
}

async function warmHolidays(cal: CalendarStore, publicDir: string) {
  let order: string[] = ['CN', 'SG'];
  try {
    order = [...new Set([...order, ...buildSeedPoints(publicDir).map((p) => p.cc)])];
  } catch {
    /* seed list unavailable: warm China and Singapore only */
  }
  for (const cc of order) {
    if (cal.isFresh(cc)) continue;
    try {
      await cal.ensureHolidays(cc);
    } catch {
      /* try again on demand */
    }
    await new Promise((r) => setTimeout(r, 1500)); // be polite to the calendar hosts
  }
}
