// Which Travelpayouts requests a fare lookup makes, in one place, so the server's background
// prefetch for saved destinations stores exactly what the Flights section will ask for.
//
//   monthly: cached return fares per month covering the ±21-day comparable departure window
//   yearly:  cached return fares on the route for the whole upcoming year
//   exact:   cheapest cached fares for the exact dates
//   live:    live Google Flights round trips for the exact dates (SerpApi, liveFarePath)
//
// Paths are relative to the Travelpayouts API root (served locally under /api/fares). Every path
// names the fare currency (FARE_CURRENCY, src/lib/currency.ts), so saved fares are kept apart
// per currency.

import { DEFAULT_CURRENCY, FARE_CURRENCY } from './currency';
import { addDays, monthStartsInRange, todayISO } from './dates';

/** Departure-date window for "comparable" trips. */
export const COMPARABLE_DEPART_WINDOW_DAYS = 21;

export interface FareRequestPlan {
  monthly: string[];
  yearly: string;
  exact: string;
}

function v2Latest(origin: string, destination: string, period: { month: string } | 'year', currency: string): string {
  const p = new URLSearchParams({
    origin,
    destination,
    currency: currency.toLowerCase(),
    one_way: 'false',
    show_to_affiliates: 'false',
    trip_class: '0',
    sorting: 'price',
    limit: '1000',
    page: '1',
  });
  if (period === 'year') p.set('period_type', 'year');
  else {
    p.set('period_type', 'month');
    p.set('beginning_of_period', period.month);
  }
  return `/v2/prices/latest?${p}`;
}

export function fareRequestPlan(origin: string, destination: string, departDate: string, returnDate: string, today = todayISO(), currency = FARE_CURRENCY): FareRequestPlan {
  const winStart = addDays(departDate, -COMPARABLE_DEPART_WINDOW_DAYS);
  const winEnd = addDays(departDate, COMPARABLE_DEPART_WINDOW_DAYS);
  const months = monthStartsInRange(winStart < today ? today : winStart, winEnd);
  const exact = new URLSearchParams({
    origin,
    destination,
    departure_at: departDate,
    return_at: returnDate,
    one_way: 'false',
    direct: 'false',
    currency: currency.toLowerCase(),
    sorting: 'price',
    limit: '30',
  });
  return {
    monthly: months.map((m) => v2Latest(origin, destination, { month: m }, currency)),
    yearly: v2Latest(origin, destination, 'year', currency),
    exact: `/aviasales/v3/prices_for_dates?${exact}`,
  };
}

/** Every path in a plan, in the order a prefetch should fill them. */
export const planPaths = (p: FareRequestPlan) => [p.exact, ...p.monthly, p.yearly];

/** Live Google Flights search for the exact dates (served locally under /api/live-fares). The
 *  currency is only named when it isn't SGD, so searches saved before it was configurable still match. */
export function liveFarePath(origin: string, destination: string, departDate: string, returnDate: string, currency = FARE_CURRENCY): string {
  const p = new URLSearchParams({ origin, destination, depart: departDate, return: returnDate });
  if (currency !== DEFAULT_CURRENCY) p.set('currency', currency);
  return `/search?${p}`;
}

/** One-way live Google Flights search for one date (no `return`, so the server asks for type 2). */
export function liveLegPath(origin: string, destination: string, date: string, currency = FARE_CURRENCY): string {
  const p = new URLSearchParams({ origin, destination, depart: date });
  if (currency !== DEFAULT_CURRENCY) p.set('currency', currency);
  return `/search?${p}`;
}

export interface LiveLegPlan {
  outbound: string;
  /** Returns are searched on the evening before the landing day (red-eyes) and the landing day. */
  inbound: string[];
}

/** The one-way searches the flight rules need: out on the start date, back landing on the end date. */
export function liveLegPlan(origin: string, destination: string, startDate: string, endDate: string, currency = FARE_CURRENCY): LiveLegPlan {
  return {
    outbound: liveLegPath(origin, destination, startDate, currency),
    inbound: [liveLegPath(destination, origin, addDays(endDate, -1), currency), liveLegPath(destination, origin, endDate, currency)],
  };
}

export const liveLegPaths = (p: LiveLegPlan) => [p.outbound, ...p.inbound];
