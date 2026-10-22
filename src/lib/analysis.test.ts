import { describe, expect, it } from 'vitest';
import type { DailyWeather, FareData, FareObservation } from '../types';
import { concludeTrip } from './conclusion';
import { addDays, historicalWindows, shiftYears } from './dates';
import { assessFares } from './fareAnalysis';
import { analyseWeather, scoreSuitability } from './weatherAnalysis';

describe('dates', () => {
  it('maps Feb 29 to Feb 28 in non-leap years', () => {
    expect(shiftYears('2028-02-29', -1)).toBe('2027-02-28');
  });
  it('returns 10 complete windows, newest first, skipping incomplete ones', () => {
    const w = historicalWindows('2026-10-20', '2026-10-26', 10, 7, '2026-10-18');
    expect(w).toHaveLength(10);
    expect(w[0]).toEqual({ year: 2025, start: '2025-10-20', end: '2025-10-26' });
    expect(w[9].year).toBe(2016);
    // A trip starting today has last year's window still complete; one ending within the lag is skipped.
    const w2 = historicalWindows('2027-10-10', '2027-10-15', 10, 7, '2026-10-18');
    expect(w2[0].year).toBe(2025);
  });
  it('handles windows that cross the year boundary', () => {
    const w = historicalWindows('2026-12-28', '2027-01-03', 3, 7, '2026-10-18');
    expect(w[0]).toEqual({ year: 2025, start: '2025-12-28', end: '2026-01-03' });
  });
});

function synthDaily(start: string, end: string, f: (d: string, i: number) => Partial<DailyWeather>): DailyWeather[] {
  const out: DailyWeather[] = [];
  for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
    out.push({ date: d, precipMm: 0, tMaxC: 26, tMinC: 18, rhMeanPct: 60, ...f(d, i) });
  }
  return out;
}

describe('weather analysis', () => {
  const windows = historicalWindows('2026-11-01', '2026-11-07', 10, 7, '2026-10-18');

  it('counts wet days with the ≥1 mm threshold and compares last year', () => {
    // Every year: 2 wet days (5 mm) and one 0.5 mm day that must not count; last year: 5 wet days.
    const daily = synthDaily('2016-01-01', '2026-10-11', (d) => {
      const md = d.slice(5);
      if (d.startsWith('2025-11') && md <= '11-05') return { precipMm: 10 };
      if (md === '11-01' || md === '11-02') return { precipMm: 5 };
      if (md === '11-03') return { precipMm: 0.5 };
      return {};
    });
    const a = analyseWeather(daily, windows, '2026-11-01', '2026-11-07', []);
    expect(a.years).toHaveLength(10);
    expect(a.lastYear?.year).toBe(2025);
    expect(a.lastYear?.wetDays).toBe(5);
    expect(a.wetDays.median).toBe(2);
    expect(a.lastYearNotes[0]).toMatch(/wetter/);
    expect(a.suitability?.rating).toBeDefined();
    expect(a.monthly[10].inTrip).toBe(true);
  });

  it('flags low confidence when few years have data', () => {
    const daily = synthDaily('2023-01-01', '2026-10-11', () => ({}));
    const a = analyseWeather(daily, windows, '2026-11-01', '2026-11-07', []);
    expect(a.years.length).toBe(3);
    expect(a.confidence).toBe('low');
  });

  it('rates dry mild weather as pleasant and wet hot humid weather as challenging', () => {
    expect(scoreSuitability({ wetShare: 0.05, heavyPerWeek: 0, tMax: 25, tMin: 16, rh: 60 }, []).rating).toBe('Pleasant');
    const bad = scoreSuitability({ wetShare: 0.7, heavyPerWeek: 2, tMax: 34, tMin: 26, rh: 88 }, [
      { id: 'x', title: 'Typhoon season', description: '', severity: 'high', inPeak: true, source: { name: '', url: '' }, basis: 'reference' },
    ]);
    expect(bad.rating).toBe('Challenging');
    expect(bad.components.find((c) => c.key === 'risk')?.score).toBe(-15);
  });
});

function fares(partial: Partial<FareData>): FareData {
  return { status: 'ok', provider: 'test', sources: [], comparable: [], routeWide: [], exactDates: [], hasLiveSearch: false, warnings: [], ...partial };
}
const obs = (price: number, foundAt = '2026-10-10T00:00:00Z'): FareObservation => ({
  priceSgd: price, departDate: '2026-12-01', returnDate: '2026-12-07', foundAt, origin: 'SIN', destination: 'BKK',
});

