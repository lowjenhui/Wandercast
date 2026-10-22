// History that the app asked for but the database didn't have yet (e.g. a destination's
// same-date windows for the suggestions list). Instead of calling the weather API while the
// user waits, these requests are queued here and fetched in the background by the seeder on
// the saved-dates budget lane. Stored in SQLite so the queue survives restarts.
//
// A request can also be for snowfall only (`snowfall`): days that are stored but have it blank
// (Copernicus days, Open-Meteo days stored before it was added). The page doesn't wait for it.

import type { DB } from './db';
import { unitsFor, type Upstream } from './upstream';
import { DAILY_VARS, roundLoc, type DailyVar, type Loc, type WeatherCache } from './weatherCache';

const MAX_AGE_MS = 14 * 24 * 3600_000;
const BATCH_UNITS = 240;

const dayCount = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;

export class WantedQueue {
  private waiting = false;

  constructor(
    private db: DB,
    private cache: WeatherCache,
    private up: Upstream,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS wanted_era5 (
      lat REAL NOT NULL, lon REAL NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, requested_at INTEGER NOT NULL,
      PRIMARY KEY (lat, lon, start, end)
    ) WITHOUT ROWID`);
    // Older databases: snowfall-only requests (see above).
    const cols = (db.prepare('PRAGMA table_info(wanted_era5)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('snowfall')) db.exec('ALTER TABLE wanted_era5 ADD COLUMN snowfall INTEGER NOT NULL DEFAULT 0');
  }

  /** Remember that these locations need [start, end] (already resolved to stored points). */
  add(locs: Loc[], start: string, end: string, opts: { snowfall?: boolean } = {}) {
    const ins = this.db.prepare(
      'INSERT INTO wanted_era5 (lat, lon, start, end, requested_at, snowfall) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (lat, lon, start, end) DO UPDATE SET requested_at = excluded.requested_at, snowfall = MAX(snowfall, excluded.snowfall)',
    );
    const now = Date.now();
    this.db.exec('BEGIN');
    for (const l of locs) {
      const r = roundLoc(l);
      ins.run(r.lat, r.lon, start, end, now, opts.snowfall ? 1 : 0);
    }
    this.db.exec('COMMIT');
  }

  /** The variables a queued request needs: everything, so snowfall counts when it was asked for. */
  private varsFor(snowfall: number): readonly DailyVar[] | undefined {
    return snowfall ? DAILY_VARS : undefined;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM wanted_era5').get() as { n: number }).n;
  }

  hasWork(): boolean {
    return this.count() > 0;
  }

  /** Drop requests that are stored now (filled by another job) or too old to matter. */
  private prune() {
    this.db.prepare('DELETE FROM wanted_era5 WHERE requested_at < ?').run(Date.now() - MAX_AGE_MS);
    const rows = this.db.prepare('SELECT lat, lon, start, end, snowfall FROM wanted_era5').all() as { lat: number; lon: number; start: string; end: string; snowfall: number }[];
    const del = this.db.prepare('DELETE FROM wanted_era5 WHERE lat = ? AND lon = ? AND start = ? AND end = ?');
    for (const r of rows) {
      if (this.cache.era5Gaps(this.cache.resolve('era5', r), r.start, r.end, this.varsFor(r.snowfall)) === 0) del.run(r.lat, r.lon, r.start, r.end);
    }
  }

  /** One batch: the most recently requested window, for as many places as fit the batch. */
  async step(): Promise<boolean> {
    this.prune();
    const head = this.db.prepare('SELECT start, end FROM wanted_era5 ORDER BY requested_at DESC LIMIT 1').get() as { start: string; end: string } | undefined;
    if (!head) return false;
    const perLoc = unitsFor(1, dayCount(head.start, head.end), DAILY_VARS.length);
    const max = Math.max(1, Math.floor(BATCH_UNITS / perLoc));
    const rows = this.db
      .prepare('SELECT lat, lon, snowfall FROM wanted_era5 WHERE start = ? AND end = ? ORDER BY requested_at DESC LIMIT ?')
      .all(head.start, head.end, max) as unknown as (Loc & { snowfall: number })[];
    const locs = rows.map((r) => ({ lat: r.lat, lon: r.lon }));
    if (!this.up.canSpend(perLoc * locs.length, 'saved')) {
      this.waiting = true;
      return false;
    }
    this.waiting = false;
    const vars = this.varsFor(Math.max(...rows.map((r) => r.snowfall)));
    await this.cache.ensureEra5(locs, head.start, head.end, { seed: true, lane: 'saved', maxUnitsPerRequest: BATCH_UNITS, settle: true, vars });
    // Snowfall Open-Meteo can't provide either (e.g. a sea point) would otherwise stay queued.
    if (vars) for (const l of locs) this.db.prepare('UPDATE wanted_era5 SET snowfall = 0 WHERE lat = ? AND lon = ? AND start = ? AND end = ?').run(l.lat, l.lon, head.start, head.end);
    this.prune();
    return true;
  }

  status() {
    return { queued: this.count(), waitingForBudget: this.waiting };
  }
}
