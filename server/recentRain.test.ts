import { describe, expect, it } from 'vitest';
import { addDays, shiftYears } from '../src/lib/dates';
import { recentRainLevel } from '../src/lib/recentRain';
import { openDb, type DB } from './db';
import { RecentRainStore } from './recentRain';
import { Upstream } from './upstream';
import { WeatherCache } from './weatherCache';

const loc = { lat: 13.75, lon: 100.5 };
const END = '2026-10-20';

function seed(db: DB, table: 'era5_daily' | 'forecast_daily', from: string, to: string, mm: (date: string) => number) {
  const ins =
    table === 'era5_daily'
      ? db.prepare("INSERT OR REPLACE INTO era5_daily (lat, lon, date, precip, source) VALUES (?,?,?,?,'om')")
      : db.prepare('INSERT OR REPLACE INTO forecast_daily (lat, lon, date, precip, fetched_at) VALUES (?,?,?,?,0)');
  for (let d = from; d <= to; d = addDays(d, 1)) ins.run(loc.lat, loc.lon, d, mm(d));
}

function store() {
  const db = openDb(':memory:');
  const s = new RecentRainStore(db, new WeatherCache(db, new Upstream(db)));
  // Ten past years at 5 mm a day, every other day (a normal of 75 mm and 15 wet days in 30).
  for (let k = 1; k <= 10; k++) seed(db, 'era5_daily', shiftYears(addDays(END, -100), -k), shiftYears(END, -k), (d) => (Number(d.slice(8)) % 2 ? 5 : 0));
  return { db, s };
}

describe('recent rain vs normal', () => {
  it('sets levels from the 30-day and 7-day multiples', () => {
    expect(recentRainLevel({ mm30: 110, normal30: 100, mm7: 30, normal7: 25 })).toBe('usual');
    expect(recentRainLevel({ mm30: 160, normal30: 100, mm7: 30, normal7: 25 })).toBe('wetter');
    expect(recentRainLevel({ mm30: 210, normal30: 100, mm7: 30, normal7: 25 })).toBe('much-wetter');
    // A wet week alone: 2× and 3× normal over 7 days.
    expect(recentRainLevel({ mm30: 100, normal30: 100, mm7: 50, normal7: 25 })).toBe('wetter');
    expect(recentRainLevel({ mm30: 100, normal30: 100, mm7: 80, normal7: 25 })).toBe('much-wetter');
  });

  it('ignores dry places and small showers', () => {
    // Normal under 30 mm a month: one storm would read as many times normal.
    expect(recentRainLevel({ mm30: 90, normal30: 20, mm7: 90, normal7: 5 })).toBe('usual');
    // 7 days at 4× normal, but only 20 mm.
    expect(recentRainLevel({ mm30: 60, normal30: 60, mm7: 20, normal7: 5 })).toBe('usual');
  });

  it('joins settled ERA5 with stored forecast days and compares with the same days in past years', () => {
    const { db, s } = store();
    // ERA5 settles 10 days behind; the forecast's past days fill the rest. 10 mm every day.
    seed(db, 'era5_daily', addDays(END, -100), addDays(END, -10), () => 10);
    seed(db, 'forecast_daily', addDays(END, -11), END, () => 10);
    const r = s.compute(loc, END, { weeks: true })!;
    expect(r.mm30).toBeCloseTo(300);
    expect(r.normal30).toBeGreaterThan(70);
    expect(r.normal30).toBeLessThan(80);
    expect(r.wetDays30).toBe(30);
    expect(r.usualWetDays30).toBeGreaterThan(14);
    expect(r.years).toBe(10);
    expect(r.level).toBe('much-wetter');
    expect(r.weeks).toHaveLength(12);
    expect(r.weeks![11].mm).toBeCloseTo(70);
  });

  it('leaves a place out when too few recent days or past years are stored', () => {
    const { db, s } = store();
    seed(db, 'era5_daily', addDays(END, -100), addDays(END, -10), () => 10);
    // Days END-9 to END missing: only 20 of the last 30.
    expect(s.compute(loc, END)).toBeNull();
    expect(s.all(END)).toEqual([]);

    const bare = openDb(':memory:');
    seed(bare, 'era5_daily', addDays(END, -40), END, () => 10);
    expect(new RecentRainStore(bare, new WeatherCache(bare, new Upstream(bare))).compute(loc, END)).toBeNull();
  });
});
