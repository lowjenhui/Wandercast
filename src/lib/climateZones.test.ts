import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import defs from '../data/climateZones.json';
import { MONSOONS } from '../data/monsoons';
import { geoContains } from 'd3-geo';
import { curatedSeasonalRisks } from '../services/seasonalRisks';
import type { Place } from '../types';
import { parseClimateZones, regimesForCountry, regimesForZone, regimeWhere, sidesVerdict, zoneAt, zoneFor } from './climateZones';

const pub = (f: string) => fileURLToPath(new URL(`../../public/${f}`, import.meta.url));
const cz = parseClimateZones(JSON.parse(readFileSync(pub('climate-zones.json'), 'utf8')));

describe('climate zones', () => {
  it('builds every defined zone with a city and shape, and zone edges per country', () => {
    expect(cz.zones.map((z) => z.id).sort()).toEqual(defs.zones.map((z) => z.id).sort());
    for (const cc of ['LK', 'MY', 'TH', 'VN', 'PH', 'TW', 'AU', 'ID', 'IN', 'CN', 'JP']) {
      expect(cz.byCc.get(cc)!.length).toBeGreaterThanOrEqual(2);
      expect(cz.edges.get(cc)!.geometry.coordinates.length).toBeGreaterThan(0);
    }
  });

  it('places each zone city inside its own zone', () => {
    for (const z of cz.zones) expect(zoneFor(cz, z.cc, z.city.lat, z.city.lon)?.id, z.city.name).toBe(z.id);
  });

  it('puts well-known places on the right side', () => {
    const at = (lat: number, lon: number) => zoneAt(cz, lat, lon)?.id;
    expect(at(6.93, 79.86)).toBe('lk-sw'); // Colombo
    expect(at(7.29, 80.63)).toBe('lk-sw'); // Kandy
    expect(at(8.58, 81.2)).toBe('lk-ne'); // Trincomalee
    expect(at(7.95, 80.75)).toBe('lk-ne'); // Sigiriya
    expect(at(3.81, 103.33)).toBe('my-east'); // Kuantan
    expect(at(5.41, 100.33)).toBe('my-west'); // Penang
    expect(at(8.06, 98.92)).toBe('th-andaman'); // Krabi
    expect(at(9.14, 99.33)).toBe('th-gulf'); // Surat Thani
    expect(at(18.79, 98.98)).toBe('th-main'); // Chiang Mai
    expect(at(16.46, 107.6)).toBe('vn-central'); // Hue
    expect(at(11.94, 108.44)).toBe('vn-south'); // Da Lat
    expect(at(21.03, 105.85)).toBe('vn-north'); // Hanoi
    expect(at(11.25, 125.0)).toBe('ph-east'); // Tacloban
    expect(at(10.32, 123.89)).toBe('ph-west'); // Cebu
    expect(at(22.63, 120.35)).toBe('tw-south'); // Kaohsiung
    expect(at(24.68, 121.7)).toBe('tw-north'); // Yilan
    expect(at(23.75, 121.1)).toBe('tw-south'); // Taitung county
    expect(at(-14.47, 132.26)).toBe('au-north'); // Katherine
    expect(at(-15.47, 145.0)).toBe('au-north'); // Cooktown, Queensland north of the cut
    expect(at(-21.3, 148.9)).toBe('au-east'); // Mackay hinterland, south of the cut
    expect(at(-28.81, 153.28)).toBe('au-east'); // Lismore, NSW north coast
    expect(at(-32.25, 148.6)).toBe('au-southeast'); // Dubbo
    expect(at(-35.28, 149.13)).toBe('au-southeast'); // Canberra
    expect(at(-30.75, 121.47)).toBe('au-southwest'); // Kalgoorlie
    expect(at(-17.5, 123.5)).toBe('au-north'); // the Kimberley
    expect(at(-7.8, 110.36)).toBe('id-java'); // Yogyakarta
    expect(at(2.66, 98.94)).toBe('id-sumatra-north'); // Lake Toba
    expect(at(-0.3, 100.37)).toBe('id-sumatra'); // Bukittinggi
    expect(at(-3.32, 114.59)).toBe('id-kalimantan'); // Banjarmasin
    expect(at(-2.97, 119.9)).toBe('id-sulawesi'); // Rantepao (Toraja)
    expect(at(-4.1, 138.95)).toBe('id-east'); // Wamena
    expect(at(10.09, 77.06)).toBe('in-kerala'); // Munnar
    expect(at(9.93, 78.12)).toBe('in-tn'); // Madurai
    expect(at(18.52, 73.86)).toBe('in-west'); // Pune
    expect(at(17.39, 78.49)).toBe('in-deccan'); // Hyderabad
    expect(at(26.91, 75.79)).toBe('in-north'); // Jaipur
    expect(at(25.58, 91.89)).toBe('in-ne'); // Shillong
    expect(at(45.8, 126.53)).toBe('cn-northeast'); // Harbin
    expect(at(34.34, 108.94)).toBe('cn-north'); // Xi'an
    expect(at(38.93, 100.45)).toBe('cn-northwest'); // Zhangye
    expect(at(29.65, 91.17)).toBe('cn-tibet'); // Lhasa
    expect(at(29.12, 110.48)).toBe('cn-yangtze'); // Zhangjiajie
    expect(at(33.3, 103.86)).toBe('cn-sichuan'); // Jiuzhaigou
    expect(at(22.01, 100.8)).toBe('cn-yunnan'); // Jinghong (Xishuangbanna)
    expect(at(24.78, 110.49)).toBe('cn-south'); // Yangshuo
    expect(at(18.6, 109.6)).toBe('cn-hainan'); // inland Hainan
    expect(at(42.9, 140.75)).toBe('jp-hokkaido'); // Niseko
    expect(at(36.56, 136.7)).toBe('jp-japansea'); // Kanazawa
    expect(at(37.9, 139.1)).toBe('jp-japansea'); // Niigata
    expect(at(35.02, 135.75)).toBe('jp-pacific'); // Kyoto
    expect(at(34.4, 132.5)).toBe('jp-pacific'); // Hiroshima
    expect(at(32.8, 130.74)).toBe('jp-kyushu'); // Kumamoto
    expect(at(33.26, 131.36)).toBe('jp-kyushu'); // Yufuin
    expect(at(26.33, 127.8)).toBe('jp-okinawa'); // Okinawa Island
  });

  it('falls back to the nearest zone city for a coastal point the simplified shapes miss', () => {
    expect(zoneFor(cz, 'LK', 8.9, 81.6)?.id).toBe('lk-ne'); // just offshore of Trincomalee
    expect(zoneFor(cz, 'KR', 37.57, 126.98)).toBeNull(); // Seoul: Korea has no zones
  });

  it('links monsoon footprints to zones that exist', () => {
    const ids = new Set([...cz.zones.map((z) => z.id), ...cz.areas.map((a) => a.id)]);
    for (const r of MONSOONS) for (const z of r.zones ?? []) expect(ids.has(z), `${r.id} → ${z}`).toBe(true);
  });

  it('finds the regimes under way for a zone and a country', () => {
    expect(regimesForZone('lk-ne', [1]).map((r) => r.id)).toEqual(['lk-ne']);
    expect(regimesForZone('lk-ne', [7])).toEqual([]);
    expect(regimesForCountry(cz, 'LK', [7]).map((r) => r.id)).toEqual(['lk-sw']);
    expect(regimesForCountry(cz, 'LK', [11]).map((r) => r.id)).toEqual(['lk-inter2']);
    expect(regimesForCountry(cz, 'MY', [12]).map((r) => r.id)).toEqual(['my-ne']);
    expect(regimesForCountry(cz, 'TW', [1]).map((r) => r.id)).toEqual(['tw-ne']);
    expect(regimesForCountry(cz, 'AU', [7]).map((r) => r.id)).toEqual(['au-sw-winter']);
    expect(regimesForCountry(cz, 'ID', [7]).map((r) => r.id)).toEqual(['id-maluku']);
    expect(regimesForCountry(cz, 'IN', [11]).map((r) => r.id)).toEqual(['in-ne']);
    expect(regimesForCountry(cz, 'CN', [1])).toEqual([]);
    expect(regimesForCountry(cz, 'JP', [1]).map((r) => r.id)).toEqual(['jp-winter-snow']);
    expect(regimesForCountry(cz, 'JP', [5]).map((r) => r.id)).toEqual(['jp-okinawa-rain']);
    expect(regimesForCountry(cz, 'CN', [6]).map((r) => r.id).sort()).toEqual(['cn-hainan-wet', 'cn-plateau', 'cn-south-pre', 'cn-yunnan-wet', 'ea-meiyu']);
  });

  it('outlines the winter snow over western Hokkaido only', () => {
    const west = cz.areas.find((a) => a.id === 'jp-hokkaido-west')!;
    expect(west.zone).toBe('jp-hokkaido');
    expect(geoContains(west.shape, [141.35, 43.06])).toBe(true); // Sapporo
    expect(geoContains(west.shape, [142.38, 43.35])).toBe(true); // Furano
    expect(geoContains(west.shape, [143.2, 42.92])).toBe(false); // Obihiro
    expect(geoContains(west.shape, [144.0, 43.6])).toBe(false); // eastern interior
    const snow = MONSOONS.find((r) => r.id === 'jp-winter-snow')!;
    expect(regimeWhere(cz, 'JP', snow)).toBe('mainly Sea of Japan coast and western Hokkaido');
    expect(regimeWhere(cz, 'LK', MONSOONS.find((r) => r.id === 'lk-inter2')!)).toBe('everywhere');
  });

  it('notes summer sea fog on eastern Hokkaido\'s Pacific coast only', () => {
    const fog = (lat: number, lon: number, m: number) => curatedSeasonalRisks.risksFor({ countryCode: 'JP', latitude: lat, longitude: lon } as Place, [m]).some((r) => r.id === 'jp-hokkaido-fog');
    expect(fog(42.98, 144.37, 7)).toBe(true); // Kushiro
    expect(fog(43.35, 142.38, 7)).toBe(false); // Furano
    expect(fog(44.02, 144.27, 7)).toBe(false); // Abashiri
    expect(fog(42.98, 144.37, 1)).toBe(false);
  });

  it('says which side is drier, or that it is similar everywhere', () => {
    expect(sidesVerdict([{ name: 'Southwest and hills', mm: 140 }, { name: 'North and east', mm: 50 }])).toBe('North and east is the drier side');
    expect(sidesVerdict([{ name: 'Southwest and hills', mm: 320 }, { name: 'North and east', mm: 350 }])).toBe('Wet everywhere');
    expect(sidesVerdict([{ name: 'A', mm: 40 }, { name: 'B', mm: 60 }])).toBe('Fairly dry everywhere');
    expect(sidesVerdict([{ name: 'A', mm: 100 }, { name: 'B', mm: 130 }])).toBe('Similar everywhere');
    expect(sidesVerdict([{ name: 'A', mm: 50 }, { name: 'B', mm: 60 }, { name: 'C', mm: 200 }])).toBe('A is the drier side (with others close)');
    expect(sidesVerdict([{ name: 'A', mm: 50 }])).toBe('');
  });
});
