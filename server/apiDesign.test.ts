import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { createHandler } from './handler';
import type { Seeder } from './seeder';
import { LIMITS, Upstream, UpstreamError } from './upstream';
import { WantedQueue } from './wanted';
import { WeatherCache } from './weatherCache';

/** ERA5 double: synthetic data, optional failures for some latitudes, and a call log. */
class FakeUpstream extends Upstream {
  calls: string[] = [];
  failLat: number | null = null;
  delayMs = 0;
  /** Also return feels-like and snowfall. */
  extended = false;
  async fetchJson<T>(url: string): Promise<T> {
    const u = new URL(url);
    this.calls.push(url);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const lats = u.searchParams.get('latitude')!.split(',');
    if (this.failLat !== null && lats.some((l) => Number(l) === this.failLat)) throw new UpstreamError('Weather API budget is temporarily used up; please retry shortly.', 429, 20);
    const start = u.searchParams.get('start_date')!;
    const end = u.searchParams.get('end_date')!;
    const time: string[] = [];
    for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) time.push(d.toISOString().slice(0, 10));
    const one = (lat: string) => ({ latitude: Number(lat), longitude: 100, utc_offset_seconds: 0, timezone: 'GMT', daily: { time, precipitation_sum: time.map(() => 1), temperature_2m_max: time.map(() => 30), temperature_2m_min: time.map(() => 22), relative_humidity_2m_mean: time.map(() => 70), ...(this.extended ? { apparent_temperature_max: time.map(() => 35), apparent_temperature_min: time.map(() => 25), snowfall_sum: time.map(() => 0) } : {}) } });
    return (lats.length === 1 ? one(lats[0]) : lats.map(one)) as T;
  }
}

function setup() {
  const db = openDb(':memory:');
  const up = new FakeUpstream(db);
  const cache = new WeatherCache(db, up);
  const wanted = new WantedQueue(db, cache, up);
  const handler = createHandler(cache, { status: () => ({}) } as unknown as Seeder, wanted);
  const get = async (qs: string) => {
    let status = 0;
    let body = '';
    const res = { writeHead: (s: number) => ((status = s), res), end: (b: string) => (body = b) } as never;
    await handler({ url: `/api/om/archive?${qs}` } as never, res, () => undefined);
    return { status, body: JSON.parse(body) };
  };
  return { db, up, cache, wanted, get };
}

const Q = (lats: number[], extra = '') =>
  `latitude=${lats.join(',')}&longitude=${lats.map(() => 100).join(',')}&start_date=2024-12-04&end_date=2024-12-08&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean&models=era5&timezone=auto${extra}`;

