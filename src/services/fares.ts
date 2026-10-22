import { addDays, daysBetween, todayISO } from '../lib/dates';
import { COMPARABLE_DEPART_WINDOW_DAYS, fareRequestPlan } from '../lib/fareRequests';
import type { FareData, FareObservation, FareSaved } from '../types';
import { getJson, ServiceError } from './http';
import { getLiveFares, LIVE_SOURCE } from './liveFares';

export interface FareQuery {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  /** Past trips: plan the requests as of this date (the trip's start) and allow past dates. */
  asOf?: string;
}

export interface FareService {
  readonly name: string;
  getFares(q: FareQuery, signal?: AbortSignal): Promise<FareData>;
}


/** Departure-date window and stay-length tolerance for "comparable" trips. */
export { COMPARABLE_DEPART_WINDOW_DAYS };
export function stayTolerance(nights: number): number {
  return Math.max(2, Math.round(nights * 0.3));
}

const SOURCES = [
  { name: 'Travelpayouts / Aviasales Data API', url: 'https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API' },
];

/** Set by the local fare cache when a response came from the database. */
interface Saved {
  saved?: FareSaved;
}

interface V2LatestResponse extends Saved {
  success: boolean;
  error?: string;
  data?: Array<{
    origin: string;
    destination: string;
    depart_date: string;
    return_date?: string;
    number_of_changes?: number;
    value: number;
    found_at?: string;
    trip_class?: number;
  }>;
}

interface V3PricesResponse extends Saved {
  success: boolean;
  error?: string;
  data?: Array<{
    origin: string;
    destination: string;
    price: number;
    airline?: string;
    departure_at: string;
    return_at?: string;
    transfers?: number;
    link?: string;
  }>;
}

const BASE = '/api/fares'; // local fare cache (server/fareCache.ts) → api.travelpayouts.com

function fromV2(rows: V2LatestResponse['data']): FareObservation[] {
  return (rows ?? [])
    .filter((r) => r.return_date && (r.trip_class ?? 0) === 0 && r.value > 0)
    .map((r) => ({
      priceSgd: r.value,
      departDate: r.depart_date.slice(0, 10),
      returnDate: r.return_date!.slice(0, 10),
      foundAt: r.found_at,
      transfers: r.number_of_changes,
      origin: r.origin,
      destination: r.destination,
    }));
}

function nightsOf(o: FareObservation): number | null {
  return o.returnDate ? daysBetween(o.departDate, o.returnDate) : null;
}

/**
 * Travelpayouts serves fares that Aviasales users found recently (cached search
 * results with a found_at timestamp). It is not a multi-year fare archive, and
 * the cached fares are not live, bookable quotes.
 */
