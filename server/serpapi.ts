// SerpApi Google Flights: live prices for exact dates, served at /api/live-fares/* through the
// fare cache (so each search is saved and reused, and falls back when the monthly allowance runs
// out). The local path is /search?origin=&destination=&depart= for a one-way leg (what the flight
// rules use), or with &return= for a round trip (src/lib/fareRequests.ts), plus &currency= when
// it isn't SGD; city codes such as TYO are expanded to their airports.
// Docs: https://serpapi.com/google-flights-api

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FareBody, FareProvider } from './fareCache';
import type { LiveEvent } from '../src/lib/lookout';

type Row = [iata: string, cityCode: string, name: string, lat: number, lon: number, cc: string];

/** City code → its airports, from public/airports.json (e.g. TYO → HND,NRT). */
export function cityAirports(publicDir: string): Map<string, string[]> {
  const rows = JSON.parse(readFileSync(join(publicDir, 'airports.json'), 'utf8')) as Row[];
  const m = new Map<string, string[]>();
  for (const [iata, city] of rows) m.set(city, [...(m.get(city) ?? []), iata]);
  return m;
}

interface Leg {
  departure_airport?: { id?: string; time?: string };
  arrival_airport?: { id?: string; time?: string };
  airline?: string;
  airline_logo?: string;
  flight_number?: string;
  duration?: number;
}
interface Option {
  price?: number;
  total_duration?: number;
  flights?: Leg[];
  layovers?: { id?: string; duration?: number; overnight?: boolean }[];
}

const trimOption = (o: Option) => ({
  price: o.price,
  total_duration: o.total_duration,
  flights: (o.flights ?? []).map((f) => ({
    departure_airport: f.departure_airport,
    arrival_airport: f.arrival_airport,
    airline: f.airline,
    airline_logo: f.airline_logo,
    flight_number: f.flight_number,
    duration: f.duration,
  })),
  layovers: (o.layovers ?? []).map((l) => ({ id: l.id, duration: l.duration, overnight: l.overnight ?? false })),
});

const NO_RESULTS = /hasn't returned any results|no results/i;

export function serpapiFlights(apiKey: string, airports: Map<string, string[]>, monthlyLimit = 250): FareProvider {
  const ids = (code: string) => (airports.get(code) ?? [code]).join(',');
  const departOf = (path: string) => new URL(path, 'http://local').searchParams.get('depart') ?? '';
  return {
    name: 'SerpApi',
    prefix: 'serp:',
    route: '/api/live-fares',
    configured: Boolean(apiKey),
    monthlyLimit,
    // Background prefetch stops with 40% of the month left for searches people make.
    backgroundReserve: Math.round(monthlyLimit * 0.4),
    request(path) {
      const q = new URL(path, 'http://local').searchParams;
      const ret = q.get('return');
      const p = new URLSearchParams({
        engine: 'google_flights',
        departure_id: ids(q.get('origin') ?? ''),
        arrival_id: ids(q.get('destination') ?? ''),
        outbound_date: q.get('depart') ?? '',
        ...(ret ? { return_date: ret } : {}),
        type: ret ? '1' : '2',
        travel_class: '1',
        adults: '1',
        currency: q.get('currency') ?? 'SGD',
        hl: 'en',
        gl: 'sg',
        api_key: apiKey,
      });
      return { url: `https://serpapi.com/search.json?${p}` };
    },
    accept(body) {
      const meta = body.search_metadata as { google_flights_url?: string } | undefined;
      const trimmed: FareBody = {
        best_flights: ((body.best_flights as Option[] | undefined) ?? []).map(trimOption),
        other_flights: ((body.other_flights as Option[] | undefined) ?? []).map(trimOption),
        price_insights: body.price_insights ?? null,
        google_flights_url: meta?.google_flights_url ?? null,
      };
      if (body.error && !NO_RESULTS.test(String(body.error))) return { reason: String(body.error).slice(0, 200) };
      return { body: trimmed };
    },
    // The account endpoint is free and reports searches used in the current billing month.
    async usage(fetchFn) {
      const res = await fetchFn(`https://serpapi.com/account.json?${new URLSearchParams({ api_key: apiKey })}`);
      if (!res.ok) return null;
      const n = ((await res.json()) as { this_month_usage?: unknown }).this_month_usage;
      return typeof n === 'number' ? n : null;
    },
    departures: (_body, path) => [departOf(path)],
    upcoming: (body, path, today) => (departOf(path) >= today ? body : { ...body, best_flights: [], other_flights: [] }),
  };
}

