import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { FxStore } from './fx';
import { fxText } from '../src/lib/fx';
import { monthlyNormals } from '../src/lib/bestTime';

describe('Exchange rate wording', () => {
  it('shows S$1 in local money, or a round local amount in S$ when units are small', () => {
    expect(fxText({ code: 'THB', symbol: '฿', perSgd: 25.93 })).toBe('S$1 = ฿25.9');
    expect(fxText({ code: 'MYR', symbol: 'RM', perSgd: 3.4212 })).toBe('S$1 = RM3.42');
    expect(fxText({ code: 'JPY', symbol: '¥', perSgd: 113.6 })).toBe('¥1,000 = S$8.80');
    expect(fxText({ code: 'VND', symbol: '₫', perSgd: 19400 })).toBe('₫100,000 = S$5.15');
    // A bare "$" would be ambiguous next to S$, so the code is used.
    expect(fxText({ code: 'AUD', symbol: '$', perSgd: 1.18 })).toBe('S$1 = AUD 1.18');
  });
});

describe('FxStore', () => {
  it('fetches SGD rates once, then serves them per country', async () => {
    const db = openDb(':memory:');
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ result: 'success', time_last_update_unix: 1792540952, rates: { SGD: 1, THB: 25.93, JPY: 113.6, MYR: 3.42 } }), { status: 200 });
    }) as typeof fetch;
    const store = new FxStore(db, new Map([['TH', { code: 'THB', symbol: '฿' }], ['JP', { code: 'JPY', symbol: '¥' }], ['SG', { code: 'SGD', symbol: '$' }], ['MY', { code: 'MYR', symbol: 'RM' }]]), fetchFn);
    await store.ensure();
    await store.ensure();
    expect(calls).toBe(1);
    const r = store.rates(['TH', 'SG', 'MY', 'MY', 'XX']);
    expect(r.date).toBe('2026-10-21');
    expect(r.rates.map((x) => [x.code, x.perSgd])).toEqual([['THB', 25.93], ['MYR', 3.42]]);
  });
});

describe('Monthly averages', () => {
  it('adds humidity and feels-like highs where the history has them', () => {
    const daily = Array.from({ length: 31 }, (_, i) => ({ date: `2025-01-${String(i + 1).padStart(2, '0')}`, precipMm: i < 5 ? 4 : 0, tMaxC: 30, tMinC: 24, rhMeanPct: 80, feelsMaxC: 36 }));
    const jan = monthlyNormals(daily)[0];
    expect(jan).toMatchObject({ month: 1, wetDays: 5, tMax: 30, tMin: 24, rh: 80, feelsMax: 36 });
    // Without feels-like (older stored days), the month has none rather than a partial figure.
    expect(monthlyNormals(daily.map(({ feelsMaxC: _f, ...d }) => d))[0].feelsMax).toBeNull();
  });
});
