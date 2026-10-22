// Flight rules: rank live one-way options so the suggested flights suit a working traveller
// from Singapore. Times are local to each airport, as Google Flights reports them.
//
// Outbound (start date)
//   - Workday (Mon–Fri, not a Singapore public holiday): leave at 18:00 or later ("After work").
//   - Otherwise, or as the workday fallback: land at the destination 06:00–09:00 ("Early arrival").
// Return (end date = the day you land in Singapore)
//   - Workday: land by 06:00 ("Back before work").
//   - Otherwise: leave the destination at 22:00 or later ("After dinner").
// Stops
//   - Each layover 60 min–2.5 h, not overnight, same airport; at most 3 h longer than non-stop.
//   - Trips of 4 days or fewer: a connection only if it's ≥20% cheaper than non-stop.
//   - Japan: a short connection priced at or below non-stop ranks equal to non-stop.
//   - Middle East (on by default): connections through airports in MIDDLE_EAST are left out.
//     Non-stop flights can't be checked for the route they fly over.
// Long-haul (fastest outbound 10 h or more, e.g. London)
//   - Non-stop first, unless it costs 40% or 400 more (whichever is less) than the cheapest
//     acceptable connection; then it's kept but ranked after the connections, with the difference.
//     Return-ticket prices (the long-haul round-trip search) are used for this when available.
//   - Connections Google lists among its best flights are kept whatever their layovers.
//   - Returns landing on a workday can't land by 06:00 from that far, so they're ranked by the
//     latest departure that still lands on the end date (plan the end date as a leave day).
// Ranking: rule fit, then non-stop, then hours at the destination (in 2-hour steps, so 40 minutes
// more on a Friday night doesn't beat a much cheaper flight), then price.
// Red-eyes (in the air 01:00–05:00, departure-city time) are flagged, not ranked lower.
// Flexible dates: cached fares ±1 day that are ≥15% and ≥50 cheaper are suggested.

import { formatPrice } from './currency';
import { daysBetween } from './dates';
import type { FareObservation, LiveLeg } from '../types';

export interface FlightRules {
  /** "HH:MM" local times. */
  eveningDepartFrom: string;
  morningArriveFrom: string;
  morningArriveTo: string;
  workdayLandBy: string;
  lateReturnFrom: string;
  shortTripDays: number;
  connectionCheaperPct: number;
  layoverMinMinutes: number;
  layoverMaxMinutes: number;
  maxExtraMinutes: number;
  flexCheaperPct: number;
  flexCheaperAmount: number;
  avoidMiddleEast: boolean;
  longHaulMinutes: number;
  nonstopPremiumPct: number;
  nonstopPremiumAmount: number;
}

export const DEFAULT_FLIGHT_RULES: FlightRules = {
  eveningDepartFrom: '18:00',
  morningArriveFrom: '06:00',
  morningArriveTo: '09:00',
  workdayLandBy: '06:00',
  lateReturnFrom: '22:00',
  shortTripDays: 4,
  connectionCheaperPct: 20,
  layoverMinMinutes: 60,
  layoverMaxMinutes: 150,
  maxExtraMinutes: 180,
  flexCheaperPct: 15,
  flexCheaperAmount: 50,
  avoidMiddleEast: true,
  longHaulMinutes: 600,
  nonstopPremiumPct: 40,
  nonstopPremiumAmount: 400,
};

