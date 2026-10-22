// Saved travel date ranges, stored in the app's SQLite database (/api/saved).

import type { Itinerary, LookoutChange, LookoutState } from '../lib/lookout';
import type { TravelException } from '../lib/travelTime';
import { getJson, ServiceError } from './http';

/** How much weather data for this range is already in the database. */
export interface RangeWeatherProgress {
  places: number;
  placesDone: number;
  years: number;
  forecast: boolean;
  /** Share of place-years stored (moves with each batch). */
  pct?: number;
  state: 'complete' | 'fetching' | 'queued' | 'waiting' | 'past';
  detail: string;
}

export interface SavedRange {
  id: number;
  label: string;
  start: string;
  end: string;
  created_at: number;
  /** When the trip was booked (YYYY-MM-DD), for insurers' advisory-timing rules. */
  booked_on?: string | null;
  weather?: RangeWeatherProgress;
  destinations?: SavedDestination[];
  /** The end date has passed: a read-only past trip (see SavedDates' Past trips). */
  archived?: boolean;
  /** Tickets bought for one of its destinations: watched on Puff's Lookout. */
  booking?: Booking | null;
  /** Puff's Lookout summary for a booked range. */
  lookout?: { unread: number };
}

export interface Booking {
  /** The first stop. */
  destId: number;
  /** When it was marked as booked (ms). */
  at: number;
  /** When Puff's Lookout was last opened (ms). */
  seenAt: number | null;
  /** Stops with nights, and how you travel between them. */
  itinerary: Itinerary;
}

/** Everything Puff's Lookout shows for a booked range (GET /api/saved/:id/lookout). */
export interface LookoutData {
  range: { id: number; label: string; start: string; end: string; booked_on: string | null };
  /** The stops' destinations, in itinerary order. */
  dests: SavedDestination[];
  booking: Booking | null;
  /** The analysis summary seen for each stop when the trip was booked, if any (by destination id). */
  baseline: Record<string, TripSnapshot | null> | null;
  state: LookoutState;
  changes: LookoutChange[];
  eventsConfigured: boolean;
}

/**
 * Books a range with an itinerary, or edits a booked range's itinerary. `prune` removes the
 * saved destinations that aren't stops (their saved fares are archived first).
 */
export function bookRange(id: number, b: { itinerary: Itinerary; booked_on?: string; baseline?: Record<number, TripSnapshot | null>; prune?: boolean }): Promise<{ ok: true; booking: Booking }> {
  return send(`/api/saved/${id}/book`, 'POST', b);
}

/** "Change plans": back to planning. */
export function unbookRange(id: number): Promise<void> {
  return send<void>(`/api/saved/${id}/book`, 'DELETE');
}

export function getLookout(id: number): Promise<LookoutData> {
  return getJson<LookoutData>(`/api/saved/${id}/lookout`, {}, 30_000);
}

export function markLookoutSeen(id: number): Promise<void> {
  return send<void>(`/api/saved/${id}/lookout/seen`, 'POST');
}

/** A small summary of a destination's full analysis, kept so past trips can be shown later. */
export interface TripSnapshot {
  weather: { rating: string; headline: string; confidence?: string; pMostlyDry?: number; pRainMostDays?: number; meanTMax?: number | null } | null;
  fares: { cheapest: number | null; verdict: string | null; savedAt?: number } | null;
  crowds: { level: 'high' | 'medium' | null; notes: string[] };
  advisory: { level: string; coverage: string } | null;
  conclusion: string | null;
  /** When it was saved (ms), set by the server. */
  at?: number;
}

export const MAX_SAVED_RANGE_DAYS = 92;

export function listSavedRanges(): Promise<SavedRange[]> {
  return getJson<SavedRange[]>('/api/saved');
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = (await res.json().catch(() => ({}))) as T & { reason?: string };
  if (!res.ok) throw new ServiceError(data.reason ?? `HTTP ${res.status}`, res.status);
  return data;
}

export function saveRange(r: { label: string; start: string; end: string; booked_on?: string | null }): Promise<SavedRange> {
  return send<SavedRange>('/api/saved', 'POST', r);
}

export function updateSavedRange(id: number, patch: Partial<Pick<SavedRange, 'label' | 'start' | 'end' | 'booked_on'>>): Promise<SavedRange> {
  return send<SavedRange>(`/api/saved/${id}`, 'PATCH', patch);
}

/** Ask the server to fetch this range's weather next. */
export function retrieveNow(id: number): Promise<SavedRange> {
  return send<SavedRange>(`/api/saved/${id}/fetch`, 'POST');
}

export function deleteSavedRange(id: number): Promise<void> {
  return send<void>(`/api/saved/${id}`, 'DELETE');
}

/** A probable destination saved against a range, for side-by-side comparison. */
export interface SavedDestination {
  id: number;
  range_id: number;
  name: string;
  admin1: string | null;
  country: string;
  cc: string;
  lat: number;
  lon: number;
  code: string;
  created_at: number;
  weather?: { pct: number; state: 'complete' | 'fetching' | 'waiting' | 'queued' | 'past'; detail: string };
  /** The last analysis seen while the trip was upcoming. */
  snapshot?: TripSnapshot;
}

/** Save (replace) the analysis summary for a saved destination of an upcoming trip. */
export function putSnapshot(rangeId: number, destId: number, snap: TripSnapshot): Promise<void> {
  return send<void>(`/api/saved/${rangeId}/destinations/${destId}/snapshot`, 'PUT', snap);
}

export function addSavedDestination(
  rangeId: number,
  d: { name: string; admin1?: string; country: string; cc: string; lat: number; lon: number; code: string },
): Promise<SavedDestination> {
  return send<SavedDestination>(`/api/saved/${rangeId}/destinations`, 'POST', d);
}

export function removeSavedDestination(rangeId: number, id: number): Promise<void> {
  return send<void>(`/api/saved/${rangeId}/destinations/${id}`, 'DELETE');
}

export function getTravelExceptions(): Promise<{ exceptions: TravelException[]; defaults: TravelException[] }> {
  return getJson('/api/settings/travel');
}

export function setTravelExceptions(exceptions: TravelException[]): Promise<{ exceptions: TravelException[]; defaults: TravelException[] }> {
  return send('/api/settings/travel', 'PUT', { exceptions });
}
