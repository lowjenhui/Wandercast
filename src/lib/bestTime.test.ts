import { describe, expect, it } from 'vitest';
import type { DailyWeather, SeasonalRisk } from '../types';
import { addDays, daysBetween } from './dates';
import { bestTimeFetchRange, bestTimes, findAvoid, MIN_GAP_DAYS, pickBest, type WindowScore } from './bestTime';

const TODAY = '2026-10-21';

function synth(start: string, end: string, f: (d: string) => Partial<DailyWeather>): DailyWeather[] {
  const out: DailyWeather[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push({ date: d, precipMm: 0, tMaxC: 27, tMinC: 20, rhMeanPct: 65, ...f(d) });
  return out;
}

const range = bestTimeFetchRange(TODAY);
const noRisks = () => [] as SeasonalRisk[];
const month = (d: string) => Number(d.slice(5, 7));

describe('when to go', () => {
  it('reads 10 years plus the longest trip and slide, up to the archive lag', () => {
    expect(range).toEqual({ start: '2016-09-11', end: '2026-10-15' });
  });

  it('scores every start date over the next 12 months', () => {
    const r = bestTimes(synth(range.start, range.end, () => ({})), { tripDays: 7, risksFor: noRisks, today: TODAY });
    expect(r.days).toHaveLength(365);
    expect(r.days[0]).toMatchObject({ start: TODAY, end: '2026-10-27', years: 10 });
    expect(r.days.every((d) => d !== null)).toBe(true);
    expect(r.firstYear).toBe(2016);
    expect(r.lastYear).toBe(2026);
  });

  it('calls a uniform climate flat instead of naming winners', () => {
    const r = bestTimes(synth(range.start, range.end, () => ({})), { tripDays: 7, risksFor: noRisks, today: TODAY });
    expect(r.flat).toBe(true);
    expect(r.flatLabel).toBe('Good most of the year');
    expect(r.best).toEqual([]);
    expect(r.avoid).toBeNull();
  });

  it('finds the dry season and flags the wet season', () => {
    // Wet every day June–September, dry otherwise.
    const daily = synth(range.start, range.end, (d) => ({ precipMm: month(d) >= 6 && month(d) <= 9 ? 15 : 0 }));
    const r = bestTimes(daily, { tripDays: 7, risksFor: noRisks, today: TODAY });
    expect(r.flat).toBe(false);
    expect(r.best).toHaveLength(3);
    for (const b of r.best) {
      expect(b.pMostlyDry).toBe(1);
      expect([6, 7, 8, 9]).not.toContain(month(b.start));
    }
    expect(r.avoid).not.toBeNull();
    expect(month(r.avoid!.from)).toBeLessThanOrEqual(6);
    expect(month(r.avoid!.to)).toBeGreaterThanOrEqual(8);
    expect(r.avoid!.reason).toMatch(/wet/i);
  });

  it('applies seasonal-risk penalties from the curated reference', () => {
    const daily = synth(range.start, range.end, () => ({}));
    const typhoon: SeasonalRisk = { id: 't', title: 'Typhoon season', description: '', severity: 'high', inPeak: true, source: { name: '', url: '' }, basis: 'reference' };
    const r = bestTimes(daily, { tripDays: 5, risksFor: (ms) => (ms.includes(8) ? [typhoon] : []), today: TODAY });
    const aug = r.days.find((d) => d?.start === '2027-08-10')!;
    const mar = r.days.find((d) => d?.start === '2027-03-10')!;
    expect(mar.score - aug.score).toBe(15);
    expect(r.best.every((b) => !b.risks.length)).toBe(true);
  });

  it('marks start dates without enough history as unscored', () => {
    const daily = synth('2025-01-01', range.end, () => ({}));
    const r = bestTimes(daily, { tripDays: 7, risksFor: noRisks, today: TODAY });
    expect(r.days.every((d) => d === null)).toBe(true);
    expect(r.best).toEqual([]);
  });

  it('keeps best windows at least two weeks apart', () => {
    const mk = (start: string, score: number) => ({ start, score, pMostlyDry: 0.5 }) as WindowScore;
    const picks = pickBest([mk('2027-01-01', 90), mk('2027-01-05', 89), mk('2027-01-20', 85), mk('2027-03-01', 80)], 3);
    expect(picks.map((p) => p.start)).toEqual(['2027-01-01', '2027-01-20', '2027-03-01']);
    expect(Math.abs(daysBetween(picks[0].start, picks[1].start))).toBeGreaterThanOrEqual(MIN_GAP_DAYS);
  });

  it('only reports an avoid stretch that is clearly worse than the best', () => {
    const mk = (score: number) => ({ start: '2027-01-01', score, risks: [], suitability: { components: [] } }) as unknown as WindowScore;
    expect(findAvoid([mk(70), mk(64), mk(70)], 70)).toBeNull(); // still decent
    expect(findAvoid([mk(55), mk(50), mk(55)], 58)).toBeNull(); // not clearly worse
    expect(findAvoid([mk(80), mk(40), mk(42), mk(80)], 80)).toMatchObject({ meanScore: 41 });
  });
});

describe('weekend mode', () => {
  it('scores only weekend starts, with the weekend length', () => {
    const r = bestTimes(synth(range.start, range.end, () => ({})), { tripDays: 9, weekend: 'fri-sun', risksFor: noRisks, today: TODAY });
    expect(r.weekend).toBe('fri-sun');
    expect(r.tripDays).toBe(3);
    expect(r.starts.length).toBeGreaterThanOrEqual(52);
    expect(r.starts.length).toBeLessThanOrEqual(53);
    expect(r.starts.every((s) => new Date(`${s}T00:00:00Z`).getUTCDay() === 5)).toBe(true);
    expect(r.days[0]).toMatchObject({ start: r.starts[0], end: addDays(r.starts[0], 2) });
    const sat = bestTimes(synth(range.start, range.end, () => ({})), { tripDays: 7, weekend: 'sat-sun', risksFor: noRisks, today: TODAY });
    expect(sat.days.every((d) => d && new Date(`${d.start}T00:00:00Z`).getUTCDay() === 6 && d.end === addDays(d.start, 1))).toBe(true);
  });
});