/** Countries whose airports count as Middle East connections (Turkey and Egypt aren't included). */
export const MIDDLE_EAST = new Set(['AE', 'QA', 'BH', 'KW', 'OM', 'SA', 'JO', 'IL', 'LB', 'IR', 'IQ', 'SY', 'YE']);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Rules with every field checked; anything missing or invalid falls back to the default. */
export function normaliseRules(input: Partial<Record<keyof FlightRules, unknown>> | null | undefined): FlightRules {
  const out = { ...DEFAULT_FLIGHT_RULES };
  for (const k of Object.keys(DEFAULT_FLIGHT_RULES) as (keyof FlightRules)[]) {
    const v = input?.[k];
    if (typeof DEFAULT_FLIGHT_RULES[k] === 'boolean') {
      if (typeof v === 'boolean') (out[k] as boolean) = v;
    } else if (typeof DEFAULT_FLIGHT_RULES[k] === 'string') {
      if (typeof v === 'string' && HHMM.test(v)) (out[k] as string) = v;
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2000) {
      (out[k] as number) = Math.round(v);
    }
  }
  return out;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minutes after midnight of "YYYY-MM-DD HH:MM". */
export const timeOfDay = (t: string) => minutesOf(t.slice(11, 16));
export const dateOf = (t: string) => t.slice(0, 10);
/** Minutes since the epoch, treating the local time as UTC (only differences in one zone matter). */
const stamp = (t: string) => Date.parse(`${t.slice(0, 10)}T${t.slice(11, 16)}:00Z`) / 60_000;

/** Mon–Fri and not a Singapore public holiday. */
export function isWorkday(date: string, sgHolidays: ReadonlySet<string>): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5 && !sgHolidays.has(date);
}

/** In the air at any point 01:00–05:00, in each flight's departure-city time. */
export function isRedEye(leg: LiveLeg): boolean {
  return leg.segments.some((s) => {
    const from = timeOfDay(s.departTime);
    const to = from + s.minutes;
    return [60, 24 * 60 + 60].some((night) => from < night + 240 && to > night);
  });
}

export type Fit = 'good' | 'ok' | 'poor';

export interface RankedLeg {
  leg: LiveLeg;
  /** 0 = fits the rules, 1 = fallback, 2 = needs leave. */
  tier: number;
  label: string;
  fit: Fit;
  /** Why it's ranked after the others in its group (a connection, or a pricey long-haul non-stop). */
  deprioritised?: string;
  /** Extra information shown with it, e.g. "Google pick". */
  note?: string;
  redEye: boolean;
  /** Why it's left out of the suggestions, if it is. */
  hidden?: string;
}

export interface LegContext {
  /** Start date (outbound) or end date, the day you land in Singapore (return). */
  date: string;
  workday: boolean;
  tripDays: number;
  japan: boolean;
  /** Fastest outbound at least the long-haul time (isLongHaul). */
  longHaul: boolean;
  /** Return-ticket options to judge the long-haul non-stop price with, when there are any. */
  priceRef?: LiveLeg[];
}

/** The route's fastest outbound takes at least the long-haul time. */
export const isLongHaul = (outbound: LiveLeg[], r: FlightRules) => outbound.length > 0 && Math.min(...outbound.map((l) => l.totalMinutes)) >= r.longHaulMinutes;

const viaMiddleEast = (leg: LiveLeg) => leg.layovers.find((l) => l.country && MIDDLE_EAST.has(l.country));

const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function classifyOutbound(leg: LiveLeg, ctx: LegContext, r: FlightRules): Pick<RankedLeg, 'tier' | 'label' | 'fit'> {
  const dep = timeOfDay(leg.departTime);
  const arr = timeOfDay(leg.arriveTime);
  const early = dateOf(leg.arriveTime) === ctx.date && arr >= minutesOf(r.morningArriveFrom) && arr <= minutesOf(r.morningArriveTo);
  if (ctx.workday && dateOf(leg.departTime) === ctx.date && dep >= minutesOf(r.eveningDepartFrom)) return { tier: 0, label: 'After work', fit: 'good' };
  if (early) return ctx.workday ? { tier: 1, label: 'Early arrival · needs leave', fit: 'ok' } : { tier: 0, label: 'Early arrival', fit: 'good' };
  return ctx.workday
    ? { tier: 2, label: 'Daytime · needs leave', fit: 'poor' }
    : { tier: 1, label: `Lands ${fmt(arr)}`, fit: 'ok' };
}

function classifyReturn(leg: LiveLeg, ctx: LegContext, r: FlightRules): Pick<RankedLeg, 'tier' | 'label' | 'fit'> {
  const dep = timeOfDay(leg.departTime);
  const arr = timeOfDay(leg.arriveTime);
  // Long-haul can't land before work: the latest departure landing on the end date ranks first.
  if (ctx.workday && ctx.longHaul) return { tier: 0, label: `Lands ${fmt(arr)} · plan a leave day`, fit: 'ok' };
  if (ctx.workday) {
    return arr <= minutesOf(r.workdayLandBy)
      ? { tier: 0, label: 'Back before work', fit: 'good' }
      : { tier: 2, label: `Lands ${fmt(arr)} · needs leave`, fit: 'poor' };
  }
  // After dinner: 22:00 or later the evening before, or just after midnight.
  const late = dep >= minutesOf(r.lateReturnFrom) || dep < 5 * 60;
  return late ? { tier: 0, label: 'After dinner', fit: 'good' } : { tier: 1, label: `Leaves ${fmt(dep)}`, fit: 'ok' };
}

