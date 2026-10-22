// SQLite storage for weather data (Node's built-in node:sqlite, no extra dependency).
//
// - era5_daily:     ERA5 reanalysis days. Immutable once published, so stored permanently.
//                   `source` is 'om' (Open-Meteo, or NULL on rows stored before it was added) or
//                   'cds' (Copernicus, scripts/import-era5-cds.py). Open-Meteo never overwrites a
//                   Copernicus row; it only fills the values Copernicus can't provide (snowfall).
//                   Copernicus likewise only fills blanks on Open-Meteo rows (feels-like on days
//                   stored before it was added), so no stored value is ever changed.
// - forecast_daily: 16-day daily forecast days, refreshed when older than FORECAST_TTL, plus
//   the 12 days before each fetch, kept 35 days for the recent rain signal.
// - hourly_cache:   today's and tomorrow's hourly forecast per place, used for the "Right now"
//                   map (current hour), refreshed every 12 hours.
// - response_cache: short-lived per-location responses (fallback for other current queries).
// - point_meta:     grid cell, elevation and timezone per location (to rebuild API responses).
// - usage:          upstream API units used per day (for the daily budget).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

/** A Copernicus day missing a value (in practice snowfall, which its point series doesn't have). */
export const CDS_BLANK = 'precip IS NULL OR tmax IS NULL OR tmin IS NULL OR rh IS NULL OR atmax IS NULL OR atmin IS NULL OR snow IS NULL';

export function openDb(file: string): DB {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- Wait for another writer (scripts/import-era5-cds.py, a second dev server) instead of failing.
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS era5_daily (
      lat REAL NOT NULL, lon REAL NOT NULL, date TEXT NOT NULL,
      precip REAL, tmax REAL, tmin REAL, rh REAL,
      PRIMARY KEY (lat, lon, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS forecast_daily (
      lat REAL NOT NULL, lon REAL NOT NULL, date TEXT NOT NULL,
      precip REAL, tmax REAL, tmin REAL, rh REAL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (lat, lon, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS point_meta (
      kind TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
      grid_lat REAL, grid_lon REAL, elevation REAL, utc_offset INTEGER, timezone TEXT, tz_abbr TEXT,
      PRIMARY KEY (kind, lat, lon)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS response_cache (
      key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hourly_cache (
      kind TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, fetched_at INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (kind, lat, lon)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, units INTEGER NOT NULL, seed_units INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS seed_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Older databases: per-lane usage for the saved-dates lane (see LIMITS in upstream.ts).
  const cols = (db.prepare('PRAGMA table_info(usage)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('saved_units')) db.exec('ALTER TABLE usage ADD COLUMN saved_units INTEGER NOT NULL DEFAULT 0');
  // Older databases: feels-like highs/lows and snowfall (NULL on days stored before they were added).
  for (const t of ['era5_daily', 'forecast_daily']) {
    const have = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['atmax', 'atmin', 'snow']) if (!have.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} REAL`);
  }
  // Older databases: where each ERA5 day came from (see above).
  const era5Cols = (db.prepare('PRAGMA table_info(era5_daily)').all() as { name: string }[]).map((c) => c.name);
  if (!era5Cols.includes('source')) db.exec('ALTER TABLE era5_daily ADD COLUMN source TEXT');
  // Copernicus days with a value still to fill from Open-Meteo (keep in step with CDS_BLANK in weatherCache.ts).
  db.exec(`CREATE INDEX IF NOT EXISTS era5_cds_blank ON era5_daily (lat, lon, date) WHERE source = 'cds' AND (${CDS_BLANK})`);
  return db;
}
