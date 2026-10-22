import { liveFarePath, liveLegPlan } from '../lib/fareRequests';
import { cheapestLiveTotal } from '../lib/flightRules';
import { airportCountries } from './airports';
import { getFlightRules } from './flightRules';
import type { FareSaved, LiveLeg, LiveFares } from '../types';
import { getJson, ServiceError } from './http';
import type { FareQuery } from './fares';

const BASE = '/api/live-fares'; // local fare cache (server/serpapi.ts) → SerpApi Google Flights

export const LIVE_SOURCE = { name: 'SerpApi Google Flights API', url: 'https://serpapi.com/google-flights-api' };

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
interface LiveResponse {
  best_flights?: Option[];
  other_flights?: Option[];
  price_insights?: { lowest_price?: number; price_level?: string; typical_price_range?: number[] } | null;
  google_flights_url?: string | null;
  saved?: FareSaved;
}

function toLeg(o: Option, googleBest: boolean, countries: Map<string, string>): LiveLeg | null {
  const legs = o.flights ?? [];
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!o.price || o.price <= 0 || !first?.departure_airport?.time || !last?.arrival_airport?.time) return null;
  return {
    priceSgd: o.price,
    airlines: [...new Set(legs.map((f) => f.airline).filter((x): x is string => Boolean(x)))],
    logo: first.airline_logo,
    stops: legs.length - 1,
    totalMinutes: o.total_duration ?? legs.reduce((a, f) => a + (f.duration ?? 0), 0),
    departTime: first.departure_airport.time,
    arriveTime: last.arrival_airport.time,
    flightNumbers: legs.map((f) => f.flight_number).filter((x): x is string => Boolean(x)),
    route: [first.departure_airport.id, ...legs.map((f) => f.arrival_airport?.id)].filter((x): x is string => Boolean(x)),
    segments: legs.map((f) => ({
      from: f.departure_airport?.id ?? '',
      to: f.arrival_airport?.id ?? '',
      departTime: f.departure_airport?.time ?? '',
      arriveTime: f.arrival_airport?.time ?? '',
      minutes: f.duration ?? 0,
      airline: f.airline,
      flightNumber: f.flight_number,
      logo: f.airline_logo,
    })),
    layovers: (o.layovers ?? []).map((l) => ({ airport: l.id ?? '', minutes: l.duration ?? 0, overnight: Boolean(l.overnight), country: countries.get(l.id ?? '') })),
    googleBest,
  };
}

const legsOf = (r: LiveResponse, countries: Map<string, string>) =>
  [...(r.best_flights ?? []).map((o) => toLeg(o, true, countries)), ...(r.other_flights ?? []).map((o) => toLeg(o, false, countries))].filter(
    (x): x is LiveLeg => x !== null,
  );

/**
 * Live Google Flights one-way options for the flight rules (src/lib/flightRules.ts): out on the
 * start date, and back on the evening before or on the end date (the day you land in Singapore).
 * Three searches, each saved and reused by the server. Long-haul routes (fastest outbound at least
 * the rules' long-haul time) get a fourth, round-trip search: one-way tickets on long routes often
 * cost far more than half a return, so the non-stop price check uses return-ticket prices.
 * Never throws.
 */
export async function getLiveFares(q: FareQuery, signal?: AbortSignal): Promise<LiveFares> {
  const plan = liveLegPlan(q.origin, q.destination, q.departDate, q.returnDate);
  const get = (path: string) => getJson<LiveResponse>(`${BASE}${path}`, { signal }, 45_000);
  const countriesP = airportCountries().catch(() => new Map<string, string>());
  const rulesP = getFlightRules();
  const [out, ...back] = await Promise.allSettled([get(plan.outbound), ...plan.inbound.map(get)]);
  const countries = await countriesP;
  const ok = [out, ...back].filter((r): r is PromiseFulfilledResult<LiveResponse> => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) {
    const err = (out as PromiseRejectedResult).reason as ServiceError;
    if (err.status === 501) return { status: 'not-configured', outbound: [], inbound: [], cheapestTotal: null, urls: {} };
    return { status: 'error', outbound: [], inbound: [], cheapestTotal: null, urls: {}, message: err.message };
  }
  const outRes = out.status === 'fulfilled' ? out.value : undefined;
  const backRes = back.filter((r): r is PromiseFulfilledResult<LiveResponse> => r.status === 'fulfilled').map((r) => r.value);
  const pi = outRes?.price_insights;
  const range = pi?.typical_price_range;
  const saves = ok.flatMap((r) => (r.saved ? [r.saved] : []));
  const outbound = outRes ? legsOf(outRes, countries) : [];
  const inbound = backRes.flatMap((r) => legsOf(r, countries));

  const fastest = outbound.length ? Math.min(...outbound.map((l) => l.totalMinutes)) : 0;
  let roundTrip: LiveFares['roundTrip'];
  if (fastest >= (await rulesP).longHaulMinutes) {
    try {
      const rt = await get(liveFarePath(q.origin, q.destination, q.departDate, q.returnDate));
      roundTrip = { options: legsOf(rt, countries), url: rt.google_flights_url ?? undefined };
    } catch {
      /* the one-way prices still stand */
    }
  }
  const oneWays = cheapestLiveTotal(outbound, inbound, q.departDate, q.returnDate);
  const rtCheapest = roundTrip?.options.length ? Math.min(...roundTrip.options.map((l) => l.priceSgd)) : null;
  return {
    status: 'ok',
    outbound,
    inbound,
    cheapestTotal: oneWays !== null && rtCheapest !== null ? Math.min(oneWays, rtCheapest) : oneWays ?? rtCheapest,
    insights: pi ? { lowest: pi.lowest_price, level: pi.price_level, typicalRange: range && range.length === 2 ? [range[0], range[1]] : undefined } : undefined,
    urls: { outbound: outRes?.google_flights_url ?? undefined, inbound: backRes.at(-1)?.google_flights_url ?? undefined },
    roundTrip,
    saved: saves.length ? { at: Math.min(...saves.map((s) => s.at)), stale: saves.some((s) => s.stale) } : undefined,
  };
}
