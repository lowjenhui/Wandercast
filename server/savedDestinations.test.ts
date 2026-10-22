import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { destinationParts } from './destPrefetch';
import { DEFAULT_EXCEPTIONS, SavedRanges } from './savedRanges';

describe('saved destinations', () => {
  it('adds, de-duplicates, lists and removes destinations per range', () => {
    const store = new SavedRanges(openDb(':memory:'));
    const r = store.add({ label: 'Yolo', start: '2026-12-04', end: '2026-12-08' });
    if (typeof r === 'string') throw new Error(r);
    const dn = store.addDestination(r.id, { name: 'Da Nang', country: 'Vietnam', cc: 'vn', lat: 16.07, lon: 108.22, code: 'dad' });
    expect(dn).toMatchObject({ name: 'Da Nang', cc: 'VN', code: 'DAD' });
    expect(store.addDestination(r.id, { name: 'Da Nang airport', country: 'Vietnam', cc: 'VN', lat: 16.05, lon: 108.2 })).toMatch(/already on this list/);
    expect(store.addDestination(r.id, { name: '', cc: 'VN', lat: 1, lon: 1 })).toMatch(/Choose a destination/);
    expect(store.addDestination(999, { name: 'X', cc: 'VN', lat: 1, lon: 1 })).toBeNull();
    store.addDestination(r.id, { name: 'Ho Chi Minh City', country: 'Vietnam', cc: 'VN', lat: 10.82, lon: 106.63, code: 'SGN' });
    expect(store.destinations(r.id).map((d) => d.name)).toEqual(['Da Nang', 'Ho Chi Minh City']);
    expect(store.removeDestination(r.id, (dn as { id: number }).id)).toBe(true);
    store.remove(r.id);
    expect(store.destinations()).toHaveLength(0);
  });

  it('stores flight-time exceptions with Japan as the default', () => {
    const store = new SavedRanges(openDb(':memory:'));
    expect(store.exceptions()).toEqual(DEFAULT_EXCEPTIONS);
    expect(store.setExceptions([{ cc: 'kr', label: 'Seoul', city: 'Seoul', minDays: 4 }])).toEqual([{ cc: 'KR', city: 'Seoul', label: 'Seoul', minDays: 4 }]);
    expect(store.exceptions()).toHaveLength(1);
    expect(store.setExceptions([{ cc: 'KR', minDays: 0 }])).toMatch(/1–30 days/);
  });

  it('plans prefetch parts by calendar year, stopping before unsettled days', () => {
    const parts = destinationParts('2026-12-04', '2026-12-08', '2026-10-20');
    expect(parts.slice(0, 2)).toEqual([{ start: '2016-01-01', end: '2016-12-31' }, { start: '2017-01-01', end: '2017-12-31' }]);
    expect(parts).toHaveLength(10 + 15);
    // A trip soon after today: the newest year is clipped to settled ERA5 days.
    const soon = destinationParts('2026-11-01', '2026-11-03', '2026-10-20');
    expect(soon.every((p) => p.end <= '2026-10-09')).toBe(true);
  });
});