/** Why a connection breaks the layover limits, or null when it's within them. */
function connectionProblem(leg: LiveLeg, fastestMinutes: number, r: FlightRules): string | null {
  for (let i = 0; i + 1 < leg.segments.length; i++) {
    if (leg.segments[i].to && leg.segments[i + 1].from && leg.segments[i].to !== leg.segments[i + 1].from) {
      return `changes airport in ${leg.segments[i].to}`;
    }
  }
  for (const l of leg.layovers) {
    if (l.overnight) return `overnight layover in ${l.airport}`;
    if (l.minutes < r.layoverMinMinutes) return `${l.minutes} min layover in ${l.airport} is too tight`;
    if (l.minutes > r.layoverMaxMinutes) return `${Math.round(l.minutes / 6) / 10} h layover in ${l.airport} is too long`;
  }
  if (leg.totalMinutes > fastestMinutes + r.maxExtraMinutes) return `takes over ${Math.round(r.maxExtraMinutes / 60)} h longer than the fastest flight`;
  return null;
}

/** Why a connection is left out (Middle East, layover limits), or null when it's acceptable. */
function excluded(leg: LiveLeg, fastest: number, ctx: LegContext, r: FlightRules): string | null {
  const me = r.avoidMiddleEast ? viaMiddleEast(leg) : undefined;
  if (me) return `Connects in ${me.airport} (Middle East)`;
  if (leg.stops === 0) return null;
  if (ctx.longHaul && leg.googleBest) return null; // Google's own pick, layover and all
  const problem = connectionProblem(leg, fastest, r);
  return problem ? `Connection ${problem}` : null;
}

/** How much more the cheapest non-stop costs than the cheapest acceptable connection, or null. */
function nonstopPremium(options: LiveLeg[], ctx: LegContext, r: FlightRules): number | null {
  const nonstop = options.filter((l) => l.stops === 0);
  const fastest = Math.min(...(nonstop.length ? nonstop : options).map((l) => l.totalMinutes));
  const conns = options.filter((l) => l.stops > 0 && !excluded(l, fastest, ctx, r));
  if (!nonstop.length || !conns.length) return null;
  const ns = Math.min(...nonstop.map((l) => l.priceSgd));
  const cn = Math.min(...conns.map((l) => l.priceSgd));
  return ns - cn >= Math.min((cn * r.nonstopPremiumPct) / 100, r.nonstopPremiumAmount) ? ns - cn : null;
}

