import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { FareCache } from './fareCache';
import { diffAdvisory, diffAir, diffAlerts, diffEvents, diffForecast, Lookout, mergeEvents, within } from './lookout';
import { SavedRanges } from './savedRanges';
import { eventDays, eventsChip, serpapiEvents } from './serpapi';
import { Upstream } from './upstream';
import { cleanItinerary, countdown, forecastSummary, legEnds, packingFromForecast, psiFromPm25, stopDates, tripStage, tripTotal, type ForecastDay } from '../src/lib/lookout';

const day = (date: string, precipProb: number, tMax = 32, code = 61): ForecastDay => ({ date, code, precipProb, precipMm: 2, tMax, tMin: 25, feelsMax: tMax + 4 });

describe('Lookout change detection', () => {
  it('says when the forecast first covers the trip, then flags big rain-chance and temperature moves', () => {
    expect(diffForecast(undefined, { at: 1, days: [day('2026-10-24', 40)] }, 5, false)).toEqual([]);
    expect(diffForecast(undefined, { at: 1, days: [day('2026-10-24', 40)] }, 5, true)).toEqual(['The forecast now covers 1 of your 5 days.']);
    const prev = { at: 1, days: [day('2026-10-24', 40), day('2026-10-25', 30, 31)] };
    const next = { at: 2, days: [day('2026-10-24', 70, 32, 95), day('2026-10-25', 35, 35)] };
    expect(diffForecast(prev, next, 2, true)).toEqual(['Rain chance on Sat 24 Oct up from 40% to 70%, with thunderstorms.', 'High on Sun 25 Oct now 35 °C (was 31 °C).']);
  });

  it('flags air quality moving to another AQI band', () => {
    const prev = { at: 1, days: [{ date: '2026-10-25', aqi: 74, pm25: 20, dust: 0 }], now: null };
    const next = { at: 2, days: [{ date: '2026-10-25', aqi: 112, pm25: 40, dust: 0 }], now: null };
    expect(diffAir(prev, next, true)).toEqual(['Air quality on Sun 25 Oct now Unhealthy for sensitive groups (AQI 112, was 74).']);
    expect(diffAir(prev, { ...next, days: [{ date: '2026-10-25', aqi: 90, pm25: 30, dust: 0 }] }, true)).toEqual([]);
  });

  it('lists new events after the first search, and MFA level or page changes', () => {
    const ev = (title: string) => ({ title, startDate: 'Oct 25', when: 'Sun, Oct 25', venue: null, address: null, link: null, key: `${title}|2026-10-25`, from: '2026-10-25', to: '2026-10-25', firstSeen: 1 });
    expect(diffEvents(undefined, { at: 1, items: [ev('A'), ev('B')] })).toEqual(['Puff found 2 events on your dates.']);
    expect(diffEvents({ at: 1, items: [ev('A')] }, { at: 2, items: [ev('A'), ev('B')] })).toEqual(['New event: B · Sun 25 Oct.']);
    const adv = { at: 1, slug: 'thailand', title: 'Thailand', level: 'none' as const, mfaDate: '2026-09-01' };
    expect(diffAdvisory(adv, { ...adv, mfaDate: '2026-10-14' })).toEqual(['MFA updated its Thailand page (2026-10-14): still “No advisory”.']);
    expect(diffAdvisory(adv, { ...adv, level: 'nonEssential' })).toEqual(['MFA now says “Defer non-essential travel” for Thailand (was “No advisory”).']);
  });

  it('reads Google Events dates and keeps those overlapping the trip', () => {
    expect(eventDays('Oct 24', 'Sat, Oct 24, 8 – 11 PM', '2026-10-23')).toEqual({ from: '2026-10-24', to: '2026-10-24' });
    expect(eventDays('Oct 20', 'Oct 20 – Nov 2', '2026-10-23')).toEqual({ from: '2026-10-20', to: '2026-11-02' });
    expect(eventDays('Dec 30', 'Dec 30 – Jan 2', '2027-01-01')).toEqual({ from: '2026-12-30', to: '2027-01-02' });
    const found = [
      { title: 'Design Week market', startDate: 'Oct 25', when: 'Sun, Oct 25', venue: 'Charoen Krung', address: null, link: null },
      { title: 'Too late', startDate: 'Nov 3', when: 'Tue, Nov 3', venue: null, address: null, link: null },
      { title: 'Long fair', startDate: 'Oct 20', when: 'Oct 20 – 26', venue: null, address: null, link: null },
    ];
    const out = mergeEvents(found, { start: '2026-10-23', end: '2026-10-27' }, [], 5);
    expect(out.map((e) => e.title)).toEqual(['Long fair', 'Design Week market']);
    expect(mergeEvents(found, { start: '2026-10-23', end: '2026-10-27' }, [{ ...out[1], firstSeen: 1 }], 9).find((e) => e.title === 'Design Week market')?.firstSeen).toBe(1);
  });

  it('picks the events date filter for this or next month only', () => {
    expect(eventsChip('2026-10-23', '2026-10-27', '2026-10-21')).toBe('date:month');
    expect(eventsChip('2026-11-20', '2026-11-27', '2026-10-21')).toBe('date:next_month');
    expect(eventsChip('2026-12-12', '2026-12-18', '2026-10-21')).toBeNull();
    expect(within({ start: '2026-11-01', end: '2026-11-07' }, '2026-10-21', 16)).toEqual({ start: '2026-11-01', end: '2026-11-05' });
    expect(within({ start: '2026-12-12', end: '2026-12-18' }, '2026-10-21', 16)).toBeNull();
  });
});

