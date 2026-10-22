// How far is reasonable to fly for a trip of a given length ("Balanced" limits): travel should
// take no more than roughly 15–20% of the trip, counting both directions and airport time.
// Exceptions (e.g. Japan from 3D2N) let favourite places through regardless of flight time.

import { daysBetween } from './dates';

export interface LimitTier {
  /** Longest trip (calendar days, inclusive) this tier covers. */
  maxDays: number;
  /** Longest one-way direct flight, in hours; null = any. */
  hours: number | null;
  label: string;
  examples: string;
}

export const LIMIT_TIERS: LimitTier[] = [
  { maxDays: 1, hours: 1.5, label: 'Day trip / 1 night', examples: 'ferry, Kuala Lumpur, Johor' },
  { maxDays: 2, hours: 3, label: '2D1N', examples: 'Kuala Lumpur, Penang, Phuket, Jakarta' },
  { maxDays: 3, hours: 5, label: '3D2N', examples: 'Bangkok, Bali, Ho Chi Minh City, Da Nang, Manila' },
  { maxDays: 5, hours: 6, label: '4–5 days', examples: 'Hong Kong, Taipei, Chiang Mai, Cebu' },
  { maxDays: 9, hours: 8, label: '6–9 days', examples: 'Tokyo, Seoul, Perth, Kathmandu' },
  { maxDays: 14, hours: 13, label: '10–14 days', examples: 'Sydney, Dubai, Maldives, Europe' },
  { maxDays: Infinity, hours: null, label: '15+ days', examples: 'anywhere' },
];

export interface TravelException {
  cc: string;
  city?: string;
  label: string;
  minDays: number;
}

export function tripDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

export function tierFor(days: number): LimitTier {
  return LIMIT_TIERS.find((t) => days <= t.maxDays)!;
}

/** Trip length in the familiar "3D2N" style, or "N days" for longer trips. */
export function durationLabel(days: number): string {
  return days <= 1 ? 'Day trip' : days <= 4 ? `${days}D${days - 1}N` : `${days} days`;
}

export function matchingException(place: { cc: string; name: string }, days: number, exceptions: TravelException[]): TravelException | null {
  return (
    exceptions.find(
      (x) => x.cc === place.cc && (!x.city || x.city.toLowerCase() === place.name.toLowerCase()) && days >= x.minDays,
    ) ?? null
  );
}

export type FitVerdict = { ok: true; reason: 'ferry' | 'within' | 'exception'; exception?: TravelException } | { ok: false; limit: number };

/** Does a place fit the trip length? Ferries always fit; exceptions override the limit. */
export function fitsTrip(place: { cc: string; name: string; hours: number; ferry?: boolean }, days: number, exceptions: TravelException[]): FitVerdict {
  if (place.ferry) return { ok: true, reason: 'ferry' };
  const tier = tierFor(days);
  if (tier.hours === null || place.hours <= tier.hours) return { ok: true, reason: 'within' };
  const ex = matchingException(place, days, exceptions);
  if (ex) return { ok: true, reason: 'exception', exception: ex };
  return { ok: false, limit: tier.hours };
}