/** Rank one direction's options by the flight rules. Hidden options sort last. */
export function rankLegs(legs: LiveLeg[], kind: 'outbound' | 'return', ctx: LegContext, r: FlightRules): RankedLeg[] {
  // Returns must land in Singapore on the end date.
  const usable = kind === 'return' ? legs.filter((l) => dateOf(l.arriveTime) === ctx.date) : legs.filter((l) => dateOf(l.departTime) === ctx.date);
  const nonstop = usable.filter((l) => l.stops === 0);
  const fastest = Math.min(...(nonstop.length ? nonstop : usable).map((l) => l.totalMinutes));
  const cheapestNonstop = nonstop.length ? Math.min(...nonstop.map((l) => l.priceSgd)) : null;
  const short = ctx.tripDays <= r.shortTripDays;
  // Long-haul: is the non-stop "very expensive"? Return-ticket prices when there are any.
  const premium = ctx.longHaul ? nonstopPremium(ctx.priceRef?.length ? ctx.priceRef : usable, ctx, r) : null;

  const ranked = usable.map((leg): RankedLeg => {
    const base = kind === 'outbound' ? classifyOutbound(leg, ctx, r) : classifyReturn(leg, ctx, r);
    const out: RankedLeg = { leg, ...base, redEye: isRedEye(leg), note: leg.stops > 0 && ctx.longHaul && leg.googleBest ? 'Google pick' : undefined };
    const why = excluded(leg, fastest, ctx, r);
    if (why) return { ...out, hidden: why };
    if (leg.stops === 0) {
      return premium !== null ? { ...out, deprioritised: `Non-stop costs about ${formatPrice(premium)} more than the best connection` } : out;
    }
    if (ctx.longHaul) return premium !== null ? out : { ...out, deprioritised: 'Connection: non-stop preferred on long-haul' };
    const atOrBelowNonstop = cheapestNonstop === null || leg.priceSgd <= cheapestNonstop;
    if (ctx.japan && atOrBelowNonstop) return out; // a short, well-priced connection to Japan ranks with non-stop
    if (short && !ctx.japan && cheapestNonstop !== null && leg.priceSgd > cheapestNonstop * (1 - r.connectionCheaperPct / 100)) {
      return { ...out, hidden: `Non-stop preferred for a ${ctx.tripDays}-day trip (connection isn't ${r.connectionCheaperPct}% cheaper)` };
    }
    return { ...out, deprioritised: 'Connection: ranked after non-stop' };
  });

  // More hours at the destination: arrive earlier (outbound) or leave later (return), in 2-hour steps.
  const hourKey = (l: LiveLeg) => Math.floor((kind === 'outbound' ? stamp(l.arriveTime) : -stamp(l.departTime)) / 120);
  return ranked.sort(
    (a, b) =>
      Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)) ||
      a.tier - b.tier ||
      Number(Boolean(a.deprioritised)) - Number(Boolean(b.deprioritised)) ||
      hourKey(a.leg) - hourKey(b.leg) ||
      a.leg.priceSgd - b.leg.priceSgd,
  );
}

/** Hours between landing at the destination and leaving it (both in destination time). */
export function hoursAtDestination(outbound: LiveLeg, back: LiveLeg): number {
  return Math.max(0, (stamp(back.departTime) - stamp(outbound.arriveTime)) / 60);
}

/** Cheapest outbound plus cheapest return landing on the end date, ignoring the time rules. */
export function cheapestLiveTotal(outbound: LiveLeg[], inbound: LiveLeg[], startDate: string, endDate: string): number | null {
  const o = outbound.filter((l) => dateOf(l.departTime) === startDate).map((l) => l.priceSgd);
  const b = inbound.filter((l) => dateOf(l.arriveTime) === endDate).map((l) => l.priceSgd);
  return o.length && b.length ? Math.min(...o) + Math.min(...b) : null;
}

export interface FlexSuggestion {
  departDate: string;
  returnDate: string;
  priceSgd: number;
  savings: number;
  /** Cached fare (Travelpayouts), not a live price. */
  source: 'cached';
}

/**
 * Date pairs within ±1 day of the trip whose cached fares are significantly cheaper than the
 * reference (the cheapest cached exact-date fare, else the cheapest live total). At most two.
 */
export function flexSuggestions(observations: FareObservation[], startDate: string, endDate: string, reference: number | null, r: FlightRules): FlexSuggestion[] {
  if (reference === null) return [];
  const best = new Map<string, FareObservation>();
  for (const o of observations) {
    if (!o.returnDate) continue;
    if (Math.abs(daysBetween(startDate, o.departDate)) > 1 || Math.abs(daysBetween(endDate, o.returnDate)) > 1) continue;
    if (o.departDate === startDate && o.returnDate === endDate) continue;
    if (o.returnDate <= o.departDate) continue;
    const k = `${o.departDate}|${o.returnDate}`;
    if (!best.has(k) || best.get(k)!.priceSgd > o.priceSgd) best.set(k, o);
  }
  return [...best.values()]
    .map((o) => ({ departDate: o.departDate, returnDate: o.returnDate!, priceSgd: o.priceSgd, savings: reference - o.priceSgd, source: 'cached' as const }))
    .filter((s) => s.savings >= r.flexCheaperAmount && s.savings >= (reference * r.flexCheaperPct) / 100)
    .sort((a, b) => a.priceSgd - b.priceSgd)
    .slice(0, 2);
}
