import { describe, expect, it } from 'vitest';
import { liveLegPlan, liveLegPaths } from '../src/lib/fareRequests';
import { openDb } from './db';
import { FareCache } from './fareCache';
import { serpapiFlights } from './serpapi';

describe('SerpApi one-way legs', () => {
  it('plans out on the start date and back the evening before and on the landing day', () => {
    const plan = liveLegPlan('SIN', 'BKK', '2026-12-04', '2026-12-08', 'SGD');
    expect(liveLegPaths(plan)).toEqual([
      '/search?origin=SIN&destination=BKK&depart=2026-12-04',
      '/search?origin=BKK&destination=SIN&depart=2026-12-07',
      '/search?origin=BKK&destination=SIN&depart=2026-12-08',
    ]);
  });

  it('asks Google Flights for a one-way search when there is no return date', () => {
    const p = serpapiFlights('k', new Map([['TYO', ['HND', 'NRT']]]));
    const url = new URL(p.request('/search?origin=TYO&destination=SIN&depart=2026-12-07').url);
    expect(url.searchParams.get('type')).toBe('2');
    expect(url.searchParams.has('return_date')).toBe(false);
    expect(url.searchParams.get('departure_id')).toBe('HND,NRT');
    expect(new URL(p.request('/search?origin=SIN&destination=BKK&depart=2026-12-04&return=2026-12-08').url).searchParams.get('type')).toBe('1');
  });

  it('keeps overnight layovers when trimming responses', () => {
    const p = serpapiFlights('k', new Map());
    const r = p.accept({ best_flights: [{ price: 1, flights: [], layovers: [{ id: 'TPE', duration: 600, overnight: true, name: 'Taoyuan' }] }] });
    expect('body' in r && (r.body.best_flights as { layovers: unknown[] }[])[0].layovers).toEqual([{ id: 'TPE', duration: 600, overnight: true }]);
  });
});

describe('SerpApi search counting', () => {
  const path = '/search?origin=SIN&destination=BKK&depart=2099-12-04';

  it('sends one request for the same search asked for twice at once, and counts only successes', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(calls === 1 ? JSON.stringify({ best_flights: [] }) : JSON.stringify({ error: 'Invalid API key.' }), { status: 200 });
    }) as unknown as typeof fetch;
    const fc = new FareCache(openDb(':memory:'), serpapiFlights('k', new Map()), fetchFn);
    const [a, b] = await Promise.all([fc.get(path), fc.get(path)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(fc.used()).toBe(1);
    await fc.get('/search?origin=SIN&destination=HAN&depart=2099-12-04'); // error: not counted
    expect(fc.used()).toBe(1);
  });

  it("syncs the month's count from SerpApi's account endpoint", async () => {
    const fetchFn = (async (url: string) =>
      new Response(JSON.stringify(url.includes('account.json') ? { this_month_usage: 29 } : {}), { status: 200 })) as unknown as typeof fetch;
    const fc = new FareCache(openDb(':memory:'), serpapiFlights('k', new Map()), fetchFn);
    expect(await fc.syncUsage()).toBe(29);
    expect(fc.used()).toBe(29);
  });
});