// --- SerpApi Google Events: what's on in a city, for booked trips (Puff's Lookout) ---
// Local path: /search?q=<city>&chip=<htichips>&end=<trip end>&gl=<country>. It shares the
// 'serp:' prefix with the flight searches, so both count against the same monthly allowance.
// Docs: https://serpapi.com/google-events-api

interface EventRow {
  title?: string;
  date?: { start_date?: string; when?: string };
  address?: string[];
  link?: string;
  venue?: { name?: string };
}


export function serpapiEvents(apiKey: string, monthlyLimit = 250): FareProvider {
  const endOf = (path: string) => new URL(path, 'http://local').searchParams.get('end') ?? '';
  return {
    name: 'SerpApi',
    prefix: 'serp:',
    route: '/api/live-events',
    configured: Boolean(apiKey),
    monthlyLimit,
    backgroundReserve: Math.round(monthlyLimit * 0.4),
    request(path) {
      const q = new URL(path, 'http://local').searchParams;
      const chip = q.get('chip');
      const p = new URLSearchParams({
        engine: 'google_events',
        q: `Events in ${q.get('q') ?? ''}`,
        ...(chip ? { htichips: chip } : {}),
        hl: 'en',
        ...(q.get('gl') ? { gl: q.get('gl')!.toLowerCase() } : {}),
        api_key: apiKey,
      });
      return { url: `https://serpapi.com/search.json?${p}` };
    },
    accept(body) {
      if (body.error && !NO_RESULTS.test(String(body.error))) return { reason: String(body.error).slice(0, 200) };
      const events: LiveEvent[] = ((body.events_results as EventRow[] | undefined) ?? [])
        .filter((e) => e.title && e.date?.start_date)
        .map((e) => ({
          title: e.title!.slice(0, 140),
          startDate: e.date!.start_date!,
          when: e.date?.when ?? e.date!.start_date!,
          venue: e.venue?.name ?? null,
          address: e.address?.join(', ') ?? null,
          link: e.link ?? null,
        }));
      return { body: { events } };
    },
    departures: (_body, path) => [endOf(path)],
    upcoming: (body) => body,
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The days an event runs, from Google's "Oct 24" start date and its "when" text (e.g. "Sat, Oct
 * 24, 8 – 11 PM" or "Oct 20 – Nov 2"). Google leaves out the year, so it's the one that puts the
 * date nearest `refDate` (the trip start). Null when the date can't be read.
 */
export function eventDays(startDate: string, when: string, refDate: string): { from: string; to: string } | null {
  const md = (s: string) => {
    const m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
    const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    return mi >= 0 ? { m: mi, d: Number(m![2]) } : null;
  };
  const near = (x: { m: number; d: number }) => {
    const ry = Number(refDate.slice(0, 4));
    const opts = [ry - 1, ry, ry + 1].map((y) => new Date(Date.UTC(y, x.m, x.d)).toISOString().slice(0, 10));
    const ref = Date.parse(refDate);
    return opts.sort((a, b) => Math.abs(Date.parse(a) - ref) - Math.abs(Date.parse(b) - ref))[0];
  };
  const first = md(startDate);
  if (!first) return null;
  const from = near(first);
  // A range in "when": "Oct 20 – Nov 2" or "Oct 20 – 26".
  const range = when.match(/([A-Za-z]{3}[a-z]*\.?\s+\d{1,2})\s*[–-]\s*([A-Za-z]{3}[a-z]*\.?\s+\d{1,2}|\d{1,2})\b(?!\s*(?:AM|PM|:))/i);
  let to = from;
  if (range) {
    const endPart = /^\d/.test(range[2]) ? { m: first.m, d: Number(range[2]) } : md(range[2]);
    if (endPart) {
      to = near(endPart);
      if (to < from) to = from;
    }
  }
  return { from, to };
}

/** Google Events' date filter that covers a trip starting on `start`, or null when it's too far off. */
export function eventsChip(start: string, end: string, today: string): string | null {
  const ym = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
  const t = ym(today);
  if (ym(start) <= t && ym(end) >= t) return 'date:month';
  if (ym(start) === t + 1) return 'date:next_month';
  return null;
}
