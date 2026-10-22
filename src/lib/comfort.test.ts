import { describe, expect, it } from 'vitest';
import type { DailyWeather } from '../types';
import { analyseComfort, daylightOn, formatHours, tripDaylight } from './comfort';
import { addDays, type YearWindow } from './dates';

const minutes = (hhmm: string | null) => {
  const [h, m] = hhmm!.split(':').map(Number);
  return h * 60 + m;
};

describe('daylight', () => {
  it('matches published sunrise and sunset times', () => {
    // Singapore, 1 Jan: sunrise ~07:04, sunset ~19:08 (about 12h 03m).
    const sg = daylightOn('2025-01-01', 1.36, 103.99, 'Asia/Singapore');
    expect(Math.abs(minutes(sg.sunrise) - (7 * 60 + 4))).toBeLessThanOrEqual(4);
    expect(Math.abs(minutes(sg.sunset) - (19 * 60 + 10))).toBeLessThanOrEqual(4);
    expect(Math.abs(sg.hours - 12.05)).toBeLessThan(0.1);
    // Sapporo, 15 Jan: sunrise ~07:04, sunset ~16:24 (solar noon ~11:44 JST, about 9h 20m).
    const sp = daylightOn('2025-01-15', 43.06, 141.35, 'Asia/Tokyo');
    expect(Math.abs(minutes(sp.sunrise) - (7 * 60 + 4))).toBeLessThanOrEqual(6);
    expect(Math.abs(minutes(sp.sunset) - (16 * 60 + 24))).toBeLessThanOrEqual(6);
    // London in June uses summer time (BST): sunset ~21:21.
    const ld = daylightOn('2025-06-21', 51.5, -0.12, 'Europe/London');
    expect(Math.abs(minutes(ld.sunset) - (21 * 60 + 21))).toBeLessThanOrEqual(4);
  });

  it('handles polar night and midnight sun', () => {
    expect(daylightOn('2024-12-21', 69.65, 18.96, 'Europe/Oslo').polar).toBe('night');
    expect(daylightOn('2025-06-21', 69.65, 18.96, 'Europe/Oslo').polar).toBe('day');
  });

  it('compares with Singapore and leaves times out without a time zone', () => {
    const d = tripDaylight('2025-01-10', '2025-01-14', 43.06, 141.35);
    expect(d.vsHomeHours).toBeLessThan(-2);
    expect(d.first.sunrise).toBeNull();
    expect(formatHours(-2.5)).toBe('2h 30m');
    expect(formatHours(0.25)).toBe('15m');
  });
});

/** Windows for the same 5 trip days in each of `years`, with daily values from `day`. */
function build(years: number[], day: (year: number, i: number) => Partial<DailyWeather>) {
  const windows: YearWindow[] = years.map((y) => ({ year: y, start: `${y}-01-10`, end: `${y}-01-14` }) as YearWindow);
  const daily: DailyWeather[] = windows.flatMap((w) =>
    Array.from({ length: 5 }, (_, i) => ({ date: addDays(w.start, i), precipMm: 0, tMaxC: 30, tMinC: 24, rhMeanPct: 80, ...day(w.year, i) })),
  );
  return { windows, daily };
}

describe('comfort', () => {
  it('reports muggy heat and very hot feels-like days', () => {
    const { windows, daily } = build([2024, 2023, 2022], (_, i) => ({ tMaxC: 33, feelsMaxC: i < 2 ? 40 : 37, feelsMinC: 28, snowCm: 0 }));
    const c = analyseComfort(daily, windows, '2026-01-10', '2026-01-14', { lat: 13.75, lon: 100.5, timeZone: 'Asia/Bangkok' }, 33);
    expect(c.feelsLike!.highGap).toBeCloseTo(5.2, 5);
    expect(c.feelsLike!.veryHotDaysMean).toBe(2);
    expect(c.feelsLike!.hottest).toBe(40);
    expect(c.notes.some((n) => n.includes('hotter than the thermometer'))).toBe(true);
    expect(c.notes.some((n) => n.includes('2 days that feel 38'))).toBe(true);
    // No snow in any year: no snow note.
    expect(c.nights!.snow!.yearsWithSnow).toBe(0);
    expect(c.notes.some((n) => /snow/i.test(n))).toBe(false);
  });

  it('reports frost, the coldest night and snow', () => {
    const { windows, daily } = build([2024, 2023, 2022, 2021], (y, i) => ({
      tMaxC: 1,
      tMinC: y === 2022 && i === 3 ? -12 : -6,
      feelsMaxC: -3,
      feelsMinC: -11,
      snowCm: y === 2024 && i < 2 ? 4 : 0,
    }));
    const c = analyseComfort(daily, windows, '2026-01-10', '2026-01-14', { lat: 43.06, lon: 141.35, timeZone: 'Asia/Tokyo' }, 1);
    expect(c.nights!.frostNightsMean).toBe(5);
    expect(c.nights!.coldest).toEqual({ c: -12, year: 2022 });
    expect(c.nights!.snow).toEqual({ years: 4, daysMean: 0.5, yearsWithSnow: 1 });
    expect(c.feelsLike!.freezingDaysMean).toBe(5);
    expect(c.notes.some((n) => n.startsWith('Frost on about 5 nights'))).toBe(true);
    expect(c.notes.some((n) => n.startsWith('Snow is likely'))).toBe(true);
    expect(c.notes.some((n) => n.startsWith('Short days'))).toBe(true);
  });

  it('still reports nights when feels-like and snow are unavailable', () => {
    const { windows, daily } = build([2024, 2023], () => ({ tMaxC: 26, tMinC: 12 }));
    const c = analyseComfort(daily, windows, '2026-01-10', '2026-01-14', { lat: 25, lon: 121 }, 26);
    expect(c.feelsLike).toBeNull();
    expect(c.nights!.snow).toBeNull();
    expect(c.nights!.coolNightsMean).toBe(5);
    expect(c.notes.some((n) => n.includes('light jacket'))).toBe(true);
    expect(c.notes.some((n) => n.includes('day-night swing'))).toBe(true);
  });
});
