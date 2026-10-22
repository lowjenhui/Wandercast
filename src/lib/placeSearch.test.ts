import { describe, expect, it } from 'vitest';
import { matchScore, normalise, searchPlaces } from './placeSearch';

describe('map finder search', () => {
  const items = [
    { name: 'Jakarta', rank: 0, value: 'Jakarta' },
    { name: 'Japan', rank: 1, value: 'Japan' },
    { name: 'Ho Chi Minh City', rank: 0, value: 'HCMC' },
    { name: 'Đà Nẵng', rank: 3, value: 'Da Nang (city)' },
    { name: 'Chennai', rank: 0, value: 'Chennai' },
    { name: 'Chengdu', rank: 0, value: 'Chengdu' },
    { name: 'Chenzhou', rank: 18, value: 'Chenzhou' },
  ];

  it('ignores accents and case', () => {
    expect(normalise('Đà Nẵng')).toBe('da nang');
    expect(searchPlaces(items, 'da nang', 5)).toEqual(['Da Nang (city)']);
  });

  it('puts exact names first, then prefixes, then word starts', () => {
    expect(matchScore('Japan', 'japan')).toBe(0);
    expect(matchScore('Jakarta', 'ja')).toBe(1);
    expect(matchScore('Ho Chi Minh City', 'minh')).toBe(2);
    expect(matchScore('Bangkok', 'kok')).toBeNull();
    expect(searchPlaces(items, 'japan', 5)).toEqual(['Japan']);
    expect(searchPlaces(items, 'ja', 5)).toEqual(['Jakarta', 'Japan']);
  });

  it('breaks ties by rank and respects the limit', () => {
    expect(searchPlaces(items, 'chen', 5)).toEqual(['Chennai', 'Chengdu', 'Chenzhou']);
    expect(searchPlaces(items, 'chen', 2)).toEqual(['Chennai', 'Chengdu']);
    expect(searchPlaces(items, 'c', 5)).toEqual([]);
  });
});
