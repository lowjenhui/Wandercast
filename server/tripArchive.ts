// Past trips: what's kept so an archived daydream date can be shown later without new API calls.
//
// - fare_archive:    copies of the saved fare responses (Travelpayouts and SerpApi) for each saved
//                    destination of a range, taken from fare_cache before it prunes departures that
//                    have passed. Only responses fetched before the trip started are copied, and a
//                    newer pre-trip copy replaces an older one, so the archive holds the last fares
//                    seen while the trip was upcoming.
// - saved_snapshots: per saved destination, a small summary of the full analysis (weather verdict,
//                    odds, crowds, advisory, cheapest fare) posted by the browser whenever the
//                    analysis is opened while the trip is upcoming. Frozen once the trip has ended.
// - Actual weather:  after a trip, ERA5 days for its dates are fetched into era5_daily (stored
//                    permanently already) once Open-Meteo has published them (about 5 days later).
//
// Requests carrying `X-Wandercast-Archive: <range id>` are served from stored data only: fares
// from fare_archive, weather from era5_daily (see handler.ts).

import type { IncomingMessage } from 'node:http';
import type { DB } from './db';
import type { FareCache } from './fareCache';
import type { PlanFn } from './farePrefetch';
import type { SavedRanges } from './savedRanges';
import type { WeatherCache } from './weatherCache';

export const ARCHIVE_HEADER = 'x-wandercast-archive';
const ORIGIN = 'SIN';
const DAY_MS = 86_400_000;

/** The archived range a request asks for, or null for a normal request. */
export function archiveRangeOf(req: IncomingMessage): number | null {
  const v = Number(req.headers?.[ARCHIVE_HEADER]);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** Today's date where the server runs (the app's dates are local, not UTC). */
export const localToday = (now = new Date()) => now.toLocaleDateString('sv');

/** A trip is archived once its end date has passed. */
export const isArchived = (r: { end: string }, today = localToday()) => r.end < today;

export class TripArchive {
  constructor(private db: DB) {
    db.exec(`CREATE TABLE IF NOT EXISTS fare_archive (
      range_id INTEGER NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (range_id, key)
    ) WITHOUT ROWID`);
    db.exec(`CREATE TABLE IF NOT EXISTS saved_snapshots (
      dest_id INTEGER PRIMARY KEY, range_id INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
    )`);
  }

  /**
   * Copy each saved range's fare responses into the archive. `plan` gives the paths the Flights
   * section asks for in archive mode (planned as of the trip's start date).
   */
  captureFares(saved: SavedRanges, caches: { cache: FareCache; plan: PlanFn }[]): number {
    const ranges = new Map(saved.list().map((r) => [r.id, r]));
    const put = this.db.prepare(
      'INSERT INTO fare_archive (range_id, key, body, fetched_at) VALUES (?,?,?,?) ON CONFLICT (range_id, key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at WHERE excluded.fetched_at > fare_archive.fetched_at',
    );
    let n = 0;
    for (const d of saved.destinations()) {
      const r = ranges.get(d.range_id);
      if (!r || !/^[A-Z]{3}$/.test(d.code) || d.code === ORIGIN) continue;
      // Responses fetched on or before the start day are pre-trip prices.
      const cutoff = Date.parse(`${r.start}T00:00:00`) + DAY_MS;
      for (const { cache, plan } of caches) {
        for (const path of new Set(plan(ORIGIN, d.code, r.start, r.end, r.start))) {
          const row = cache.stored(path);
          if (row && row.fetched_at < cutoff) n += Number(put.run(r.id, row.key, row.body, row.fetched_at).changes);
        }
      }
    }
    return n;
  }

  fare(rangeId: number, key: string): { body: string; fetched_at: number } | undefined {
    return this.db.prepare('SELECT body, fetched_at FROM fare_archive WHERE range_id = ? AND key = ?').get(rangeId, key) as { body: string; fetched_at: number } | undefined;
  }

  snapshots(rangeId: number): Map<number, { body: unknown; at: number }> {
    const rows = this.db.prepare('SELECT dest_id, body, at FROM saved_snapshots WHERE range_id = ?').all(rangeId) as { dest_id: number; body: string; at: number }[];
    return new Map(rows.map((r) => [r.dest_id, { body: JSON.parse(r.body) as unknown, at: r.at }]));
  }

  putSnapshot(rangeId: number, destId: number, body: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO saved_snapshots (dest_id, range_id, body, at) VALUES (?,?,?,?)').run(destId, rangeId, JSON.stringify(body), Date.now());
  }

  removeDestination(destId: number) {
    this.db.prepare('DELETE FROM saved_snapshots WHERE dest_id = ?').run(destId);
  }

  removeRange(rangeId: number) {
    this.db.prepare('DELETE FROM fare_archive WHERE range_id = ?').run(rangeId);
    this.db.prepare('DELETE FROM saved_snapshots WHERE range_id = ?').run(rangeId);
  }

  /**
   * Fetch the actual weather (ERA5) for one archived trip destination that still has days
   * missing. ERA5Gaps only counts days Open-Meteo has published, so recent trips wait.
   */
  async fillActualWeather(saved: SavedRanges, cache: WeatherCache, today = localToday()): Promise<boolean> {
    const ranges = new Map(saved.list().filter((r) => isArchived(r, today)).map((r) => [r.id, r]));
    for (const d of saved.destinations()) {
      const r = ranges.get(d.range_id);
      if (!r) continue;
      const loc = cache.resolve('era5', { lat: d.lat, lon: d.lon });
      if (cache.era5Gaps(loc, r.start, r.end) === 0) continue;
      await cache.ensureEra5([{ lat: d.lat, lon: d.lon }], r.start, r.end, { settle: true, lane: 'saved' });
      return true;
    }
    return false;
  }
}