describe('Lookout page helpers', () => {
  it('counts down and names the stage', () => {
    expect(countdown('2026-10-23', '2026-10-27', '2026-10-21')).toBe('2 days to go');
    expect(countdown('2026-10-23', '2026-10-27', '2026-10-22')).toBe('Tomorrow!');
    expect(countdown('2026-10-23', '2026-10-27', '2026-10-24')).toBe('Day 2 of 5');
    expect(tripStage('2026-12-12', '2026-12-18', '2026-10-21')).toBe('booked');
    expect(tripStage('2026-11-01', '2026-11-05', '2026-10-21')).toBe('forecast');
    expect(tripStage('2026-10-23', '2026-10-27', '2026-10-21')).toBe('air');
    expect(tripStage('2026-10-20', '2026-10-27', '2026-10-21')).toBe('travelling');
  });

  it('summarises the forecast and suggests what to pack', () => {
    const days = [day('2026-10-23', 50, 33, 61), day('2026-10-24', 70, 32, 95), day('2026-10-25', 30, 33, 3), day('2026-10-26', 20, 34, 1), day('2026-10-27', 45, 33, 61)];
    expect(forecastSummary(days)).toEqual({ rating: 'Showery', headline: 'Storms likely on Sat; Mon looks the driest.' });
    expect(packingFromForecast(days)).toEqual(['Compact umbrella for Fri, Sat', 'Light, breathable clothes and sun protection (feels like 38 °C at midday)', 'A light layer for air-conditioned malls and transport']);
    expect(psiFromPm25(30)).toBe(71);
  });
});

/** Open-Meteo double: a forecast and air-quality answer that tests can change between checks. */
class FakeUpstream extends Upstream {
  rain = 40;
  aqi = 60;
  calls: string[] = [];
  async fetchJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    const u = new URL(url);
    if (u.hostname.startsWith('air-quality')) {
      const time = ['2026-10-23T12:00', '2026-10-24T12:00', '2026-10-25T12:00'];
      return { hourly: { time, us_aqi_pm2_5: time.map(() => this.aqi), us_aqi_pm10: time.map(() => 20), pm2_5: time.map(() => 20), dust: time.map(() => 0) }, current: { time: '2026-10-21T18:00', us_aqi_pm2_5: 50, pm2_5: 12 } } as T;
    }
    const time: string[] = [];
    for (let d = u.searchParams.get('start_date')!; d <= u.searchParams.get('end_date')!; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) time.push(d);
    return {
      daily: {
        time,
        weather_code: time.map(() => 61),
        precipitation_probability_max: time.map(() => this.rain),
        precipitation_sum: time.map(() => 3),
        temperature_2m_max: time.map(() => 33),
        temperature_2m_min: time.map(() => 26),
        apparent_temperature_max: time.map(() => 38),
      },
    } as T;
  }
}

