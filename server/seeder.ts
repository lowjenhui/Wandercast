// Background seeding of the weather database, in priority order:
//   1. Popular: cities with direct flights from Singapore served by several airlines, plus the
//      curated destination list.
//   2. Southeast Asia: remaining direct-flight cities, capitals and large cities.
//   3. Rest of Asia.
//   4. Everywhere else.
//
// Jobs:
//   - Daily forecast (16 days): every point once, then tiers 1–2 kept fresh.
//   - ERA5 history, newest year first: the current year plus 5 years for every tier, then
//     10 years for tier 1 (the full trip analysis uses 10 years).
// Seeding only spends budget the interactive app isn't using (see Upstream.canSpend).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DestinationPrefetcher } from './destPrefetch';
import type { SavedPrefetcher } from './savedPrefetch';
import type { SunnyPrefetcher } from './sunnyWindows';
import type { WantedQueue } from './wanted';
import { LIMITS, unitsFor, type Upstream } from './upstream';
import { DAILY_VARS, FORECAST_TTL_MS, roundLoc, type Loc, type WeatherCache } from './weatherCache';

const SEA = new Set(['BN', 'KH', 'ID', 'LA', 'MY', 'MM', 'PH', 'SG', 'TH', 'TL', 'VN']);
const ASIA = new Set([
  ...SEA,
  'CN', 'HK', 'MO', 'TW', 'JP', 'KR', 'KP', 'MN', 'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV', 'AF', 'IR', 'IQ', 'SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'YE',
  'JO', 'IL', 'PS', 'LB', 'SY', 'TR', 'GE', 'AM', 'AZ', 'KZ', 'UZ', 'TM', 'KG', 'TJ',
]);

export interface SeedPoint extends Loc {
  name: string;
  cc: string;
  tier: 1 | 2 | 3 | 4;
}

interface Job {
  kind: 'history';
  point: SeedPoint;
  start: string;
  end: string;
  label: string;
}

const TIER_NAME = { 1: 'popular cities', 2: 'Southeast Asia', 3: 'rest of Asia', 4: 'rest of the world' } as const;

function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Gateway destinations (public/gateway-destinations.json), if the file is present. */
export function gateways(read: <T>(f: string) => T): { name: string; cc: string; lat: number; lon: number }[] {
  try {
    return read<{ destinations: { name: string; cc: string; lat: number; lon: number }[] }>('gateway-destinations.json').destinations;
  } catch {
    return [];
  }
}

/**
 * Climate-zone cities (public/climate-zones.json): the points that colour each zone of a country
 * with more than one rainy season (Trincomalee for Sri Lanka's east…), stored with the popular ones.
 */
export function climateZoneCities(read: <T>(f: string) => T): { name: string; cc: string; lat: number; lon: number }[] {
  try {
    const fc = read<{ features: { properties: { kind: string; cc: string; city?: { name: string; lat: number; lon: number } | null } }[] }>('climate-zones.json');
    return fc.features.flatMap(({ properties: p }) => (p.kind === 'zone' && p.city ? [{ ...p.city, cc: p.cc }] : []));
  } catch {
    return [];
  }
}

export const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
};

/**
 * Overland places (public/land-destinations.json) with no flight, ferry or curated place within
 * 25 km (Johor Bahru, Muar…). The others are the same place as one already listed, so the app
 * shows them there and they need no point of their own.
 */
export function landOnlyPlaces(read: <T>(f: string) => T): { name: string; cc: string; lat: number; lon: number }[] {
  try {
    const land = read<{ destinations: { name: string; cc: string; lat: number; lon: number }[] }>('land-destinations.json').destinations;
    const others = [
      ...read<{ cities: { lat: number; lon: number }[] }>('direct-cities.json').cities,
      ...read<{ lat: number; lon: number }[]>('destinations.json'),
      ...gateways(read),
      ...(() => {
        try {
          return read<{ destinations: { lat: number; lon: number }[] }>('ferry-destinations.json').destinations;
        } catch {
          return [];
        }
      })(),
    ];
    return land.filter((l) => !others.some((o) => kmBetween(o, l) < 25));
  } catch {
    return [];
  }
}

