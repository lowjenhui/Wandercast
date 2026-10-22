import { describe, expect, it } from 'vitest';
import type { HolidayPeriod, TripCalendar } from '../services/calendar';
import { landHours, landOnly, landText, travelLabel, destinationHours, type Destination } from '../services/destinations';
import { causewayAlert, crowdAlerts } from './calendarAnalysis';

const period = (name: string, start: string, end: string, overlapDays: number): HolidayPeriod => ({ name, start, end, days: 3, overlapDays, tentative: false });
const cal = (over: Partial<TripCalendar> = {}): TripCalendar => ({
  country: 'MY',
  holidays: [],
  periods: [],
  events: [],
  china: { overlapping: [], nearby: [] },
  singapore: [],
  sources: { holidays: null },
  ...over,
});
const coach = { modes: ['coach'], from: 'Golden Mile', minutes: [300, 360] as [number, number], operators: ['Transtar'], sources: [] };

describe('overland travel', () => {
  it('labels and times overland options, and prefers the faster way for places with a flight too', () => {
    const jb: Destination = { name: 'Johor Bahru', cc: 'MY', code: 'LAND-JB', lat: 1.47, lon: 103.76, land: { ...coach, modes: ['bus', 'train'], minutes: [45, 90] } };
    expect(landOnly(jb)).toBe(true);
    expect(landText(jb.land!)).toBe('🚌 45–90 min bus or train');
    expect(travelLabel(jb)).toBe('🚌 45–90 min bus or train');
    expect(destinationHours(jb)).toBe(1.5);
    const kl: Destination = { name: 'Kuala Lumpur', cc: 'MY', code: 'KUL', lat: 3.139, lon: 101.687, directAirlines: ['Scoot'], land: coach };
    expect(landOnly(kl)).toBe(false);
    expect(landHours(coach)).toBe(6);
    expect(destinationHours(kl)).toBeLessThan(2); // the flight is faster
    expect(travelLabel(kl, '2026-12-04')).toMatch(/^✈ .* direct · 🚌 5h–6h coach$/);
  });

  it('warns about causeway congestion on long weekends, then on weekend crossings', () => {
    // Thu 4 – Mon 8 Dec 2026, over a Singapore long weekend.
    const long = causewayAlert(cal({ singapore: [period('Deepavali', '2026-12-05', '2026-12-07', 3)] }), { start: '2026-12-04', end: '2026-12-08', overland: 'only' });
    expect(long).toMatchObject({ level: 'high' });
    expect(long!.text).toMatch(/^Causeway congestion likely: Deepavali/);
    // Fri start, no holiday: a weekend crossing; "if you go by road" when a flight is also possible.
    const wk = causewayAlert(cal(), { start: '2026-12-04', end: '2026-12-06', overland: 'also' });
    expect(wk).toMatchObject({ level: 'medium' });
    expect(wk!.text).toMatch(/^Weekend crossing if you go by road/);
    // Tue–Thu: nothing.
    expect(causewayAlert(cal(), { start: '2026-12-08', end: '2026-12-10', overland: 'only' })).toBeNull();
  });

  it('replaces the Changi long-weekend note for road-only trips', () => {
    const c = cal({ singapore: [period('Deepavali', '2026-12-05', '2026-12-07', 3)] });
    const flight = crowdAlerts(c, [], 'Bangkok');
    expect(flight.some((a) => /Changi/.test(a.text))).toBe(true);
    const road = crowdAlerts(c, [], 'Johor Bahru', { start: '2026-12-04', end: '2026-12-08', overland: 'only' });
    expect(road.some((a) => /Changi/.test(a.text))).toBe(false);
    expect(road[0].text).toMatch(/Causeway/);
  });
});