export const travelpayoutsFares: FareService = {
  name: 'Travelpayouts (Aviasales cached fares)',
  async getFares(q, signal) {
    const empty: FareData = {
      status: 'ok',
      provider: this.name,
      sources: SOURCES,
      comparable: [],
      routeWide: [],
      exactDates: [],
      hasLiveSearch: false,
      warnings: [],
    };
    if (!q.asOf && q.departDate < todayISO()) {
      return { ...empty, status: 'past-dates', message: 'These travel dates are in the past. Fare caches only cover upcoming departures.' };
    }
    if (!q.destination) {
      return { ...empty, status: 'unavailable', message: 'No destination airport with scheduled flights was found near this place.' };
    }
    const nights = daysBetween(q.departDate, q.returnDate);
    const tol = stayTolerance(nights);
    const comparableStay = (o: FareObservation) => {
      const n = nightsOf(o);
      return n !== null && Math.abs(n - nights) <= tol;
    };
    const winStart = addDays(q.departDate, -COMPARABLE_DEPART_WINDOW_DAYS);
    const winEnd = addDays(q.departDate, COMPARABLE_DEPART_WINDOW_DAYS);
    const plan = fareRequestPlan(q.origin, q.destination, q.departDate, q.returnDate, q.asOf ?? todayISO());

    // Live Google Flights prices run alongside; they never throw.
    const liveP = getLiveFares(q, signal);
    const [monthly, yearly, exact] = await Promise.allSettled([
      Promise.all(plan.monthly.map((p) => getJson<V2LatestResponse>(`${BASE}${p}`, { signal }))),
      getJson<V2LatestResponse>(`${BASE}${plan.yearly}`, { signal }),
      getJson<V3PricesResponse>(`${BASE}${plan.exact}`, { signal }),
    ]);

    const live = await liveP;
    const withLive: FareData = {
      ...empty,
      sources: live.status === 'not-configured' ? SOURCES : [...SOURCES, LIVE_SOURCE],
      hasLiveSearch: live.status === 'ok',
      live,
    };

    const failures = [monthly, yearly, exact].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // With every cached-fare request failed, carry on only if live prices came back.
    if (failures.length === 3 && live.cheapestTotal === null) {
      const err = failures[0].reason as ServiceError;
      // Past trips only read the fare archive: nothing there means nothing was saved before the trip.
      if (q.asOf && err.status === 404) {
        return { ...withLive, status: 'unavailable', message: 'No fares were saved for this trip before it started, and past fares can’t be looked up again.' };
      }
      if (err.status === 501) {
        return {
          ...withLive,
          status: 'not-configured',
          message:
            'No airfare provider is configured and no fares have been saved for this search yet. Add a free Travelpayouts API token as TRAVELPAYOUTS_TOKEN (and optionally a SerpApi key as SERPAPI_KEY) in .env.local and restart the dev server.',
        };
      }
      if (err.status === 401 || err.status === 403) {
        return { ...withLive, status: 'error', message: 'The airfare provider rejected the API token (unauthorised). Check TRAVELPAYOUTS_TOKEN.' };
      }
      return { ...withLive, status: 'error', message: `The airfare provider could not be reached: ${err.message}` };
    }

    const warnings: string[] = [];
    if (live.status === 'error') warnings.push(`Live Google Flights prices failed to load: ${live.message}`);
    if (monthly.status === 'rejected') warnings.push(`Comparable-date fares failed to load: ${(monthly.reason as Error).message}`);
    if (yearly.status === 'rejected') warnings.push(`Route-wide fares failed to load: ${(yearly.reason as Error).message}`);
    if (exact.status === 'rejected') warnings.push(`Exact-date fares failed to load: ${(exact.reason as Error).message}`);

    const dedupe = (xs: FareObservation[]) => {
      const seen = new Set<string>();
      return xs.filter((o) => {
        const k = `${o.departDate}|${o.returnDate}|${o.priceSgd}|${o.transfers}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const comparable =
      monthly.status === 'fulfilled'
        ? dedupe(monthly.value.flatMap((r) => fromV2(r.data))).filter(
            (o) => o.departDate >= winStart && o.departDate <= winEnd && comparableStay(o),
          )
        : [];
    const routeWide = yearly.status === 'fulfilled' ? dedupe(fromV2(yearly.value.data)).filter(comparableStay) : [];
    const exactDates =
      exact.status === 'fulfilled'
        ? (exact.value.data ?? [])
            .filter((r) => r.price > 0)
            .map((r) => ({
              priceSgd: r.price,
              departDate: r.departure_at.slice(0, 10),
              returnDate: r.return_at?.slice(0, 10),
              transfers: r.transfers,
              airline: r.airline,
              origin: r.origin,
              destination: r.destination,
              link: r.link ? `https://www.aviasales.com${r.link}` : undefined,
            }))
        : [];

    // Responses served from the database: report the oldest save, and whether any were a
    // fallback because the provider couldn't be used.
    const savedInfo = [
      ...(monthly.status === 'fulfilled' ? monthly.value : []),
      ...(yearly.status === 'fulfilled' ? [yearly.value] : []),
      ...(exact.status === 'fulfilled' ? [exact.value] : []),
    ].flatMap((r) => (r.saved ? [r.saved] : []));
    const saved: FareSaved | undefined = savedInfo.length
      ? { at: Math.min(...savedInfo.map((x) => x.at)), stale: savedInfo.some((x) => x.stale) }
      : undefined;

    const nothing = !comparable.length && !routeWide.length && !exactDates.length && live.cheapestTotal === null;
    return {
      ...withLive,
      status: nothing ? 'unavailable' : 'ok',
      message: nothing
        ? `The provider has no recently observed return fares from ${q.origin} to ${q.destination} for comparable dates. The route may be served by few airlines or rarely searched.`
        : undefined,
      comparable,
      routeWide,
      exactDates,
      warnings,
      saved,
    };
  },
};
