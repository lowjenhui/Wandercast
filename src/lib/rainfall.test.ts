import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MONSOONS, activeMonsoons } from '../data/monsoons';
import { NestedRain, rainColor, RainGrid, rainSourceLabel, tripMonthWeights, type RainMeta } from './rainfall';

const pub = (f: string) => fileURLToPath(new URL(`../../public/${f}`, import.meta.url));
const meta = JSON.parse(readFileSync(pub('rainfall-normals.json'), 'utf8')) as RainMeta;
const buf = readFileSync(pub('rainfall-normals.bin'));
const grid = new RainGrid(meta, new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2));

describe('rainfall normals (GPCP 1991–2020)', () => {
  it('has a full 12-month 2.5° grid', () => {
    expect(buf.length).toBe(12 * meta.nlat * meta.nlon * 2);
    expect(meta.nlat).toBe(72);
    expect(meta.nlon).toBe(144);
  });

  it('shows known monsoon patterns', () => {
    const mumbai = grid.year(19.1, 72.9);
    expect(mumbai[6]).toBeGreaterThan(300); // July
    expect(mumbai[0]).toBeLessThan(20); // January
    const sg = grid.year(1.35, 103.8);
    expect(Math.max(...sg)).toBe(Math.max(sg[10], sg[11])); // wettest in Nov or Dec
    expect(grid.at(7, 23, 12)).toBeLessThan(10); // Sahara in July
    // Longitudes wrap: -180 and 180 are the same place.
    expect(grid.at(1, 0, -180)).toBeCloseTo(grid.at(1, 0, 180), 5);
  });

  it('interpolates between grid cells', () => {
    const a = grid.at(7, 18.75, 73.75);
    const b = grid.at(7, 18.75, 76.25);
    const mid = grid.at(7, 18.75, 75);
    expect(mid).toBeCloseTo((a + b) / 2, 5);
  });

  it('weights trip months by days', () => {
    const w = tripMonthWeights('2026-11-28', '2026-12-04');
    expect([...w]).toEqual([[11, 3], [12, 4]]);
    expect(grid.blend(w, 1.35, 103.8)).toBeCloseTo((grid.at(11, 1.35, 103.8) * 3 + grid.at(12, 1.35, 103.8) * 4) / 7, 5);
  });

  it('colours dry to wet', () => {
    expect(rainColor(0)).toEqual([246, 236, 214]);
    expect(rainColor(2000)).toEqual([128, 30, 160]);
    expect(rainColor(150)[2]).toBeGreaterThan(rainColor(10)[2] - 1);
  });
});

describe('nested regional grid', () => {
  // A 1° test grid over 0–10°N, 100–110°E with 500 mm everywhere in every month.
  const inner = new RainGrid(
    { ...meta, lat0: 10, dlat: -1, nlat: 11, lon0: 100, dlon: 1, nlon: 11, max: 500, source: { name: 'ERA5 test', url: 'https://cds.climate.copernicus.eu/x', citation: '' } },
    new Uint16Array(12 * 11 * 11).fill(500),
  );
  const nested = new NestedRain(grid, inner, 3);

  it('measures how far inside a regional grid a point is', () => {
    expect(inner.inside(5, 105)).toBeCloseTo(5, 5);
    expect(inner.inside(1, 105)).toBeCloseTo(1, 5);
    expect(inner.inside(5, 99)).toBeCloseTo(-1, 5);
    expect(inner.inside(5, -100)).toBeLessThan(0);
    expect(grid.inside(5, 105)).toBeGreaterThan(90); // the global grid covers everywhere
  });

  it('uses the regional grid inside, the global one outside, and blends at the edge', () => {
    expect(nested.at(7, 5, 105)).toBe(500);
    expect(nested.at(7, 20, 105)).toBeCloseTo(grid.at(7, 20, 105), 5);
    const edge = nested.at(7, 1.5, 105); // 1.5° inside: half and half
    expect(edge).toBeCloseTo((500 + grid.at(7, 1.5, 105)) / 2, 5);
    expect(nested.metaAt(5, 105).source.name).toBe('ERA5 test');
    expect(nested.metaAt(20, 105).source.name).toBe(meta.source.name);
  });

  it('labels sources', () => {
    expect(rainSourceLabel(meta)).toEqual({ name: 'GPCP v2.3 (NOAA PSL)', grid: '2.5° grid', km: 278 });
    expect(rainSourceLabel(inner.meta).name).toBe('ERA5 (Copernicus)');
  });
});

// The bundled ERA5 grid for Asia (scripts/build-rainfall-era5.py), once built.
const hasAsia = existsSync(pub('rainfall-asia.bin'));
describe.skipIf(!hasAsia)('rainfall normals for Asia (ERA5 0.25°)', () => {
  const am = hasAsia ? (JSON.parse(readFileSync(pub('rainfall-asia.json'), 'utf8')) as RainMeta) : meta;
  const ab = hasAsia ? readFileSync(pub('rainfall-asia.bin')) : Buffer.alloc(0);
  const asia = new NestedRain(grid, new RainGrid(am, new Uint16Array(ab.buffer, ab.byteOffset, ab.length / 2)));

  it('has a full 12-month 0.25° grid over Asia and Australia', () => {
    expect(ab.length).toBe(12 * am.nlat * am.nlon * 2);
    expect(Math.abs(am.dlat)).toBe(0.25);
    // Fully inside (past the 3° blend): all of Hokkaido, Harbin and Australia's east coast.
    for (const [lat, lon] of [[45.4, 141.7], [41.8, 140.7], [45.8, 126.5], [-33.9, 151.2], [-27.5, 153], [-12.5, 130.8]]) {
      expect(asia.metaAt(lat, lon).source.url).toContain('copernicus');
    }
  });

  it('separates coasts with opposite monsoons', () => {
    const colombo = asia.year(6.93, 79.85);
    const trinco = asia.year(8.58, 81.23);
    expect(colombo[4]).toBeGreaterThan(trinco[4] * 2); // May: southwest monsoon
    expect(trinco[11]).toBeGreaterThan(colombo[11] * 1.5); // December: northeast monsoon
    const phuket = asia.year(7.95, 98.34);
    const samui = asia.year(9.54, 99.94);
    expect(phuket[8]).toBeGreaterThan(samui[8]); // September: Andaman side wetter
    expect(samui[10]).toBeGreaterThan(phuket[10]); // November: Gulf side wetter
  });
});

describe('monsoon regimes', () => {
  it('are valid and cover the year around Southeast Asia', () => {
    for (const r of MONSOONS) {
      expect(r.months.every((m) => m >= 1 && m <= 12)).toBe(true);
      expect(r.source.url).toMatch(/^https:\/\//);
    }
    expect(activeMonsoons([7]).map((r) => r.id)).toEqual(expect.arrayContaining(['in-sw', 'andaman-sw', 'ea-meiyu']));
    expect(activeMonsoons([12]).map((r) => r.id)).toEqual(expect.arrayContaining(['my-ne', 'id-west', 'au-wet']));
  });
});