describe('Itineraries', () => {
  it('checks stops and nights, and fills in legs', () => {
    expect(cleanItinerary({ stops: [] }, [1, 2], 6)).toBe('Choose at least one place you’re visiting.');
    expect(cleanItinerary({ stops: [{ destId: 9, nights: 6 }] }, [1, 2], 6)).toBe('Choose places saved for these dates.');
    expect(cleanItinerary({ stops: [{ destId: 1, nights: 2 }, { destId: 2, nights: 3 }] }, [1, 2], 6)).toBe('The nights add up to 5; these dates have 6.');
    const it = cleanItinerary({ stops: [{ destId: 1, nights: 2, stay: { name: ' Hotel Puri ', price: 'S$180' } }, { destId: 2, nights: 4 }], legs: [{ mode: 'coach', price: 'S$25' }, { mode: 'boat' }] }, [1, 2], 6);
    expect(it).toEqual({
      stops: [{ destId: 1, nights: 2, stay: { name: 'Hotel Puri', price: 'S$180' } }, { destId: 2, nights: 4 }],
      legs: [{ mode: 'coach', price: 'S$25' }, { mode: null }, { mode: null }],
    });
    // One place always gets every night.
    expect(cleanItinerary({ stops: [{ destId: 1, nights: 0 }] }, [1], 6)).toMatchObject({ stops: [{ destId: 1, nights: 6 }] });
  });

  it('works out each stop’s days (a travel day counts for the place you arrive at)', () => {
    const it = { stops: [{ destId: 1, nights: 2 }, { destId: 2, nights: 4 }], legs: [] };
    expect(stopDates(it, '2026-11-07', '2026-11-13')).toEqual([
      { destId: 1, arrive: '2026-11-07', leave: '2026-11-09', days: ['2026-11-07', '2026-11-08'] },
      { destId: 2, arrive: '2026-11-09', leave: '2026-11-13', days: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'] },
    ]);
    expect(legEnds(['Malacca', 'Kuala Lumpur'])).toEqual([['Singapore', 'Malacca'], ['Malacca', 'Kuala Lumpur'], ['Kuala Lumpur', 'Singapore']]);
    expect(tripTotal({ stops: [{ destId: 1, nights: 2, stay: { price: 'S$180' } }], legs: [{ mode: 'coach', price: 'S$25.50' }, { mode: 'flight', price: '1,098' }] })).toBe(1303.5);
    expect(tripTotal({ stops: [{ destId: 1, nights: 2 }], legs: [{ mode: null }] })).toBeNull();
  });
});

describe('Lookout watcher and booking', () => {
  function setup() {
    const db = openDb(':memory:');
    const saved = new SavedRanges(db);
    const up = new FakeUpstream(db);
    let now = Date.parse('2026-10-21T09:00:00+08:00');
    const serp = { calls: 0 };
    const events = new FareCache(
      db,
      serpapiEvents('key'),
      (async () => {
        serp.calls++;
        return new Response(JSON.stringify({ events_results: [{ title: 'Muay Thai night', date: { start_date: 'Oct 24', when: 'Sat, Oct 24, 7 PM' } }] }), { status: 200 });
      }) as typeof fetch,
      () => now,
    );
    const lookout = new Lookout(db, saved, up, { events, now: () => now });
    const r = saved.add({ label: 'Bangkok', start: '2026-10-23', end: '2026-10-27' }) as { id: number };
    const dest = saved.addDestination(r.id, { name: 'Bangkok', country: 'Thailand', cc: 'TH', lat: 13.75, lon: 100.5, code: 'BKK' }) as { id: number };
    return { db, saved, up, lookout, r, dest, serp, tick: (ms: number) => (now += ms) };
  }

  it('books a destination, watches it, and logs changes after the baseline', async () => {
    const { saved, up, lookout, r, dest, serp, tick } = setup();
    expect(saved.book(r.id, { itinerary: { stops: [{ destId: 999, nights: 4 }] } })).toBe('Choose places saved for these dates.');
    const booked = saved.book(r.id, { itinerary: { stops: [{ destId: dest.id, nights: 4 }], legs: [{ mode: 'flight', detail: 'TG404' }, { mode: 'flight', detail: 'TG413' }] }, booked_on: '2026-09-02' });
    expect(typeof booked).not.toBe('string');
    expect(saved.booking(saved.get(r.id)!)).toMatchObject({ destId: dest.id, itinerary: { legs: [{ mode: 'flight', detail: 'TG404' }, { detail: 'TG413' }] } });
    lookout.start(r.id, dest.id, { [dest.id]: { weather: { pMostlyDry: 0.34 } } });
    saved.markSeen(r.id, Date.parse('2026-10-21T08:00:00+08:00'));

    await lookout.check(saved.get(r.id)!);
    const s1 = lookout.state(r.id).places![dest.id];
    expect(s1.forecast?.days).toHaveLength(5);
    expect(s1.air?.days.map((d) => d.aqi)).toEqual([60, 60, 60]);
    expect(s1.events?.items.map((e) => e.title)).toEqual(['Muay Thai night']);
    // The first check is the baseline: only the events summary is logged.
    expect(lookout.changes(r.id).map((c) => c.text)).toEqual(['Puff found 1 event on your dates.']);
    expect(lookout.baseline(r.id)).toEqual({ [dest.id]: { weather: { pMostlyDry: 0.34 } } });

    // Within 3 hours nothing is fetched again.
    const calls = up.calls.length;
    await lookout.check(saved.get(r.id)!);
    expect(up.calls.length).toBe(calls);

    up.rain = 70;
    up.aqi = 120;
    tick(3 * 3600_000 + 1);
    await lookout.check(saved.get(r.id)!);
    const texts = lookout.changes(r.id).map((c) => c.text);
    expect(texts).toContain('Rain chance on Sat 24 Oct up from 40% to 70%.');
    expect(texts).toContain('Air quality on Fri 23 Oct now Unhealthy for sensitive groups (AQI 120, was 60).');
    // Events are searched weekly, not every check.
    expect(serp.calls).toBe(1);
    expect(lookout.unread(saved.get(r.id)!)).toBeGreaterThan(2);
    saved.markSeen(r.id, Date.parse('2026-10-22T00:00:00+08:00'));
    expect(lookout.unread(saved.get(r.id)!)).toBe(0);
  });

  it('watches each stop over its own dates and names it in changes', async () => {
    const { saved, up, lookout, r, dest, tick } = setup();
    const kl = saved.addDestination(r.id, { name: 'Kuala Lumpur', country: 'Malaysia', cc: 'MY', lat: 3.14, lon: 101.69, code: 'KUL' }) as { id: number };
    saved.book(r.id, { itinerary: { stops: [{ destId: dest.id, nights: 2 }, { destId: kl.id, nights: 2 }], legs: [{ mode: 'flight' }, { mode: 'coach' }, { mode: 'flight' }] } });
    await lookout.check(saved.get(r.id)!);
    const st = lookout.state(r.id).places!;
    expect(st[dest.id].forecast?.days.map((d) => d.date)).toEqual(['2026-10-23', '2026-10-24']);
    expect(st[kl.id].forecast?.days.map((d) => d.date)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    up.rain = 75;
    tick(3 * 3600_000 + 1);
    await lookout.check(saved.get(r.id)!);
    expect(lookout.changes(r.id).map((c) => c.text)).toContain('Kuala Lumpur: Rain chance on Sun 25 Oct up from 40% to 75%.');
  });

  it('reads bookings and watch state saved before itineraries', () => {
    const { db, saved, lookout, r, dest } = setup();
    db.prepare('UPDATE saved_ranges SET booked_dest_id = ?, booked_at = 1, booking_info = ? WHERE id = ?').run(dest.id, JSON.stringify({ paid: 'S$318', flights: 'TG404', stay: 'Ibis' }), r.id);
    expect(saved.booking(saved.get(r.id)!)?.itinerary).toEqual({
      stops: [{ destId: dest.id, nights: 4, stay: { name: 'Ibis' } }],
      legs: [{ mode: null, detail: 'TG404', price: 'S$318' }, { mode: null }],
    });
    db.prepare('INSERT INTO lookout_state (range_id, dest_id, baseline, state, updated_at) VALUES (?,?,NULL,?,1)').run(r.id, dest.id, JSON.stringify({ started: 1, forecast: { at: 1, days: [] }, advisory: { at: 1, slug: null, title: 'Thailand', level: 'none', mfaDate: null } }));
    expect(lookout.state(r.id)).toEqual({ started: 1, places: { [dest.id]: { forecast: { at: 1, days: [] } } }, advisories: { TH: { at: 1, slug: null, title: 'Thailand', level: 'none', mfaDate: null } } });
  });

  it('prunes the places not visited', () => {
    const { saved, r, dest } = setup();
    saved.addDestination(r.id, { name: 'Taipei', country: 'Taiwan', cc: 'TW', lat: 25.03, lon: 121.56, code: 'TPE' });
    saved.book(r.id, { itinerary: { stops: [{ destId: dest.id, nights: 4 }] } });
    expect(saved.prune(r.id, [dest.id])).toBe(1);
    expect(saved.destinations(r.id).map((d) => d.name)).toEqual(['Bangkok']);
  });

  it('change plans and removing the booked destination go back to planning', () => {
    const { saved, r, dest } = setup();
    const it = { stops: [{ destId: dest.id, nights: 4 }] };
    saved.book(r.id, { itinerary: it });
    expect(saved.get(r.id)?.booked_on).toBe(new Date().toLocaleDateString('sv'));
    expect(saved.unbook(r.id)?.booked_dest_id).toBeNull();
    saved.book(r.id, { itinerary: it });
    saved.removeDestination(r.id, dest.id);
    expect(saved.get(r.id)?.booked_dest_id).toBeNull();
  });
});

describe('diffAlerts', () => {
  const a = { id: 'x', source: 'us-embassy', cc: 'FR', kind: 'demonstration', title: '', summary: 'Protests are expected.', url: '', issued: '2026-10-19T00:00:00Z', places: [{ name: 'Paris', lat: 48.857, lon: 2.352 }] } as const;
  it('logs nothing at the baseline check, then each new alert once', () => {
    expect(diffAlerts(undefined, [{ ...a, places: [...a.places] }])).toEqual([]);
    expect(diffAlerts(['x'], [{ ...a, places: [...a.places] }])).toEqual([]);
    expect(diffAlerts([], [{ ...a, places: [...a.places] }])).toEqual([
      "New US Embassy demonstration alert (Paris): Protests are expected. MFA's advice hasn't changed, and your insurance cover is unaffected.",
    ]);
  });
});
