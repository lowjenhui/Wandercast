import { describe, expect, it } from 'vitest';
import { driestNearby, monthsMean, nearbyPlaces, type NearbyCandidate } from './nearbyRain';

const C: NearbyCandidate[] = [
  { name: 'Sapporo', lat: 43.06, lon: 141.35, dest: true },
  { name: 'Otaru', lat: 43.19, lon: 141.0, dest: true },
  { name: 'Furano', lat: 43.35, lon: 142.38, dest: true },
  { name: 'Kushiro', lat: 42.98, lon: 144.37, dest: true },
  { name: 'Hakodate', lat: 41.78, lon: 140.74, dest: true },
  { name: 'Asahikawa', lat: 43.77, lon: 142.37, dest: false },
  { name: 'Otaru city', lat: 43.2, lon: 141.0, dest: false },
  { name: 'Tokyo', lat: 35.68, lon: 139.65, dest: true },
];

describe('rain around here', () => {
  it('picks destinations within range first, then map cities, nearest first', () => {
    const near = nearbyPlaces(C, 43.35, 142.38, 350, 8);
    expect(near.map((p) => p.name)).toEqual(['Furano', 'Asahikawa', 'Sapporo', 'Otaru', 'Kushiro', 'Hakodate']);
    expect(near[0].km).toBeLessThan(1);
    // A city next to a destination isn't listed twice; far places are left out.
    expect(near.some((p) => p.name === 'Otaru city' || p.name === 'Tokyo')).toBe(false);
  });

  it('keeps destinations when there are more places than room', () => {
    expect(nearbyPlaces(C, 43.35, 142.38, 350, 3).map((p) => p.name)).toEqual(['Furano', 'Sapporo', 'Otaru']);
  });

  it('names the driest place only when it is clearly drier', () => {
    const year = (jul: number) => Array.from({ length: 12 }, (_, i) => (i === 6 ? jul : 100));
    expect(monthsMean(year(80), [7, 8])).toBe(90);
    expect(driestNearby([{ name: 'Abashiri', year: year(80) }, { name: 'Hakodate', year: year(130) }], [7])).toEqual({ name: 'Abashiri', mm: 80 });
    expect(driestNearby([{ name: 'A', year: year(100) }, { name: 'B', year: year(110) }], [7])).toBeNull();
    expect(driestNearby([{ name: 'A', year: year(100) }], [7])).toBeNull();
  });
});
