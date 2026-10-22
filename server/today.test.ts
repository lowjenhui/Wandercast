import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { Upstream } from './upstream';
import { createHandler } from './handler';
import type { Seeder } from './seeder';
import { NOW_VARS, WeatherCache } from './weatherCache';

class HourlyFake extends Upstream {
  calls = 0;
  async fetchJson<T>(url: string): Promise<T> {
    this.calls++;
    const u = new URL(url);
    const vars = u.searchParams.get('hourly')!.split(',');
    const lats = u.searchParams.get('latitude')!.split(',');
    // 48 hours from local midnight (UTC+8) today.
    const midnight = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const time = Array.from({ length: 48 }, (_, h) => new Date(Date.parse(`${midnight}T00:00:00Z`) + h * 3600_000).toISOString().slice(0, 13) + ':00');
    const one = (lat: string) => ({
      latitude: Number(lat), longitude: 104, utc_offset_seconds: 8 * 3600, timezone: 'Asia/Singapore',
      hourly: Object.fromEntries([['time', time], ...vars.map((v) => [v, time.map((_, h) => h)])]),
    });
    return (lats.length === 1 ? one(lats[0]) : lats.map(one)) as T;
  }
}

describe('"Right now" from stored hourly data', () => {
  it('fetches once, then answers the current hour from the database', async () => {
    const db = openDb(':memory:');
    const up = new HourlyFake(db);
    const cache = new WeatherCache(db, up);
    const locs = [{ lat: 1.29, lon: 103.85 }, { lat: 1.13, lon: 104.05 }];
    await cache.ensureToday('forecast', locs);
    expect(up.calls).toBe(1);
    expect(cache.todayFresh('forecast', locs[0])).toBe(true);
    await cache.ensureToday('forecast', [{ lat: 1.2905, lon: 103.8502 }]); // same place, re-requested
    expect(up.calls).toBe(1);

    const now = cache.readNow('forecast', locs[0], ['temperature_2m', 'weather_code']) as { current: Record<string, unknown> };
    const localHour = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 13) + ':00';
    expect(now.current.time).toBe(localHour);
    expect(now.current.temperature_2m).toBe(Number(localHour.slice(11, 13)));
    expect(Object.keys(now.current)).toEqual(['time', 'interval', 'temperature_2m', 'weather_code']);
    expect(NOW_VARS.forecast).toContain('visibility');
  });

  it('serves the map from the database and calls the API only on reload', async () => {
    const db = openDb(':memory:');
    const up = new HourlyFake(db);
    const cache = new WeatherCache(db, up);
    const handler = createHandler(cache, {} as Seeder);
    const get = async (extra = '') => {
      let body = '';
      const res = { writeHead: () => res, end: (b: string) => (body = b) } as never;
      await handler({ url: `/api/om/forecast?latitude=1.290&longitude=103.850&current=temperature_2m,weather_code&timezone=auto${extra}` } as never, res, () => undefined);
      return JSON.parse(body) as { current?: { time: string }; fetched_at?: number; snapshot?: boolean } | null;
    };
    expect(await get()).toBeNull(); // nothing stored, and no API call
    expect(up.calls).toBe(0);
    const fresh = await get('&refresh=1');
    expect(up.calls).toBe(1);
    expect(fresh?.snapshot).toBe(false);
    expect(typeof fresh?.fetched_at).toBe('number');
    await get();
    await get('&refresh=1'); // loaded within the last hour: reused
    expect(up.calls).toBe(1);

    // Three days later the stored 48 h no longer cover "now": show the hour it was loaded.
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 24 * 3600_000;
    try {
      const old = await get();
      expect(old?.snapshot).toBe(true);
      expect(up.calls).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});
