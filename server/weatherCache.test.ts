import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { buildSeedPoints } from './seeder';
import { unitsFor, Upstream } from './upstream';
import { WeatherCache } from './weatherCache';

/** Upstream double that records requests and returns synthetic ERA5 data. */
class FakeUpstream extends Upstream {
  calls: { url: URL; units: number }[] = [];
  async fetchJson<T>(url: string, units: number): Promise<T> {
    const u = new URL(url);
    this.calls.push({ url: u, units });
    const lats = u.searchParams.get('latitude')!.split(',');
    const start = u.searchParams.get('start_date')!;
    const end = u.searchParams.get('end_date')!;
    const time: string[] = [];
    for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) time.push(d.toISOString().slice(0, 10));
    const one = (lat: string) => ({
      latitude: Number(lat),
      longitude: 100,
      utc_offset_seconds: 25200,
      timezone: 'Asia/Bangkok',
      daily: { time, precipitation_sum: time.map(() => 1), temperature_2m_max: time.map(() => 30), temperature_2m_min: time.map(() => 22), relative_humidity_2m_mean: time.map(() => 70),
        apparent_temperature_max: time.map(() => 36),
        apparent_temperature_min: time.map(() => 25),
        snowfall_sum: time.map(() => 0),
      },
    });
    return (lats.length === 1 ? one(lats[0]) : lats.map(one)) as T;
  }
}

