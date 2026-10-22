import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from './db';
import { buildMapPoints, SavedPrefetcher, typicalWindows } from './savedPrefetch';
import { SavedRanges } from './savedRanges';
import { Upstream } from './upstream';
import { WeatherCache } from './weatherCache';

/** Returns synthetic daily data for whatever is asked and records each request. */
class FakeUpstream extends Upstream {
  urls: URL[] = [];
  async fetchJson<T>(url: string): Promise<T> {
    const u = new URL(url);
    this.urls.push(u);
    const lats = u.searchParams.get('latitude')!.split(',');
    const lons = u.searchParams.get('longitude')!.split(',');
    const start = u.searchParams.get('start_date') ?? new Date().toISOString().slice(0, 10);
    const days = u.searchParams.get('forecast_days') ? 16 : Math.round((Date.parse(u.searchParams.get('end_date')!) - Date.parse(start)) / 86_400_000) + 1;
    const time = Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10));
    const one = (i: number) => ({
      latitude: Number(lats[i]), longitude: Number(lons[i]), utc_offset_seconds: 0, timezone: 'GMT',
      daily: { time, precipitation_sum: time.map(() => 0), temperature_2m_max: time.map(() => 28), temperature_2m_min: time.map(() => 22), relative_humidity_2m_mean: time.map(() => 70) },
    });
    return (lats.length === 1 ? one(0) : lats.map((_, i) => one(i))) as T;
  }
}

describe('saved travel dates pre-fetch', () => {
  it('recounts progress at most once a minute, picking up history stored by others', () => {
    const db = openDb(':memory:');
    const up = new FakeUpstream(db);
    const cache = new WeatherCache(db, up);
    const saved = new SavedRanges(db);
    const year = new Date().getUTCFullYear() + 1;
    const r = saved.add({ label: 'Test', start: `${year}-03-02`, end: `${year}-03-04` }) as { id: number; start: string; end: string; label: string; created_at: number };
    const pf = new SavedPrefetcher(cache, up, saved, [{ name: 'Malacca', cc: 'MY', lat: 2.19, lon: 102.25 }]);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(pf.progress(r)).toMatchObject({ placesDone: 0, pct: 0 });
      // As scripts/import-era5-cds.py stores it, while the prefetcher itself is idle.
      const ins = db.prepare("INSERT INTO era5_daily (lat, lon, date, precip, tmax, tmin, rh, source) VALUES (2.19, 102.25, ?, 1, 30, 24, 80, 'cds')");
      for (const w of typicalWindows(r.start, r.end)) for (let d = w.start; d <= w.end; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) ins.run(d);
      clock.mockReturnValue(now + 30_000);
      expect(pf.progress(r).placesDone).toBe(0); // counted recently: not yet
      clock.mockReturnValue(now + 61_000);
      expect(pf.progress(r)).toMatchObject({ placesDone: 1, pct: 100, state: 'complete' });
    } finally {
      clock.mockRestore();
    }
  });

  it('builds the same-date windows the app uses (5 years, or 3 for long ranges)', () => {
    expect(typicalWindows('2026-12-04', '2026-12-08', '2026-10-19').map((w) => w.start)).toEqual(['2025-12-04', '2024-12-04', '2023-12-04', '2022-12-04', '2021-12-04']);
    expect(typicalWindows('2026-12-15', '2027-01-20', '2026-10-19')).toHaveLength(3);
  });

  it('orders map points: ferry and overland destinations, then popular cities first', () => {
    const pts = buildMapPoints(fileURLToPath(new URL('../public', import.meta.url)));
    expect(pts.length).toBeGreaterThan(300);
    // Ferry destinations and overland-only places first, then the busiest direct-flight cities.
    expect(pts.slice(0, 5).map((p) => p.name)).toEqual(expect.arrayContaining(['Batam', 'Bintan (Lagoi resorts)', 'Desaru Coast']));
    expect(pts.slice(0, 9).map((p) => p.name)).toEqual(expect.arrayContaining(['Johor Bahru', 'Muar', 'Port Dickson', 'Mersing']));
    expect(pts.slice(0, 14).map((p) => p.name)).toContain('Jakarta');
    // Overland places that also have a flight (Kuala Lumpur, Penang…) aren't listed twice.
    expect(pts.filter((p) => p.name === 'Kuala Lumpur')).toHaveLength(1);
    // Gateway destinations (no direct flight of their own) are included too.
    expect(pts.map((p) => p.name)).toEqual(expect.arrayContaining(['Hoi An', 'Kyoto', 'Ubud']));
    // Climate-zone cities (Sri Lanka's east…) come with the popular places, ahead of other gateways.
    const names = pts.map((p) => p.name);
    expect(names.indexOf('Trincomalee')).toBeGreaterThan(-1);
    expect(names.indexOf('Trincomalee')).toBeLessThan(names.indexOf('Hoi An'));
  });

  it('fetches every window for every place, then reports complete with no more requests', async () => {
    const db = openDb(':memory:');
    const up = new FakeUpstream(db);
    const cache = new WeatherCache(db, up);
    const saved = new SavedRanges(db);
    const year = new Date().getUTCFullYear() + 1;
    const r = saved.add({ label: 'Test', start: `${year}-03-02`, end: `${year}-03-06` }) as { id: number; start: string; end: string; label: string; created_at: number };
    const points = [
      { name: 'Bangkok', cc: 'TH', lat: 13.75, lon: 100.5 },
      { name: 'Tokyo', cc: 'JP', lat: 35.69, lon: 139.69 },
      { name: 'Perth', cc: 'AU', lat: -31.95, lon: 115.86 },
    ];
    const pf = new SavedPrefetcher(cache, up, saved, points);
    expect(pf.progress(r)).toMatchObject({ places: 3, placesDone: 0, years: 5 });

    let guard = 0;
    while (await pf.step()) if (++guard > 20) throw new Error('did not finish');
    expect(up.urls).toHaveLength(5); // one batched request per historical year
    expect(pf.progress(r)).toMatchObject({ placesDone: 3, state: 'complete' });
    expect(pf.hasWork()).toBe(false);

    // Editing the dates re-queues work for the new range only.
    saved.update(r.id, { end: `${year}-03-07` });
    expect(pf.progress(saved.get(r.id)!).placesDone).toBe(0);
    while (await pf.step()) if (++guard > 40) throw new Error('did not finish');
    expect(pf.progress(saved.get(r.id)!).state).toBe('complete');
  });
});