describe('API call design', () => {
  it("doesn't wait for budget that can't free up in time (today's allowance used up)", async () => {
    const db = openDb(':memory:');
    const up = new Upstream(db);
    db.prepare('INSERT INTO usage (day, units) VALUES (?, ?)').run(new Date().toISOString().slice(0, 10), LIMITS.perDay);
    const t = Date.now();
    await expect(up.fetchJson('http://localhost:1/never', 1)).rejects.toMatchObject({ status: 429 });
    expect(Date.now() - t).toBeLessThan(500); // not the 3 s interactive wait
  });

  it("serves stored days straight away when only snowfall is blank, and queues it", async () => {
    const { db, up, wanted, get } = setup();
    // As the Copernicus import stores them: feels-like, no snowfall.
    const ins = db.prepare("INSERT INTO era5_daily (lat, lon, date, precip, tmax, tmin, rh, atmax, atmin, snow, source) VALUES (1, 100, ?, 1, 30, 22, 70, 35, 25, NULL, 'cds')");
    for (const d of ['2024-12-04', '2024-12-05', '2024-12-06', '2024-12-07', '2024-12-08']) ins.run(d);
    const ext = Q([1]).replace('relative_humidity_2m_mean', 'relative_humidity_2m_mean,apparent_temperature_max,apparent_temperature_min,snowfall_sum');
    const r = await get(ext);
    expect(up.calls).toHaveLength(0);
    expect(r.status).toBe(200);
    expect(r.body.missing).toBeUndefined();
    expect(r.body.daily.apparent_temperature_max).toEqual([35, 35, 35, 35, 35]);
    expect(r.body.daily.snowfall_sum).toEqual([null, null, null, null, null]);
    expect(wanted.count()).toBe(1);
    // The background fills snowfall, without changing the Copernicus values.
    up.extended = true;
    expect(await wanted.step()).toBe(true);
    expect(up.calls).toHaveLength(1);
    expect(wanted.count()).toBe(0);
    expect((await get(ext)).body.daily.snowfall_sum).toEqual([0, 0, 0, 0, 0]);
    expect(db.prepare("SELECT DISTINCT tmax, source FROM era5_daily").all()).toEqual([{ tmax: 30, source: 'cds' }]);
  });

  it('returns every stored place even when one place in the batch fails', async () => {
    const { up, cache, get } = setup();
    await cache.ensureEra5([{ lat: 1, lon: 100 }, { lat: 2, lon: 100 }], '2024-12-04', '2024-12-08');
    up.failLat = 3;
    const r = await get(Q([1, 2, 3]));
    expect(r.status).toBe(200);
    expect(r.body[0].daily.time).toHaveLength(5);
    expect(r.body[1].missing).toBeUndefined();
    expect(r.body[2]).toMatchObject({ missing: true });
    expect(r.body[2].reason).toMatch(/budget/);
    // A single-place request (the trip analysis) still gets the error, so it can retry.
    expect((await get(Q([3]))).status).toBe(429);
  });

  it('stored-only reads never call the API and queue the gaps for the background', async () => {
    const { up, cache, wanted, get } = setup();
    await cache.ensureEra5([{ lat: 1, lon: 100 }], '2024-12-04', '2024-12-08');
    const before = up.calls.length;
    const r = await get(Q([1, 4], '&stored=1'));
    expect(up.calls.length).toBe(before);
    expect(r.body[0].missing).toBeUndefined();
    expect(r.body[1]).toMatchObject({ missing: true });
    expect(wanted.count()).toBe(1);
    // The seeder's step fetches it on the saved-dates lane, then the queue empties.
    expect(await wanted.step()).toBe(true);
    expect(wanted.count()).toBe(0);
    expect((await get(Q([4], '&stored=1'))).body.missing).toBeUndefined();
  });

  it('shares an upstream fetch between concurrent identical requests', async () => {
    const { up, cache } = setup();
    up.delayMs = 30;
    await Promise.all([cache.ensureEra5([{ lat: 5, lon: 100 }], '2024-12-04', '2024-12-08'), cache.ensureEra5([{ lat: 5, lon: 100 }], '2024-12-04', '2024-12-08')]);
    expect(up.calls).toHaveLength(1);
  });

  it('keeps separate daily caps for the saved-dates lane and general seeding', () => {
    const { db, up } = setup();
    const day = new Date().toISOString().slice(0, 10);
    up.lastInteractiveAt = 0;
    db.prepare('INSERT INTO usage (day, units, seed_units, saved_units) VALUES (?, ?, ?, ?)').run(day, LIMITS.savedPerDay, 0, LIMITS.savedPerDay);
    expect(up.canSpend(10, 'saved')).toBe(false); // saved lane full…
    expect(up.canSpend(10, true)).toBe(true); // …general seeding still runs
    db.prepare('UPDATE usage SET units = ?, seed_units = ? WHERE day = ?').run(LIMITS.perDay - LIMITS.interactiveReserve, LIMITS.seedPerDay, day);
    expect(up.canSpend(10, true)).toBe(false);
    expect(up.canSpend(10, false)).toBe(true); // your own searches keep the reserve
  });
});