/** Builds the ordered seed list from the bundled datasets in public/. */
export function buildSeedPoints(publicDir: string): SeedPoint[] {
  const read = <T>(f: string): T => JSON.parse(readFileSync(join(publicDir, f), 'utf8')) as T;
  const direct = read<{ cities: { name: string; cc: string; lat: number; lon: number; airlines: string[] }[] }>('direct-cities.json').cities;
  const dests = read<{ name: string; cc: string; lat: number; lon: number }[]>('destinations.json');
  const capitals = read<{ name: string; capital: string; cc: string; lat: number; lon: number }[]>('capitals.json');
  const cities = read<[string, string, number, number, number][]>('cities.json'); // sorted by population

  const out: SeedPoint[] = [];
  const seen = new Set<string>();
  const add = (name: string, cc: string, lat: number, lon: number, tier: SeedPoint['tier']) => {
    const key = `${Math.round(lat * 10)},${Math.round(lon * 10)}`; // ~11 km dedupe
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, cc, ...roundLoc({ lat, lon }), tier });
  };
  const regionTier = (cc: string): SeedPoint['tier'] => (SEA.has(cc) ? 2 : ASIA.has(cc) ? 3 : 4);

  // Tier 1: ferry and overland destinations, busiest direct routes, then curated destinations.
  try {
    read<{ destinations: { name: string; cc: string; lat: number; lon: number }[] }>('ferry-destinations.json').destinations.forEach((f) => add(f.name, f.cc, f.lat, f.lon, 1));
  } catch {
    /* optional */
  }
  landOnlyPlaces(read).forEach((l) => add(l.name, l.cc, l.lat, l.lon, 1));
  climateZoneCities(read).forEach((z) => add(z.name, z.cc, z.lat, z.lon, 1));
  direct.filter((c) => c.airlines.length >= 2).forEach((c) => add(c.name, c.cc, c.lat, c.lon, 1));
  dests.forEach((d) => add(d.name, d.cc, d.lat, d.lon, 1));
  // Tiers 2–4 by region: remaining direct cities, capitals, then large cities.
  for (const tier of [2, 3, 4] as const) {
    const inTier = (cc: string) => regionTier(cc) === tier;
    direct.filter((c) => inTier(c.cc)).forEach((c) => add(c.name, c.cc, c.lat, c.lon, tier));
    capitals.filter((c) => inTier(c.cc)).forEach((c) => add(c.capital, c.cc, c.lat, c.lon, tier));
    // Places reached via a direct-flight city (Hoi An via Da Nang…): after the region's direct
    // cities and capitals, since they're an optional map layer.
    gateways(read).filter((g) => inTier(g.cc)).forEach((g) => add(g.name, g.cc, g.lat, g.lon, tier));
    const minPop = tier === 2 ? 300_000 : 1_000_000;
    cities.filter(([, cc, , , pop]) => inTier(cc) && pop >= minPop).forEach(([name, cc, lat, lon]) => add(name, cc, lat, lon, tier));
  }
  return out;
}

export class Seeder {
  private stopped = false;
  private wakeTimer: (() => void) | null = null;
  /** Saved travel dates are pre-fetched before any general seeding. */
  saved: SavedPrefetcher | null = null;
  /** Probable destinations of saved dates: their full analysis history, first of all. */
  destinations: DestinationPrefetcher | null = null;
  /** History the app asked for but didn't have (suggestions, map), fetched in the background. */
  wanted: WantedQueue | null = null;
  /** Sunny windows history: saved destinations, then places queued from the weather library. */
  sunny: SunnyPrefetcher | null = null;
  private points: SeedPoint[] = [];
  private jobs: Job[] = [];
  private cursor = 0;
  private forecastCursor = 0;
  private state: { phase: string; detail: string; pausedReason: string | null; lastError: string | null } = {
    phase: 'starting',
    detail: '',
    pausedReason: null,
    lastError: null,
  };

  constructor(
    private cache: WeatherCache,
    private up: Upstream,
    private publicDir: string,
  ) {}