describe('fare analysis', () => {
  it('does not produce a median verdict below the minimum sample', () => {
    const a = assessFares(fares({ comparable: [obs(300), obs(320)] }), '2026-12-01', 250);
    expect(a.benchmark.sufficient).toBe(false);
    expect(a.value).toBeNull();
    expect(a.limitations.join(' ')).toMatch(/Only 2 comparable/);
  });

  it('classifies a manual fare against the benchmark quartiles', () => {
    const comparable = [200, 220, 240, 260, 280, 300, 320, 340, 360, 380].map((p) => obs(p));
    expect(assessFares(fares({ comparable }), '2026-12-01', 210).value).toBe('Good value');
    expect(assessFares(fares({ comparable }), '2026-12-01', 290).value).toBe('Typical');
    expect(assessFares(fares({ comparable }), '2026-12-01', 500).value).toBe('Expensive');
  });

  it('uses the cheapest cached exact-date fare when no manual fare is given', () => {
    const comparable = [200, 220, 240, 260, 280, 300, 320, 340, 360, 380].map((p) => obs(p));
    const a = assessFares(fares({ comparable, exactDates: [obs(450), obs(390)] }), '2026-12-01');
    expect(a.reference).toEqual({ priceSgd: 390, kind: 'cached-exact' });
    expect(a.value).toBe('Expensive');
  });

  it('prefers the cheapest live fare over cached ones, and a manual fare over both', () => {
    const comparable = [200, 220, 240, 260, 280, 300, 320, 340, 360, 380].map((p) => obs(p));
    const live = { status: 'ok' as const, outbound: [], inbound: [], cheapestTotal: 230, urls: {} };
    const a = assessFares(fares({ comparable, exactDates: [obs(390)], live }), '2026-12-01');
    expect(a.reference).toEqual({ priceSgd: 230, kind: 'live' });
    expect(a.value).toBe('Good value');
    expect(a.headline).toMatch(/live Google Flights/);
    expect(assessFares(fares({ comparable, live }), '2026-12-01', 500).reference?.kind).toBe('manual');
  });

  it('withholds the overall conclusion without fare evidence', () => {
    const c = concludeTrip(null, assessFares(fares({}), '2026-12-01'));
    expect(c.verdict).toBeNull();
  });
});

import { classifyCurrent, type CurrentWeather } from './currentConditions';

describe('current conditions classifier', () => {
  const base: CurrentWeather = { time: '2026-10-18T12:00', utcOffsetSeconds: 0, tempC: 24, feelsLikeC: 24, humidityPct: 55, precipMm: 0, weatherCode: 1, windKmh: 10, isDay: true };
  it('rates dry mild calm weather as good', () => {
    expect(classifyCurrent(base).category).toBe('good');
  });
  it('rates light rain or heat as average', () => {
    expect(classifyCurrent({ ...base, weatherCode: 61, precipMm: 0.5 }).category).toBe('average');
    expect(classifyCurrent({ ...base, tempC: 31, feelsLikeC: 34 }).category).toBe('average');
  });
  it('rates thunderstorms, extreme temperatures and gales as bad', () => {
    expect(classifyCurrent({ ...base, weatherCode: 95 }).category).toBe('bad');
    expect(classifyCurrent({ ...base, feelsLikeC: -5 }).category).toBe('bad');
    expect(classifyCurrent({ ...base, windKmh: 60 }).category).toBe('bad');
  });
});

import { detectPhenomena } from './currentConditions';
import { curatedSeasonalRisks } from '../services/seasonalRisks';
import type { Place } from '../types';

