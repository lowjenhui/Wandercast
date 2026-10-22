// Pre-fetches the full trip analysis history for each saved range's probable destinations, so
// the comparison table and "open full analysis" load from the database. Runs inside the seeder
// before the map-wide saved-dates prefetch, on the saved-dates budget lane.
//
// The days fetched come from src/lib/tripFetchPlan.ts — the same plan the analysis itself uses.
// The main range is split by calendar year so progress moves steadily and requests stay small.

import { tripFetchPlan, type FetchRange } from '../src/lib/tripFetchPlan';
import { isBooked, type SavedDestination, type SavedRange, type SavedRanges } from './savedRanges';
import { unitsFor, type Upstream } from './upstream';
import { DAILY_VARS, type WeatherCache } from './weatherCache';

/** ERA5 days newer than this are always re-fetched by the cache, so the prefetch stops short. */
const SETTLE_DAYS = 11;

const todayUTC = () => new Date().toISOString().slice(0, 10);
function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayCount = (r: FetchRange) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000) + 1;

/** The ranges to store for a trip, split by calendar year and clipped to settled ERA5 days. */
export function destinationParts(start: string, end: string, today = todayUTC()): FetchRange[] {
  const plan = tripFetchPlan(start, end, today);
  const settled = addDays(today, -SETTLE_DAYS);
  const parts: FetchRange[] = [];
  if (plan.main) {
    for (let y = Number(plan.main.start.slice(0, 4)); y <= Number(plan.main.end.slice(0, 4)); y++) {
      const s = plan.main.start > `${y}-01-01` ? plan.main.start : `${y}-01-01`;
      const e = plan.main.end < `${y}-12-31` ? plan.main.end : `${y}-12-31`;
      parts.push({ start: s, end: e });
    }
  }
  parts.push(...plan.older.map(({ start: s, end: e }) => ({ start: s, end: e })));
  return parts.filter((p) => p.start <= settled).map((p) => ({ start: p.start, end: p.end < settled ? p.end : settled }));
}

export interface DestinationProgress {
  pct: number;
  state: 'complete' | 'fetching' | 'waiting' | 'queued' | 'past';
  detail: string;
}

export class DestinationPrefetcher {
  private active: number | null = null;
  private waitingReason: string | null = null;
  private partsCache = new Map<string, FetchRange[]>();

  constructor(
    private cache: WeatherCache,
    private up: Upstream,
    private saved: SavedRanges,
  ) {}

  private parts(r: SavedRange): FetchRange[] {
    const key = `${r.start}|${r.end}|${todayUTC()}`;
    let p = this.partsCache.get(key);
    if (!p) {
      p = destinationParts(r.start, r.end);
      this.partsCache.set(key, p);
    }
    return p;
  }

  private missing(r: SavedRange, d: SavedDestination): FetchRange[] {
    const loc = this.cache.resolve('era5', d);
    return this.parts(r).filter((p) => this.cache.era5Missing(loc, p.start, p.end));
  }

  private queue(): { r: SavedRange; d: SavedDestination }[] {
    const today = todayUTC();
    const ranges = new Map(this.saved.list().filter((r) => r.end >= today).map((r) => [r.id, r]));
    // Newest additions first: they're the ones the user is looking at.
    return this.saved
      .destinations()
      // A booked trip only needs its booked destination (for Puff's Lookout).
      .filter((d) => ranges.has(d.range_id) && (!isBooked(ranges.get(d.range_id)!) || ranges.get(d.range_id)!.booked_dest_id === d.id))
      .sort((a, b) => b.created_at - a.created_at)
      .map((d) => ({ r: ranges.get(d.range_id)!, d }));
  }

  /** One request's worth of work. True if it fetched something. */
  async step(): Promise<boolean> {
    for (const { r, d } of this.queue()) {
      const part = this.missing(r, d)[0];
      if (!part) continue;
      const units = unitsFor(1, dayCount(part), DAILY_VARS.length);
      if (!this.up.canSpend(units, 'saved')) {
        const st = this.up.status();
        this.waitingReason =
          st.savedToday + 50 >= st.limits.savedPerDay || st.today + 50 >= st.limits.perDay - st.limits.interactiveReserve
            ? 'Waiting for the daily weather API allowance to reset (08:00 Singapore time).'
            : 'Waiting for spare API budget.';
        return false;
      }
      this.active = d.id;
      this.waitingReason = null;
      await this.cache.ensureEra5([d], part.start, part.end, { seed: true, lane: 'saved', maxUnitsPerRequest: 240 });
      return true;
    }
    this.active = null;
    this.waitingReason = null;
    return false;
  }

  hasWork(): boolean {
    return this.queue().some(({ r, d }) => this.missing(r, d).length > 0);
  }

  progress(r: SavedRange, d: SavedDestination): DestinationProgress {
    if (r.end < todayUTC()) return { pct: 100, state: 'past', detail: 'These dates have passed.' };
    const parts = this.parts(r);
    const total = parts.reduce((a, p) => a + dayCount(p), 0);
    const miss = this.missing(r, d).reduce((a, p) => a + dayCount(p), 0);
    const pct = total ? Math.floor(((total - miss) / total) * 100) : 100;
    if (miss === 0) return { pct: 100, state: 'complete', detail: 'Weather history saved.' };
    if (this.active === d.id && !this.waitingReason) return { pct, state: 'fetching', detail: 'Fetching weather history…' };
    if (this.waitingReason) return { pct, state: 'waiting', detail: this.waitingReason };
    return { pct, state: 'queued', detail: 'Queued.' };
  }
}