  start() {
    try {
      this.points = buildSeedPoints(this.publicDir);
    } catch (e) {
      this.state = { ...this.state, phase: 'disabled', lastError: `Seed list unavailable: ${(e as Error).message}` };
      return;
    }
    this.jobs = this.buildHistoryJobs();
    void this.loop();
  }

  stop() {
    this.stopped = true;
  }

  private buildHistoryJobs(): Job[] {
    const today = new Date().toISOString().slice(0, 10);
    const year = Number(today.slice(0, 4));
    const settled = addDays(today, -10);
    const yearJob = (p: SeedPoint, y: number): Job => ({
      kind: 'history',
      point: p,
      start: `${y}-01-01`,
      end: y === year ? settled : `${y}-12-31`,
      label: `${y}`,
    });
    const jobs: Job[] = [];
    // Current year and the last 5 complete years, newest first, tier by tier.
    for (let back = 0; back <= 5; back++) for (const tier of [1, 2, 3, 4]) this.points.filter((p) => p.tier === tier).forEach((p) => jobs.push(yearJob(p, year - back)));
    // Then years 6–10 for popular cities (full trip analysis).
    for (let back = 6; back <= 10; back++) this.points.filter((p) => p.tier === 1).forEach((p) => jobs.push(yearJob(p, year - back)));
    return jobs;
  }

  status() {
    const counts = [1, 2, 3, 4].map((t) => ({ tier: t, name: TIER_NAME[t as 1], points: this.points.filter((p) => p.tier === t).length }));
    return {
      ...this.state,
      tiers: counts,
      history: { done: this.cursor, total: this.jobs.length },
      forecastCursor: this.forecastCursor,
      limits: { seedPerDay: LIMITS.seedPerDay },
    };
  }

