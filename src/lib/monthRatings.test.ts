import { describe, expect, it } from 'vitest';
import { bestMonthsLabel, goodIn, monthRatings, nextGoodMonth, type MonthRating } from './monthRatings';
import { flagOf, regionOf } from './regions';

const r = (rating: MonthRating['rating']): MonthRating => ({ rating, score: 0, wetShare: 0 });
const P = r('Pleasant');
const G = r('Generally pleasant');
const M = r('Mixed');
const C = r('Challenging');

describe('month ratings', () => {
  it('rates complete months only, with at least three years', () => {
    const rows = [2019, 2020, 2021].map((y) => ({ ym: `${y}-01`, valid: 31, wet: 2, heavy: 0, tMax: 27, tMin: 18, rh: 60 }));
    const out = monthRatings([...rows, { ym: '2022-02', valid: 10, wet: 0, heavy: 0, tMax: 27, tMin: 18, rh: 60 }], () => []);
    expect(out[0]?.rating).toBe('Pleasant');
    expect(out[0]?.wetShare).toBeCloseTo(2 / 31);
    expect(out[1]).toBeNull(); // one incomplete February only
  });

  it('labels best months, wrapping across the new year', () => {
    expect(bestMonthsLabel([P, P, G, M, C, C, C, C, C, M, G, P])).toBe('Dec–Feb');
    expect(bestMonthsLabel([M, G, G, M, C, C, C, C, C, C, C, C])).toBe('Feb–Mar');
    expect(bestMonthsLabel(Array(12).fill(C))).toBeNull();
    expect(bestMonthsLabel(Array(12).fill(P))).toBe('All year');
  });

  it('finds the next good month (either shade of green)', () => {
    const year = [P, G, M, C, C, C, C, C, C, C, G, P];
    expect(nextGoodMonth(year, 1)).toBe('now');
    expect(nextGoodMonth(year, 4)).toBe('Nov');
    expect(nextGoodMonth(Array(12).fill(M), 4)).toBeNull();
    expect(goodIn(year, 2)).toBe(true);
    expect(goodIn(year, 3)).toBe(false);
  });

  it('groups countries into regions, with Southeast Asia apart', () => {
    expect(regionOf('th')).toBe('Southeast Asia');
    expect(regionOf('CN')).toBe('East Asia');
    expect(regionOf('AU')).toBe('Oceania');
    expect(regionOf('ZZ')).toBeNull();
    expect(flagOf('SG')).toBe('🇸🇬');
  });
});