describe('weather cache', () => {
  it('keeps Copernicus days: Open-Meteo only fills their blanks, when a request needs them', async () => {
    const db = openDb(':memory:');
    const up = new FakeUpstream(db);
    const cache = new WeatherCache(db, up);
    const loc = { lat: 13.75, lon: 100.5 };
    // As scripts/import-era5-cds.py stores them: no snowfall.
    const ins = db.prepare("INSERT INTO era5_daily (lat, lon, date, precip, tmax, tmin, rh, atmax, atmin, snow, source) VALUES (?, ?, ?, 5, 33, 24, 80, 39, 27, NULL, 'cds')");
    for (const d of ['2024-11-17', '2024-11-18', '2024-11-19']) ins.run(loc.lat, loc.lon, d);
    // Complete for what the background fetchers ask (no variables named): no request.
    await cache.ensureEra5([loc], '2024-11-17', '2024-11-19');
    expect(up.calls).toHaveLength(0);
    // A request for snowfall fetches it, without touching the Copernicus values.
    await cache.ensureEra5([loc], '2024-11-17', '2024-11-19', { vars: ['temperature_2m_max', 'snowfall_sum'] });
    expect(up.calls).toHaveLength(1);
    const rows = db.prepare('SELECT tmax, snow, source FROM era5_daily WHERE lat = ? AND lon = ? ORDER BY date').all(loc.lat, loc.lon);
    expect(rows).toEqual(Array(3).fill({ tmax: 33, snow: 0, source: 'cds' }));
    await cache.ensureEra5([loc], '2024-11-17', '2024-11-19', { vars: ['temperature_2m_max', 'snowfall_sum'] });
    expect(up.calls).toHaveLength(1);
  });

  it('offers each Copernicus place-year with a blank to the seeder once', () => {
    const db = openDb(':memory:');
    const cache = new WeatherCache(db, new FakeUpstream(db));
    const ins = db.prepare("INSERT INTO era5_daily (lat, lon, date, precip, tmax, tmin, rh, atmax, atmin, snow, source) VALUES (?, ?, ?, 5, 33, 24, 80, 39, 27, ?, 'cds')");
    ins.run(1, 2, '2023-03-01', null);
    ins.run(1, 2, '2023-04-01', null);
    ins.run(1, 2, '2024-01-05', null);
    ins.run(3, 4, '2023-01-01', 0); // nothing blank
    const first = cache.cdsBlank()!;
    expect(first).toEqual({ loc: { lat: 1, lon: 2 }, start: '2023-03-01', end: '2023-12-31' });
    expect(cache.cdsBlank()).toEqual(first); // not done yet: offered again
    cache.cdsBlankDone(first);
    const second = cache.cdsBlank()!;
    expect(second.start).toBe('2024-01-05');
    cache.cdsBlankDone(second);
    expect(cache.cdsBlank()).toBeNull();
  });

  it('counts units like Open-Meteo (per 14 days and per 10 variables)', () => {
    expect(unitsFor(1, 7, 4)).toBe(1);
    expect(unitsFor(3, 16, 4)).toBe(6);
    expect(unitsFor(1, 365, 4)).toBe(27);
    expect(unitsFor(2, 1, 12)).toBe(4);
  });

  it('stores ERA5 days and only fetches missing ranges', async () => {
    const db = openDb(':memory:');
    const up = new FakeUpstream(db);
    const cache = new WeatherCache(db, up);
    const loc = { lat: 13.754, lon: 100.501 };
    await cache.ensureEra5([loc], '2024-11-17', '2024-11-23');
    expect(up.calls).toHaveLength(1);
    // Fully inside the stored range: no upstream call.
    await cache.ensureEra5([{ lat: 13.7541, lon: 100.5012 }], '2024-11-19', '2024-11-21');
    expect(up.calls).toHaveLength(1);
    // Partly overlapping: only the missing days are requested.
    await cache.ensureEra5([loc], '2024-11-20', '2024-11-26');
    expect(up.calls).toHaveLength(2);
    expect(up.calls[1].url.searchParams.get('start_date')).toBe('2024-11-24');
    const r = cache.readEra5({ lat: 13.75, lon: 100.5 }, '2024-11-17', '2024-11-26', ['precipitation_sum', 'temperature_2m_max']);
    expect(r.daily.time).toHaveLength(10);
    expect(r.timezone).toBe('Asia/Bangkok');
  });

  it('refetches days stored before feels-like and snowfall were added, only when asked for', async () => {
    const db = openDb(':memory:');
    const up = new FakeUpstream(db);
    const cache = new WeatherCache(db, up);
    const loc = { lat: 13.75, lon: 100.5 };
    // A day stored by an older version: base variables only.
    const ins = db.prepare('INSERT INTO era5_daily (lat, lon, date, precip, tmax, tmin, rh) VALUES (?,?,?,?,?,?,?)');
    for (const d of ['2024-11-17', '2024-11-18', '2024-11-19']) ins.run(loc.lat, loc.lon, d, 0, 31, 23, 75);
    await cache.ensureEra5([loc], '2024-11-17', '2024-11-19');
    expect(up.calls).toHaveLength(0);
    expect(cache.era5Gaps(loc, '2024-11-17', '2024-11-19')).toBe(0);
    expect(cache.era5Gaps(loc, '2024-11-17', '2024-11-19', ['apparent_temperature_max'])).toBe(3);

    await cache.ensureEra5([loc], '2024-11-17', '2024-11-19', { vars: ['precipitation_sum', 'apparent_temperature_max', 'snowfall_sum'] });
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0].url.searchParams.get('daily')).toContain('apparent_temperature_min');
    const r = cache.readEra5(loc, '2024-11-17', '2024-11-19', ['apparent_temperature_max', 'snowfall_sum']);
    expect(r.daily.apparent_temperature_max).toEqual([36, 36, 36]);
    expect(r.daily.snowfall_sum).toEqual([0, 0, 0]);
    // Now complete: no further calls.
    await cache.ensureEra5([loc], '2024-11-17', '2024-11-19', { vars: ['apparent_temperature_max'] });
    expect(up.calls).toHaveLength(1);
  });

  it('reuses stored data for requests within 10 km', async () => {
    const db = openDb(':memory:');
    const up = new FakeUpstream(db);
    const cache = new WeatherCache(db, up);
    await cache.ensureEra5([{ lat: 22.62, lon: 120.3 }], '2024-04-01', '2024-04-07');
    // A geocoded point ~3 km away is served from the stored place.
    await cache.ensureEra5([{ lat: 22.6273, lon: 120.3014 + 0.02 }], '2024-04-02', '2024-04-05');
    expect(up.calls).toHaveLength(1);
    expect(cache.resolve('era5', { lat: 22.64, lon: 120.32 })).toEqual({ lat: 22.62, lon: 120.3 });
    // 30 km away is a different place.
    expect(cache.resolve('era5', { lat: 22.9, lon: 120.3 })).toEqual({ lat: 22.9, lon: 120.3 });
  });

  it('orders seed points: popular, Southeast Asia, Asia, rest', () => {
    const pts = buildSeedPoints(fileURLToPath(new URL('../public', import.meta.url)));
    const tiers = pts.map((p) => p.tier);
    expect(tiers).toEqual([...tiers].sort());
    expect(pts[0].tier).toBe(1);
    expect(pts.find((p) => p.tier === 2)?.cc).toMatch(/^(BN|KH|ID|LA|MY|MM|PH|SG|TH|TL|VN)$/);
    expect(pts.some((p) => p.name === 'Kuala Lumpur' && p.tier === 1)).toBe(true);
    // Climate-zone cities colour whole regions of the map, so they're popular too.
    expect(pts.find((p) => p.name === 'Trincomalee')?.tier).toBe(1);
    expect(pts.find((p) => p.name === 'Legazpi')?.tier).toBe(1);
  });
});
