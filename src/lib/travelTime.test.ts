import { describe, expect, it } from 'vitest';
import { datedRouteNotes, destinationHours, directAirlinesOn, travelLabel, type Destination } from '../services/destinations';
import { estimateFlightHours } from './outlook';
import { tripFetchPlan } from './tripFetchPlan';
import { durationLabel, fitsTrip, tierFor, tripDays, type TravelException } from './travelTime';

const JAPAN: TravelException[] = [{ cc: 'JP', label: 'Japan', minDays: 3 }];

describe('flight-time guide', () => {
  it('maps trip length to Balanced limits', () => {
    expect(tripDays('2026-12-04', '2026-12-06')).toBe(3);
    expect(durationLabel(3)).toBe('3D2N');
    expect(durationLabel(7)).toBe('7 days');
    expect(tierFor(1).hours).toBe(1.5);
    expect(tierFor(3).hours).toBe(5);
    expect(tierFor(5).hours).toBe(6);
    expect(tierFor(8).hours).toBe(8);
    expect(tierFor(14).hours).toBe(13);
    expect(tierFor(20).hours).toBeNull();
  });

  it('allows nearby places, ferries, and exceptions', () => {
    const bangkok = { cc: 'TH', name: 'Bangkok', hours: estimateFlightHours(13.75, 100.5) };
    const tokyo = { cc: 'JP', name: 'Tokyo', hours: estimateFlightHours(35.68, 139.69) };
    const seoul = { cc: 'KR', name: 'Seoul', hours: estimateFlightHours(37.57, 126.98) };
    expect(fitsTrip(bangkok, 3, []).ok).toBe(true);
    expect(fitsTrip(tokyo, 3, [])).toEqual({ ok: false, limit: 5 });
    expect(fitsTrip(tokyo, 3, JAPAN)).toMatchObject({ ok: true, reason: 'exception' });
    expect(fitsTrip(tokyo, 2, JAPAN).ok).toBe(false); // exception starts at 3 days
    expect(fitsTrip(seoul, 3, JAPAN).ok).toBe(false);
    expect(fitsTrip({ cc: 'ID', name: 'Batam', hours: 1, ferry: true }, 1, []).ok).toBe(true);
    // City-only exceptions match that city alone.
    const tokyoOnly: TravelException[] = [{ cc: 'JP', city: 'Tokyo', label: 'Tokyo', minDays: 3 }];
    expect(fitsTrip(tokyo, 3, tokyoOnly).ok).toBe(true);
    expect(fitsTrip({ ...tokyo, name: 'Sapporo', hours: 8 }, 3, tokyoOnly).ok).toBe(false);
  });
});

describe('trip fetch plan', () => {
  it('covers whole years for the last 10 windows plus small older windows', () => {
    const p = tripFetchPlan('2026-12-04', '2026-12-08', '2026-10-20');
    expect(p.windows).toHaveLength(10);
    expect(p.main).toEqual({ start: '2016-01-01', end: '2025-12-31' });
    expect(p.older).toHaveLength(15);
    expect(p.older[0]).toMatchObject({ year: 2015, start: '2015-11-27', end: '2015-12-15' });
  });
});

describe('gateway destinations', () => {
  it('adds the transfer to the gateway flight', () => {
    const hoiAn: Destination = {
      name: 'Hoi An', cc: 'VN', code: 'DAD', lat: 15.8794, lon: 108.335,
      via: { code: 'DAD', name: 'Da Nang', lat: 16.0554, lon: 108.203, minutes: [35, 50], mode: 'road' },
    };
    expect(destinationHours(hoiAn)).toBe(estimateFlightHours(16.0554, 108.203) + 1);
    expect(travelLabel(hoiAn)).toMatch(/to Da Nang \+ 50 min road/);
    expect(fitsTrip({ cc: 'VN', name: 'Hoi An', hours: destinationHours(hoiAn) }, 3, []).ok).toBe(true);
  });
});

describe('dated direct routes', () => {
  const guiyang = {
    directAirlines: ['Tianjin Airlines', 'Scoot', 'Asiana Airlines'],
    directDated: { Scoot: { from: '2026-10-26' }, 'Asiana Airlines': { until: '2026-12-17' } },
  };

  it('counts a new route only for trips from its start date', () => {
    expect(directAirlinesOn(guiyang, '2026-10-25')).toEqual(['Tianjin Airlines', 'Asiana Airlines']);
    expect(directAirlinesOn(guiyang, '2026-10-26')).toEqual(['Tianjin Airlines', 'Scoot', 'Asiana Airlines']);
    expect(directAirlinesOn(guiyang, '2026-12-18')).toEqual(['Tianjin Airlines', 'Scoot']);
  });

  it('is not direct when the only route has not started', () => {
    const d = { directAirlines: ['Scoot'], directDated: { Scoot: { from: '2026-10-26' } } };
    expect(directAirlinesOn(d, '2026-10-01')).toBeUndefined();
    expect(datedRouteNotes(d, '2026-10-01')).toEqual(['Scoot from 26 Oct']);
    expect(datedRouteNotes(d, '2026-11-01')).toEqual([]);
  });
});

describe('typical-weather minimum years', () => {
  it('needs 3 of 5 (or 2 of 3) stored years', async () => {
    const { minTypicalYears } = await import('../services/tripOutlook');
    expect(minTypicalYears(5)).toBe(3);
    expect(minTypicalYears(3)).toBe(2);
  });
});