describe('phenomena', () => {
  const w: CurrentWeather = { time: '2026-10-18T12:00', utcOffsetSeconds: 0, tempC: 30, feelsLikeC: 34, humidityPct: 70, precipMm: 0, weatherCode: 2, windKmh: 8, gustKmh: 15, visibilityM: 4000, isDay: true };

  it('attributes haze to nearby active fires (Kalimantan)', () => {
    const p = detectPhenomena({
      weather: w,
      aq: { pm25: 70, pm10: 90, usAqi: 158, dust: 0, aod: 1.2 },
      hazards: [{ kind: 'fire', name: 'Forest fires in Indonesia', alert: 'Green', lat: -2.95, lon: 112.73, countries: 'Indonesia' }],
      lat: -2.21, lon: 113.92, // Palangkaraya
      seasonal: [],
    });
    expect(p[0].title).toBe('Smoke haze');
    expect(p[0].severity).toBe('high');
    expect(p[0].detail).toMatch(/Indonesia/);
  });

  it('reports generic haze without fires, and cyclones nearby', () => {
    const p = detectPhenomena({
      weather: w,
      aq: { pm25: 40, pm10: 50, usAqi: 112, dust: 0, aod: 0.8 },
      hazards: [{ kind: 'cyclone', name: 'Tropical Cyclone CHAMPI-26', alert: 'Red', lat: 13.1, lon: 142.3, countries: 'Guam' }],
      lat: 13.47, lon: 144.75, // Guam
      seasonal: [],
    });
    expect(p.map((x) => x.title)).toEqual(['Tropical Cyclone CHAMPI-26', 'Haze']);
    expect(classifyCurrent(w, null, [{ kind: 'cyclone', name: 'TC', alert: 'Red', lat: 13.1, lon: 142.3, countries: '' }], { lat: 13.47, lon: 144.75 }).category).toBe('bad');
  });

  it('includes the Andaman monsoon for Phuket in October but not Bangkok', () => {
    const phuket = curatedSeasonalRisks.risksFor({ countryCode: 'TH', latitude: 7.88, longitude: 98.39 } as Place, [10]).map((r) => r.title);
    const langkawi = curatedSeasonalRisks.risksFor({ countryCode: 'MY', latitude: 6.33, longitude: 99.84 } as Place, [10]).map((r) => r.title);
    const bangkok = curatedSeasonalRisks.risksFor({ countryCode: 'TH', latitude: 13.75, longitude: 100.5 } as Place, [10]).map((r) => r.title);
    expect(phuket).toContain('Andaman Sea southwest monsoon');
    expect(langkawi).toContain('Andaman Sea southwest monsoon');
    expect(bangkok).not.toContain('Andaman Sea southwest monsoon');
    const sg = curatedSeasonalRisks.risksFor({ countryCode: 'SG', latitude: 1.29, longitude: 103.85 } as Place, [10]).map((r) => r.title);
    expect(sg).toContain('Inter-monsoon period');
  });
});

import { estimateFlightHours, rankCandidates } from './outlook';
import { planOutlook } from '../services/tripOutlook';

describe('trip outlook and suggestions', () => {
  it('uses the forecast within 16 days and typical history beyond', () => {
    const near = planOutlook('2026-10-25', '2026-11-08', '2026-10-18');
    expect(near.basis).toBe('forecast');
    if (near.basis === 'forecast') {
      expect(near.end).toBe('2026-11-02');
      expect(near.coveredDays).toBe(9);
      expect(near.tripDays).toBe(15);
    }
    const far = planOutlook('2026-12-20', '2026-12-27', '2026-10-18');
    expect(far.basis).toBe('typical');
    if (far.basis === 'typical') expect(far.windows.map((w) => w.year)).toEqual([2025, 2024, 2023, 2022, 2021]);
  });

  it('estimates plausible flight times from Changi', () => {
    expect(estimateFlightHours(13.75, 100.5)).toBe(2.5); // Bangkok ≈ 1,440 km
    expect(estimateFlightHours(35.69, 139.69)).toBeGreaterThanOrEqual(7); // Tokyo
    expect(estimateFlightHours(51.5, -0.13)).toBeGreaterThanOrEqual(13); // London
  });

  it('ranks by balanced score and respects the flight-time filter', () => {
    const s = (score: number) => ({ score, rating: 'Pleasant' as const, headline: '', components: [] });
    const items = [
      { dest: 'far-great', hours: 13, suitability: s(95) },
      { dest: 'near-good', hours: 2, suitability: s(80) },
      { dest: 'near-poor', hours: 1.5, suitability: s(30) },
      { dest: 'loading', hours: 1, suitability: null },
    ];
    expect(rankCandidates(items, 'balanced', null).map((c) => c.dest)).toEqual(['near-good', 'far-great', 'near-poor', 'loading']);
    expect(rankCandidates(items, 'weather', 5).map((c) => c.dest)).toEqual(['near-good', 'near-poor', 'loading']);
    expect(rankCandidates(items, 'flight', null)[0].dest).toBe('loading');
  });
});

