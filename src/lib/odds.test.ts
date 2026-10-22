import { describe, expect, it } from 'vitest';
import type { DailyWeather } from '../types';
import { addDays } from './dates';
import { ensoOutlook, ensoWeight, OniSeries, phaseOf } from './enso';
import { computeOdds, oddsWindows } from './tripOdds';
import { parseOni } from '../../server/enso';

function synth(start: string, end: string, f: (d: string) => Partial<DailyWeather>): DailyWeather[] {
  const out: DailyWeather[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push({ date: d, precipMm: 0, tMaxC: 28, tMinC: 22, rhMeanPct: 70, ...f(d) });
  return out;
}

describe('ENSO', () => {
  const oni = new OniSeries(parseOni('SEAS  YR   TOTAL   ANOM\n  JJA 2026  28.90   1.80\n  JAS 2026  29.12   2.16\n  NDJ 2015  29.0   2.60\n  NDJ 2010  25.1  -1.60\n  NDJ 2012  26.6  -0.10'));

  it('parses NOAA ONI rows and finds the latest season', () => {
    expect(oni.latest).toMatchObject({ year: 2026, month: 8, season: 'JAS', anom: 2.16 });
    expect(oni.at(2015, 12)).toBe(2.6);
    expect(phaseOf(-1.6)).toBe('La Niña');
  });

  it('assumes persistence for near trips and fades with lead time', () => {
    const near = ensoOutlook(oni, '2026-12-10')!;
    expect(near.tripPhase).toBe('El Niño');
    expect(near.influence).toBe(1);
    expect(ensoOutlook(oni, '2027-03-10')!.influence).toBe(0.5);
    expect(ensoOutlook(oni, '2027-06-10')!.influence).toBe(0);
    // Same phase counts 3×, opposite 0.3×, neutral 1×.
    expect(ensoWeight(2.6, near)).toBe(3);
    expect(ensoWeight(-1.6, near)).toBeCloseTo(0.3);
    expect(ensoWeight(-0.1, near)).toBe(1);
  });
});

describe('trip odds', () => {
  it('builds ±7-day windows for up to 25 past years', () => {
    const w = oddsWindows('2026-12-10', '2026-12-16', { today: '2026-10-19' });
    expect(w).toHaveLength(25);
    expect(w[0]).toEqual({ year: 2025, start: '2025-12-03', end: '2025-12-23' });
    expect(w[24].year).toBe(2001);
  });

  it('gives probabilities across sample trips and weights recent years more', () => {
    // Old years (before 2014) rain every day; recent years are dry.
    const daily = synth('2000-11-01', '2026-01-31', (d) => ({ precipMm: Number(d.slice(0, 4)) < 2014 ? 25 : 0 }));
    const o = computeOdds(daily, '2026-12-10', '2026-12-16', { today: '2026-10-19' })!;
    expect(o.years).toBe(25);
    expect(o.samples).toBe(25 * 15);
    // 13 of 25 years are dry, but recency weighting pushes the odds above a plain 52%.
    expect(o.pMostlyDry).toBeGreaterThan(0.6);
    expect(o.pWashout).toBeCloseTo(1 - o.pMostlyDry);
    expect(o.wetDays.p25).toBe(0);
    expect(o.ensoSignal).toBeNull();
  });

  it('up-weights years in the expected ENSO phase and reports the local signal', () => {
    // El Niño years (by ONI) are dry here; all others are wet.
    const nino = new Set([2023, 2015, 2009, 2006, 2002]);
    const rows = Array.from({ length: 26 }, (_, i) => 2000 + i).map((y) => `NDJ ${y} 27.0 ${nino.has(y) ? '1.50' : '0.00'}`);
    const oni = new OniSeries(parseOni([...rows, 'JAS 2026 29.1 2.16'].join('\n')));
    const enso = ensoOutlook(oni, '2026-12-13');
    const daily = synth('2000-11-01', '2026-01-31', (d) => ({ precipMm: nino.has(Number(d.slice(0, 4))) ? 0 : 5 }));
    const plain = computeOdds(daily, '2026-12-10', '2026-12-16', { today: '2026-10-19' })!;
    const weighted = computeOdds(daily, '2026-12-10', '2026-12-16', { today: '2026-10-19', oni, enso })!;
    expect(weighted.ensoApplied).toBe(true);
    expect(weighted.pMostlyDry).toBeGreaterThan(plain.pMostlyDry * 2);
    expect(weighted.ensoSignal).toMatchObject({ phase: 'El Niño', years: 5, verdict: 'drier' });
  });
});
