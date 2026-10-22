import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { SavedRanges } from './savedRanges';
import { dedupeByName, readyYears, SunnyPrefetcher, sunnyParts } from './sunnyWindows';
import { Upstream } from './upstream';
import { roundLoc, WeatherCache } from './weatherCache';

function setup() {
  const db = openDb(':memory:');
  const up = new Upstream(db);
  const cache = new WeatherCache(db, up);
  const saved = new SavedRanges(db);
  const points = [
    { name: 'Bangkok', cc: 'TH', ...roundLoc({ lat: 13.75, lon: 100.5 }), tier: 1 as const },
    { name: 'Tokyo', cc: 'JP', ...roundLoc({ lat: 35.68, lon: 139.69 }), tier: 1 as const },
    { name: 'Kuala Lumpur', cc: 'MY', ...roundLoc({ lat: 3.14, lon: 101.69 }), tier: 1 as const },
    { name: 'Ulaanbaatar', cc: 'MN', ...roundLoc({ lat: 47.92, lon: 106.92 }), tier: 3 as const },
  ];
  const sunny = new SunnyPrefetcher(db, cache, up, saved, () => points, '/nonexistent');
  const store = (lat: number, lon: number, start: string, end: string) => {
    const ins = db.prepare('INSERT OR REPLACE INTO era5_daily (lat, lon, date, precip, tmax, tmin, rh) VALUES (?,?,?,0,30,24,70)');
    for (let d = start; d <= end; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) ins.run(lat, lon, d);
  };
  return { db, sunny, saved, store, bkk: points[0] };
}

describe('sunny windows history', () => {
  it('splits the history Sunny windows reads by calendar year, stopping before unsettled days', () => {
    const parts = sunnyParts('2026-10-21');
    expect(parts).toHaveLength(11);
    expect(parts[0]).toEqual({ year: 2016, start: '2016-09-11', end: '2016-12-31' });
    expect(parts[10]).toEqual({ year: 2026, start: '2026-01-01', end: '2026-10-10' });
    expect(readyYears(parts)).toBe(10);
  });

  it('lists stored places with their complete years, named from the seed list', () => {
    const { sunny, store, bkk } = setup();
    const parts = sunnyParts();
    // All years but the current one: still ready (one missing year is allowed).
    parts.slice(0, -1).forEach((p) => store(bkk.lat, bkk.lon, p.start, p.end));
    // An unnamed place with two years.
    parts.slice(-2).forEach((p) => store(10, 20, p.start, p.end));
    const lib = sunny.libraryList();
    const b = lib.places.find((p) => p.name === 'Bangkok')!;
    expect(b).toMatchObject({ status: 'ready', years: parts.length - 1, needed: parts.length, saved: false, queue: null });
    const other = lib.places.find((p) => p.name.startsWith('10.0°N'))!;
    expect(other).toMatchObject({ status: 'partial', years: 2, cc: '' });
  });

  it('queues saved destinations and library requests, and reports their progress', () => {
    const { sunny, saved } = setup();
    const r = saved.add({ label: 'Trip', start: '2099-01-01', end: '2099-01-05' });
    if (typeof r === 'string') throw new Error(r);
    saved.addDestination(r.id, { name: 'Da Nang', country: 'Vietnam', cc: 'VN', lat: 16.07, lon: 108.22, code: 'DAD' });
    expect(sunny.request({ name: 'Osaka', cc: 'jp', lat: 34.69, lon: 135.5 })).toBeNull();
    expect(sunny.request({ name: '', cc: 'JP', lat: 1, lon: 1 })).toMatch(/required/);
    expect(sunny.hasWork()).toBe(true);
    const lib = sunny.libraryList();
    expect(lib.places.find((p) => p.name === 'Da Nang')).toMatchObject({ saved: true, status: 'none', queue: 'queued', code: 'DAD' });
    expect(lib.places.find((p) => p.name === 'Osaka')).toMatchObject({ saved: false, status: 'none', queue: 'queued', cc: 'JP' });
    expect(sunny.progress({ lat: 16.07, lon: 108.22 })).toMatchObject({ years: 0, ready: false, state: 'queued' });
  });

  it('orders the queue: daydream dates by trip start, downloads, then popular places nearest first', () => {
    const { sunny, saved } = setup();
    const later = saved.add({ label: 'Later', start: '2099-06-01', end: '2099-06-05' });
    const sooner = saved.add({ label: 'Sooner', start: '2099-01-01', end: '2099-01-05' });
    const past = saved.add({ label: 'Past', start: '2000-01-01', end: '2000-01-05' });
    if (typeof later === 'string' || typeof sooner === 'string' || typeof past === 'string') throw new Error('add failed');
    saved.addDestination(later.id, { name: 'Da Nang', country: 'Vietnam', cc: 'VN', lat: 16.07, lon: 108.22 });
    saved.addDestination(sooner.id, { name: 'Taipei', country: 'Taiwan', cc: 'TW', lat: 25.03, lon: 121.56 });
    saved.addDestination(past.id, { name: 'Perth', country: 'Australia', cc: 'AU', lat: -31.95, lon: 115.86 });
    sunny.request({ name: 'Osaka', cc: 'JP', lat: 34.69, lon: 135.5 });
    const order = sunny
      .libraryList()
      .places.filter((p) => p.priority !== null)
      .sort((a, b) => a.priority! - b.priority!)
      .map((p) => p.name);
    // Past trips and non-popular seed places aren't queued.
    expect(order).toEqual(['Taipei', 'Da Nang', 'Osaka', 'Kuala Lumpur', 'Bangkok', 'Tokyo']);
    expect(sunny.hasWork({ popular: false })).toBe(true);
    expect(sunny.hasWork({ popular: true })).toBe(true);
  });
});

describe('library rows', () => {
  it('merges the same city named twice in neighbouring weather cells', () => {
    const base = { cc: 'TH', saved: false, priority: null };
    const out = dedupeByName([
      { ...base, name: 'Koh Samui', lat: 9.56, lon: 100.06, years: 9 },
      { ...base, name: 'Koh Samui', lat: 9.54, lon: 99.94, years: 11 },
      { ...base, name: 'Phuket', lat: 7.88, lon: 98.39, years: 11 },
    ]);
    expect(out.map((p) => `${p.name}:${p.lon}`).sort()).toEqual(['Koh Samui:99.94', 'Phuket:98.39']);
  });
});