describe('suitability weakest-link cap', () => {
  it('does not call dry but cold weather pleasant', () => {
    const r = scoreSuitability({ wetShare: 0.05, heavyPerWeek: 0, tMax: 12, tMin: 5, rh: 45 }, []);
    expect(r.rating).toBe('Generally pleasant');
    expect(scoreSuitability({ wetShare: 0.05, heavyPerWeek: 0, tMax: 6, tMin: -2, rh: 45 }, []).rating).not.toMatch(/pleasant/i);
  });

  it('keeps dry but cool days (highs below 15 °C) below Pleasant', () => {
    // Beijing, mid-March: dry, frost-free nights, highs near 13 °C. Scores 78 but is cool.
    const beijing = scoreSuitability({ wetShare: 0.17, heavyPerWeek: 0, tMax: 13.2, tMin: 0.2, rh: 49 }, []);
    expect(beijing.score).toBe(78);
    expect(beijing.rating).toBe('Generally pleasant');
    expect(beijing.headline).toMatch(/main drawback: cool: average highs near 13 °C/);
    expect(scoreSuitability({ wetShare: 0.05, heavyPerWeek: 0, tMax: 15, tMin: 6, rh: 50 }, []).rating).toBe('Pleasant');
  });

  it('rates severe cold and heat Challenging, however dry', () => {
    // Harbin, mid-January: dry and calm, but highs near −12 °C.
    const harbin = scoreSuitability({ wetShare: 0.06, heavyPerWeek: 0, tMax: -11.8, tMin: -23, rh: 69 }, []);
    expect(harbin.score).toBe(65);
    expect(harbin.rating).toBe('Challenging');
    expect(harbin.headline).toMatch(/Freezing: average highs near -12 °C/);
    expect(scoreSuitability({ wetShare: 0.05, heavyPerWeek: 0, tMax: 0, tMin: -8, rh: 50 }, []).rating).toBe('Challenging');
    expect(scoreSuitability({ wetShare: 0.05, heavyPerWeek: 0, tMax: 0.5, tMin: -8, rh: 50 }, []).rating).toBe('Mixed');
    // Desert heat: dry, but highs of 40 °C.
    const hot = scoreSuitability({ wetShare: 0, heavyPerWeek: 0, tMax: 40, tMin: 27, rh: 20 }, []);
    expect(hot.rating).toBe('Challenging');
    expect(hot.headline).toMatch(/Extreme heat/);
    expect(scoreSuitability({ wetShare: 0, heavyPerWeek: 0, tMax: 37.5, tMin: 27, rh: 20 }, []).rating).toBe('Mixed');
  });
});

import { analyseRainContext, contextWindow } from './rainContext';

describe('rainfall context around the trip', () => {
  it('centres a window of at least 30 days', () => {
    expect(contextWindow('2026-12-01', '2026-12-07')).toMatchObject({ before: 12, after: 11, totalDays: 30, start: '2026-11-19', end: '2026-12-18' });
    expect(contextWindow('2026-12-01', '2027-01-09')).toMatchObject({ before: 3, after: 3, totalDays: 46 }); // 40-day trip
  });

  it('compares trip, before and after, and finds a drier nearby stretch', () => {
    const windows = historicalWindows('2026-12-01', '2026-12-07', 10, 7, '2026-10-18');
    // Wet every day before 1 Dec, dry from 10 Dec onwards, every year.
    const daily = synthDaily('2015-10-01', '2026-01-31', (d) => {
      const md = d.slice(5);
      return { precipMm: md >= '11-15' && md < '12-10' ? 8 : 0 };
    });
    const rc = analyseRainContext(daily, windows, '2026-12-01', '2026-12-07');
    expect(rc.days).toHaveLength(30);
    expect(rc.trip.wetShare).toBe(1);
    expect(rc.after.wetShare).toBeLessThan(0.5);
    expect(rc.drierAlternative).not.toBeNull();
    expect(rc.drierAlternative!.start >= '2026-12-08').toBe(true);
    expect(rc.summary[1]).toMatch(/wetter than the days after/);
  });
});

import { readFileSync } from 'node:fs';
import { geoArea, geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { fixWinding } from '../components/WorldWeatherMap';

describe('map outlines', () => {
  const load = (res: string) => {
    const topo = JSON.parse(readFileSync(`node_modules/world-atlas/countries-${res}.json`, 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (feature(topo, topo.objects.countries) as any).features.map(fixWinding);
  };
  it('has no polygon covering more than a hemisphere after fixing winding', () => {
    for (const res of ['50m', '10m']) {
      const bad = load(res).filter((f: Parameters<typeof geoArea>[0]) => geoArea(f) > 2 * Math.PI);
      expect(bad).toHaveLength(0);
    }
  });
  it('includes Batam and Bintan as land in the detailed outlines', () => {
    for (const res of ['50m', '10m']) {
      const fs = load(res);
      for (const p of [[104.03, 1.08], [104.43, 1.12], [103.42, 1.03]] as [number, number][]) {
        expect(fs.some((f: Parameters<typeof geoContains>[0]) => geoContains(f, p))).toBe(true);
      }
      // A point in the Singapore Strait is still sea.
      expect(fs.some((f: Parameters<typeof geoContains>[0]) => geoContains(f, [104.0, 1.2]))).toBe(false);
    }
  });
});
