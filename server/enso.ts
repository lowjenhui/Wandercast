// El Niño–Southern Oscillation (ENSO) index, stored in SQLite.
//
// Source: NOAA CPC Oceanic Niño Index (ONI): 3-month running mean SST anomaly in the Niño-3.4
// region, back to 1950. One small text file, refreshed at most weekly, so NOAA is contacted
// rarely and every app request is served from the database.
//
//   GET /api/climate/enso   → { source, fetchedAt, series: [{ year, season, anom }] }

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';

export const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
const REFRESH_MS = 7 * 24 * 3600_000;

export interface OniRow {
  year: number;
  season: string; // DJF, JFM, … NDJ (centred month's year)
  anom: number;
}

export function parseOni(text: string): OniRow[] {
  const out: OniRow[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([A-Z]{3})\s+(\d{4})\s+(-?[\d.]+)\s+(-?[\d.]+)$/);
    if (m) out.push({ season: m[1], year: Number(m[2]), anom: Number(m[4]) });
  }
  return out;
}

export class EnsoStore {
  private inflight: Promise<void> | null = null;

  constructor(private db: DB) {
    db.exec(`CREATE TABLE IF NOT EXISTS enso_oni (
      year INTEGER NOT NULL, season TEXT NOT NULL, anom REAL NOT NULL, PRIMARY KEY (year, season)
    ) WITHOUT ROWID`);
  }

  private fetchedAt(): number {
    const row = this.db.prepare("SELECT value FROM seed_state WHERE key = 'enso_fetched_at'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** Refresh from NOAA if the stored copy is older than a week (deduplicated). */
  ensure(): Promise<void> {
    if (Date.now() - this.fetchedAt() < REFRESH_MS && this.count() > 0) return Promise.resolve();
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refresh() {
    try {
      const res = await fetch(ONI_URL, { headers: { 'User-Agent': 'Wandercast/0.1 (local app)' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
      const rows = parseOni(await res.text());
      if (rows.length < 100) throw new Error('Unexpected ONI file format');
      const ins = this.db.prepare('INSERT OR REPLACE INTO enso_oni (year, season, anom) VALUES (?, ?, ?)');
      this.db.exec('BEGIN');
      rows.forEach((r) => ins.run(r.year, r.season, r.anom));
      this.db.prepare("INSERT OR REPLACE INTO seed_state (key, value) VALUES ('enso_fetched_at', ?)").run(String(Date.now()));
      this.db.exec('COMMIT');
    } catch (e) {
      // Keep serving the stored copy; only fail when there is nothing stored at all.
      if (this.count() === 0) throw e;
    }
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM enso_oni').get() as { n: number }).n;
  }

  series(): OniRow[] {
    return this.db.prepare('SELECT year, season, anom FROM enso_oni ORDER BY year, season').all() as unknown as OniRow[];
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (!req.url?.startsWith('/api/climate/enso')) return next();
      try {
        await this.ensure();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ source: { name: 'NOAA CPC Oceanic Niño Index (ONI)', url: 'https://origin.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php' }, fetchedAt: this.fetchedAt(), series: this.series() }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: true, reason: `ENSO index unavailable: ${(e as Error).message}` }));
      }
    };
  }
}
