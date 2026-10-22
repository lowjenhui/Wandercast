import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { fareRequestPlan, planPaths } from '../src/lib/fareRequests';
import { openDb } from './db';
import { FareCache, travelpayouts } from './fareCache';
import { SavedRanges } from './savedRanges';
import { archiveRangeOf, isArchived, TripArchive } from './tripArchive';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv');

/** A fake upstream that answers every request with fares departing on `depart`. */
function upstream(depart: string) {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response(JSON.stringify({ success: true, data: [{ depart_date: depart, return_at: depart, value: 300 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

/** Runs a middleware against a fake request and returns its status and JSON body. */
async function call(mw: (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const text = init.body === undefined ? '' : JSON.stringify(init.body);
  const req = Object.assign((async function* () { if (text) yield text; })(), { url, method: init.method ?? 'GET', headers: init.headers ?? {} }) as unknown as IncomingMessage;
  let status = 0;
  let out = '';
  const res = { writeHead: (s: number) => (status = s), end: (b: string) => (out = b) } as unknown as ServerResponse;
  await mw(req, res, () => (status = -1));
  return { status, body: out ? (JSON.parse(out) as Record<string, unknown>) : null };
}

describe('trip archive', () => {
  it('archives ranges once their end date has passed', () => {
    expect(isArchived({ end: '2026-10-20' }, '2026-10-21')).toBe(true);
    expect(isArchived({ end: '2026-10-21' }, '2026-10-21')).toBe(false);
  });

  it('copies pre-trip fares before pruning and serves them only for that trip', async () => {
    const db = openDb(':memory:');
    const saved = new SavedRanges(db);
    const archive = new TripArchive(db);
    saved.archive = archive;
    const start = day(1);
    const end = day(3);
    const r = saved.add({ label: 'Soon', start, end });
    if (typeof r === 'string') throw new Error(r);
    saved.addDestination(r.id, { name: 'Bangkok', country: 'Thailand', cc: 'TH', lat: 13.75, lon: 100.5, code: 'BKK' });

    const up = upstream(start);
    const fares = new FareCache(db, travelpayouts('tok'), up.fetchFn);
    const plan = (o: string, d: string, s: string, e: string, t: string) => planPaths(fareRequestPlan(o, d, s, e, t));
    const paths = plan('SIN', 'BKK', start, end, start);
    for (const p of paths) await fares.get(p);

    expect(archive.captureFares(saved, [{ cache: fares, plan }])).toBe(paths.length);
    // Copying again changes nothing: the archive keeps the newest pre-trip copy.
    expect(archive.captureFares(saved, [{ cache: fares, plan }])).toBe(0);

    const route = fares.handler({ rangeOf: archiveRangeOf, fare: (id, key) => archive.fare(id, key) });
    const hit = await call(route, `/api/fares${paths[0]}`, { headers: { 'x-wandercast-archive': String(r.id) } });
    expect(hit.status).toBe(200);
    expect(hit.body?.saved).toMatchObject({ archived: true, stale: false });
    const miss = await call(route, `/api/fares${paths[0]}`, { headers: { 'x-wandercast-archive': '999' } });
    expect(miss).toMatchObject({ status: 404, body: { reason: 'Not saved for this trip.' } });
    // Archive requests never reach the API.
    expect(up.calls()).toBe(paths.length);

    saved.remove(r.id);
    expect(archive.fare(r.id, 'tp:x')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM fare_archive').get()).toEqual({ n: 0 });
  });

  it('skips fares fetched after the trip started', () => {
    const db = openDb(':memory:');
    const saved = new SavedRanges(db);
    const archive = new TripArchive(db);
    const r = saved.add({ start: day(-5), end: day(-2) });
    if (typeof r === 'string') throw new Error(r);
    saved.addDestination(r.id, { name: 'Bangkok', country: 'Thailand', cc: 'TH', lat: 13.75, lon: 100.5, code: 'BKK' });
    const fake = { stored: () => ({ key: 'tp:/x', body: '{}', fetched_at: Date.now() }) } as unknown as FareCache;
    expect(archive.captureFares(saved, [{ cache: fake, plan: () => ['/x'] }])).toBe(0);
  });

  it('keeps past trips read-only, with snapshots frozen and cleared on delete', async () => {
    const db = openDb(':memory:');
    const saved = new SavedRanges(db);
    saved.archive = new TripArchive(db);
    const up = saved.add({ label: 'Upcoming', start: day(10), end: day(12) });
    const past = saved.add({ label: 'Done', start: day(-6), end: day(-2) });
    if (typeof up === 'string' || typeof past === 'string') throw new Error('add failed');
    const d = saved.addDestination(up.id, { name: 'Bangkok', country: 'Thailand', cc: 'TH', lat: 13.75, lon: 100.5, code: 'BKK' });
    const pd = saved.addDestination(past.id, { name: 'Hanoi', country: 'Vietnam', cc: 'VN', lat: 21.03, lon: 105.85, code: 'HAN' });
    if (!d || typeof d === 'string' || !pd || typeof pd === 'string') throw new Error('add destination failed');
    const mw = saved.handler();

    const snap = { weather: { rating: 'Pleasant', headline: 'Dry' }, fares: null, crowds: { level: null, notes: [] }, advisory: null, conclusion: null };
    expect((await call(mw, `/api/saved/${up.id}/destinations/${d.id}/snapshot`, { method: 'PUT', body: snap })).status).toBe(200);
    expect((await call(mw, `/api/saved/${past.id}/destinations/${pd.id}/snapshot`, { method: 'PUT', body: snap })).status).toBe(409);
    expect((await call(mw, `/api/saved/${past.id}`, { method: 'PATCH', body: { label: 'New' } })).status).toBe(409);
    expect((await call(mw, `/api/saved/${past.id}/destinations`, { method: 'POST', body: { name: 'Hue', cc: 'VN', lat: 16.46, lon: 107.59 } })).status).toBe(409);

    const list = (await call(mw, '/api/saved')).body as unknown as { id: number; archived: boolean; destinations: { snapshot?: { weather: { rating: string }; at: number } }[] }[];
    expect(list.map((x) => [x.id, x.archived])).toEqual([[past.id, true], [up.id, false]]);
    expect(list[1].destinations[0].snapshot).toMatchObject({ weather: { rating: 'Pleasant' } });
    expect(typeof list[1].destinations[0].snapshot?.at).toBe('number');

    // Deleting is still allowed for past trips.
    expect((await call(mw, `/api/saved/${past.id}`, { method: 'DELETE' })).status).toBe(200);
    saved.removeDestination(up.id, d.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM saved_snapshots').get()).toEqual({ n: 0 });
  });
});

describe('wander list', () => {
  it('stores places and rejects bad input', async () => {
    const saved = new SavedRanges(openDb(':memory:'));
    const mw = saved.handler();
    expect((await call(mw, '/api/settings/wander')).body).toEqual({ places: [] });
    const put = await call(mw, '/api/settings/wander', { method: 'PUT', body: { places: [{ name: 'Phuket', country: 'Thailand', cc: 'th', lat: 7.88, lon: 98.39 }] } });
    expect(put.body).toEqual({ places: [{ name: 'Phuket', country: 'Thailand', cc: 'TH', lat: 7.88, lon: 98.39 }] });
    expect((await call(mw, '/api/settings/wander', { method: 'PUT', body: { places: [{ name: '', lat: 1, lon: 1 }] } })).status).toBe(400);
    expect(saved.wanderList()).toHaveLength(1);
  });
});