  private async sleep(ms: number) {
    await new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      this.wakeTimer = () => (clearTimeout(t), r());
    });
    this.wakeTimer = null;
  }

  /** Cut the current idle wait short (e.g. after a range is saved or "Retrieve now"). */
  wake() {
    this.wakeTimer?.();
  }

  private async loop() {
    await this.sleep(3000); // let the app's first requests go first
    while (!this.stopped) {
      try {
        const worked = await this.step();
        this.state.lastError = null;
        await this.sleep(worked ? 1200 : 20_000);
      } catch (e) {
        this.state.lastError = (e as Error).message;
        await this.sleep(30_000);
      }
    }
  }

  /** One unit of seeding work. Returns false when there was nothing to do or no budget. */
  private async step(): Promise<boolean> {
    // 0. The saved-dates lane (its own daily cap): the destinations you're comparing, places the
    //    app asked for but hadn't stored (the wanted queue), Sunny windows for daydream dates and
    //    library downloads, the map-wide outlook for saved dates, then Sunny windows for popular
    //    destinations. When that lane is done or capped for the day, general seeding still runs below.
    if (this.destinations && (await this.destinations.step())) {
      this.state = { ...this.state, phase: 'saved destinations', detail: 'Fetching weather history for destinations on your saved dates', pausedReason: null };
      return true;
    }
    if (this.wanted && (await this.wanted.step())) {
      this.state = { ...this.state, phase: 'requested places', detail: 'Fetching places shown in suggestions and on the map that were not stored yet', pausedReason: null };
      return true;
    }
    if (this.sunny && (await this.sunny.step())) {
      this.state = { ...this.state, phase: 'sunny windows', detail: 'Fetching Sunny windows history for saved destinations and library downloads', pausedReason: null };
      return true;
    }
    if (this.saved && (await this.saved.step())) {
      this.state = { ...this.state, phase: 'saved dates', detail: 'Fetching weather for your saved travel dates', pausedReason: null };
      return true;
    }
    if (this.sunny && (await this.sunny.step({ popular: true }))) {
      this.state = { ...this.state, phase: 'sunny windows', detail: 'Fetching Sunny windows history for popular destinations, nearest first', pausedReason: null };
      return true;
    }
    const savedWaiting = Boolean(this.destinations?.hasWork() || this.wanted?.hasWork() || this.sunny?.hasWork() || this.saved?.hasWork());

    if (this.up.usedToday().seedUnits >= LIMITS.seedPerDay) {
      this.state.pausedReason = `Daily seeding budget (${LIMITS.seedPerDay} units) used${savedWaiting ? '; saved dates are also waiting for budget' : ''}; resumes tomorrow.`;
      return false;
    }
    if (savedWaiting) this.state.pausedReason = 'Saved dates and requested places are waiting for their daily budget; general seeding continues.';

    // The "Right now" map is not refreshed in the background: it is loaded only when the user
    // presses Reload on the map (see handler.ts), so it never spends budget on its own.

    // 1. Forecasts: a first pass over every point, then keep tiers 1–2 fresh.
    const today = new Date().toISOString().slice(0, 10);
    const fStart = addDays(today, 1);
    const fEnd = addDays(today, 14);
    const needsForecast = (p: SeedPoint) => !this.cache.forecastFresh(p, fStart, fEnd);
    const firstPass = this.forecastCursor < this.points.length;
    const pool = firstPass ? this.points.slice(this.forecastCursor) : this.points.filter((p) => p.tier <= 2);
    const batch = pool.filter(needsForecast).slice(0, 60);
    if (batch.length) {
      const units = unitsFor(batch.length, 16, DAILY_VARS.length);
      if (!this.up.canSpend(units, true)) return this.paused();
      this.state = { ...this.state, phase: 'forecast', detail: `16-day forecast · ${TIER_NAME[batch[0].tier]} (${batch[0].name}…)`, pausedReason: null };
      await this.cache.ensureForecast(batch, fStart, fEnd, { seed: true });
      if (firstPass) this.forecastCursor = this.points.indexOf(batch[batch.length - 1]) + 1;
      return true;
    }
    if (firstPass) this.forecastCursor = this.points.length;

    // 2. History, in job order. Batch consecutive jobs for the same year range.
    while (this.cursor < this.jobs.length && !this.cache.era5Missing(this.jobs[this.cursor].point, this.jobs[this.cursor].start, this.jobs[this.cursor].end)) this.cursor++;
    if (this.cursor >= this.jobs.length) {
      // 3. Last of all: values Copernicus-imported history leaves blank (snowfall), from Open-Meteo.
      const blank = this.cache.cdsBlank();
      if (blank) {
        if (!this.up.canSpend(unitsFor(1, 366, DAILY_VARS.length), true)) return this.paused();
        this.state = { ...this.state, phase: 'filling blanks', detail: `Snowfall for Copernicus history (${blank.start.slice(0, 4)})`, pausedReason: null };
        try {
          await this.cache.ensureEra5([blank.loc], blank.start, blank.end, { seed: true, vars: DAILY_VARS, maxUnitsPerRequest: 240 });
        } finally {
          this.cache.cdsBlankDone(blank);
        }
        return true;
      }
      this.state = { ...this.state, phase: 'idle', detail: `History complete for ${this.points.length} places; keeping forecasts fresh.`, pausedReason: null };
      return false;
    }
    const first = this.jobs[this.cursor];
    const group: Job[] = [];
    for (let i = this.cursor; i < this.jobs.length && group.length < 8; i++) {
      const j = this.jobs[i];
      if (j.start !== first.start || j.end !== first.end) break;
      if (this.cache.era5Missing(j.point, j.start, j.end)) group.push(j);
    }
    const days = Math.round((Date.parse(first.end) - Date.parse(first.start)) / 86_400_000) + 1;
    const units = unitsFor(group.length, days, DAILY_VARS.length);
    if (!this.up.canSpend(units, true)) return this.paused();
    this.state = {
      ...this.state,
      phase: 'history',
      detail: `ERA5 ${first.label} · ${TIER_NAME[first.point.tier]} (${group.map((g) => g.point.name).slice(0, 3).join(', ')}${group.length > 3 ? '…' : ''})`,
      pausedReason: null,
    };
    await this.cache.ensureEra5(group.map((g) => g.point), first.start, first.end, { seed: true, maxUnitsPerRequest: 240 });
    return true;
  }

  private paused(): false {
    this.state.pausedReason = 'Waiting for spare API budget (the app’s own requests come first).';
    return false;
  }
}

export { FORECAST_TTL_MS };
