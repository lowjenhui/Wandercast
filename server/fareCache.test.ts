import { describe, expect, it } from 'vitest';
import { fareRequestPlan, liveFarePath, planPaths } from '../src/lib/fareRequests';
import { openDb } from './db';
import { FareCache, fareKey, FRESH_MS, travelpayouts, type FareBody } from './fareCache';
import { FarePrefetcher } from './farePrefetch';
import { SavedRanges } from './savedRanges';
import { serpapiFlights } from './serpapi';

const PATH = '/v2/prices/latest?origin=SIN&destination=BKK&period_type=year';
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const body = (...departs: string[]) => ({ success: true, data: departs.map((d) => ({ depart_date: d, value: 200 })) });
const rows = (b: FareBody) => b.data as { depart_date: string }[];

/** A fake upstream: answers with the queued responses in order and counts calls. */
function upstream(...responses: Array<{ status: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const r = responses.shift() ?? { status: 500 };
    return new Response(r.json === undefined ? 'oops' : JSON.stringify(r.json), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('fare cache', () => {
  it('keys requests regardless of parameter order', () => {
    expect(fareKey('/a?b=2&a=1')).toBe(fareKey('/a?a=1&b=2'));
  });

  it('serves a fresh save without calling the API, then refreshes after 6 hours', async () => {
    let now = 1_000_000;
    const up = upstream({ status: 200, json: body(future(10)) }, { status: 200, json: body(future(11)) });
    const fc = new FareCache(openDb(':memory:'), travelpayouts('tok'), up.fetchFn, () => now);
    const first = await fc.get(PATH);
    expect(first.ok && first.body.saved).toBeUndefined(); // live, not from the database
    const second = await fc.get(PATH);
    expect(second.ok && second.body.saved).toEqual({ at: now, stale: false });
    expect(up.calls).toHaveLength(1);
    now += FRESH_MS + 1;
    const third = await fc.get(PATH);
    expect(up.calls).toHaveLength(2);
    expect(third.ok && rows(third.body)[0].depart_date).toBe(future(11));
  });

  it('falls back to the last save, marked stale, when the API is rate-limited, and pauses calls', async () => {
    let now = 1_000_000;
    const up = upstream({ status: 200, json: body(future(10)) }, { status: 429, headers: { 'Retry-After': '120' } });
    const fc = new FareCache(openDb(':memory:'), travelpayouts('tok'), up.fetchFn, () => now);
    await fc.get(PATH);
    now += FRESH_MS + 1;
    const r = await fc.get(PATH);
    expect(r.ok && r.body.saved).toEqual({ at: 1_000_000, stale: true });
    expect(r.ok && rows(r.body)).toHaveLength(1);
    expect(fc.paused).toBe(true);
    await fc.get(PATH);
    expect(up.calls).toHaveLength(2); // paused: no third call
  });

  it('falls back when the token is rejected or missing, and says so when nothing is saved', async () => {
    const db = openDb(':memory:');
    const up = upstream({ status: 200, json: body(future(5)) }, { status: 401, json: { error: 'Unauthorized' } });
    let now = 0;
    const fc = new FareCache(db, travelpayouts('tok'), up.fetchFn, () => now);
    await fc.get(PATH);
    now += FRESH_MS + 1;
    expect((await fc.get(PATH)).ok).toBe(true);

    const noToken = new FareCache(db, travelpayouts(''), up.fetchFn, () => now);
    const saved = await noToken.get(PATH);
    expect(saved.ok && saved.body.saved?.stale).toBe(true);
    const missing = await noToken.get('/v2/prices/latest?origin=SIN&destination=HND');
    expect(missing).toMatchObject({ ok: false, status: 501 });
  });

  it('hides departures that have passed and prunes saves whose departures have all passed', async () => {
    const db = openDb(':memory:');
    const fc = new FareCache(db, travelpayouts('tok'), upstream({ status: 200, json: body(future(-3), future(4)) }).fetchFn);
    const r = await fc.get(PATH);
    expect(r.ok && rows(r.body).map((x) => x.depart_date)).toEqual([future(4)]);
    db.prepare('UPDATE fare_cache SET last_depart = ?').run(future(-1));
    expect(fc.prune()).toBe(1);
  });

  it('moves rows saved before provider prefixes to Travelpayouts', () => {
    const db = openDb(':memory:');
    new FareCache(db, travelpayouts('tok'));
    db.prepare('INSERT INTO fare_cache VALUES (?, ?, ?, ?)').run(fareKey(PATH), JSON.stringify(body(future(3))), Date.now(), future(3));
    const fc = new FareCache(db, travelpayouts('tok'));
    expect(fc.isFresh(PATH)).toBe(true);
  });
});

describe('SerpApi live fares', () => {
  const airports = new Map([['TYO', ['HND', 'NRT']]]);
  const path = (dest: string, depart = future(30)) => liveFarePath('SIN', dest, depart, future(35));
  const google = {
    search_metadata: { google_flights_url: 'https://www.google.com/travel/flights?x', id: 'abc' },
    search_parameters: { engine: 'google_flights' },
    best_flights: [{ price: 640, total_duration: 415, flights: [{ airline: 'ANA', flight_number: 'NH 842', departure_airport: { id: 'SIN', time: '2026-12-04 22:30' }, arrival_airport: { id: 'HND', time: '2026-12-05 06:20' }, legroom: '31 in' }] }],
    other_flights: [],
    price_insights: { lowest_price: 640, price_level: 'low', typical_price_range: [700, 950] },
  };

  it('expands city codes, keeps the key server-side and stores a trimmed response', async () => {
    const up = upstream({ status: 200, json: google });
    const fc = new FareCache(openDb(':memory:'), serpapiFlights('secret', airports), up.fetchFn);
    const r = await fc.get(path('TYO'));
    const url = new URL(up.calls[0]);
    expect(url.searchParams.get('arrival_id')).toBe('HND,NRT');
    expect(url.searchParams.get('type')).toBe('1');
    expect(url.searchParams.get('currency')).toBe('SGD');
    expect(r.ok && r.body).toMatchObject({ google_flights_url: 'https://www.google.com/travel/flights?x', price_insights: { price_level: 'low' } });
    expect(r.ok && JSON.stringify(r.body)).not.toMatch(/secret|legroom|search_parameters/);
  });

  it('asks for the configured currency, keeping SGD paths unchanged', async () => {
    expect(liveFarePath('SIN', 'BKK', future(30), future(35), 'SGD')).not.toMatch(/currency/);
    expect(fareRequestPlan('SIN', 'BKK', future(30), future(35), undefined, 'USD').exact).toMatch(/currency=usd/);
    const up = upstream({ status: 200, json: google });
    const fc = new FareCache(openDb(':memory:'), serpapiFlights('k', airports), up.fetchFn);
    await fc.get(liveFarePath('SIN', 'BKK', future(30), future(35), 'USD'));
    expect(new URL(up.calls[0]).searchParams.get('currency')).toBe('USD');
  });

  it('treats "no results" as an empty answer and other errors as failures', async () => {
    const up = upstream(
      { status: 200, json: { error: "Google Flights hasn't returned any results for this query." } },
      { status: 200, json: { error: 'Invalid API key.' } },
    );
    const fc = new FareCache(openDb(':memory:'), serpapiFlights('k', airports), up.fetchFn);
    expect(await fc.get(path('BKK'))).toMatchObject({ ok: true, body: { best_flights: [], other_flights: [] } });
    expect(await fc.get(path('HAN'))).toMatchObject({ ok: false, reason: 'Invalid API key.' });
  });

  it('stops at the monthly allowance, keeping a reserve from background prefetch, and falls back to the save', async () => {
    let now = Date.parse('2026-11-02T00:00:00Z');
    const up = upstream(...Array.from({ length: 10 }, () => ({ status: 200, json: google })));
    const fc = new FareCache(openDb(':memory:'), serpapiFlights('k', airports, 5), up.fetchFn, () => now);
    await fc.get(path('BKK'));
    await fc.get(path('HAN'));
    await fc.get(path('KUL'));
    expect(fc.canSpend(true)).toBe(false); // reserve of 2 kept for searches people make
    expect(fc.canSpend()).toBe(true);
    await fc.get(path('MNL'));
    await fc.get(path('CGK'));
    expect(fc.canSpend()).toBe(false);
    now += FRESH_MS + 1;
    const r = await fc.get(path('BKK'));
    expect(r.ok && r.body.saved?.stale).toBe(true);
    expect(up.calls).toHaveLength(5);
    expect(fc.stats()).toMatchObject({ usedThisMonth: 5, monthlyLimit: 5 });
  });
});

describe('fare prefetch', () => {
  function setup() {
    const db = openDb(':memory:');
    const store = new SavedRanges(db);
    const start = future(30);
    const end = future(34);
    const r = store.add({ label: 'Trip', start, end });
    if (typeof r === 'string') throw new Error(r);
    store.addDestination(r.id, { name: 'Bangkok', country: 'Thailand', cc: 'TH', lat: 13.75, lon: 100.5, code: 'BKK' });
    store.addDestination(r.id, { name: 'Batam', country: 'Indonesia', cc: 'ID', lat: 1.13, lon: 104.05, code: 'FERRY-BATAM' });
    const past = store.add({ label: 'Old', start: future(-10), end: future(-5) });
    if (typeof past === 'string') throw new Error(past);
    store.addDestination(past.id, { name: 'Tokyo', country: 'Japan', cc: 'JP', lat: 35.68, lon: 139.69, code: 'TYO' });
    return { db, store, start, end };
  }

  it('plans the Flights section requests for upcoming saved destinations, skipping ones already saved', async () => {
    const { db, store, start, end } = setup();
    const up = upstream(...Array.from({ length: 10 }, () => ({ status: 200, json: body(start) })));
    const fc = new FareCache(db, travelpayouts('tok'), up.fetchFn);
    const pf = new FarePrefetcher(fc, store, (o, d, s, e, t) => planPaths(fareRequestPlan(o, d, s, e, t)), { refresh: true, tickMs: 1000 });
    const expected = planPaths(fareRequestPlan('SIN', 'BKK', start, end, new Date().toISOString().slice(0, 10)));
    expect(pf.pending()).toEqual(expected);
    expect(await pf.step()).toBe(true);
    expect(up.calls[0]).toBe(`https://api.travelpayouts.com${expected[0]}`);
    expect(pf.pending()).toEqual(expected.slice(1));
  });

  it('fetches each live search once, without refreshing', async () => {
    let now = Date.now();
    const { db, store, start, end } = setup();
    const up = upstream({ status: 200, json: { best_flights: [], other_flights: [] } });
    const fc = new FareCache(db, serpapiFlights('k', new Map()), up.fetchFn, () => now);
    const pf = new FarePrefetcher(fc, store, (o, d, s, e) => [liveFarePath(o, d, s, e)], { refresh: false, tickMs: 1000 });
    expect(pf.pending()).toEqual([liveFarePath('SIN', 'BKK', start, end)]);
    await pf.step();
    now += FRESH_MS + 1;
    expect(pf.pending()).toEqual([]);
  });
});
