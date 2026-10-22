// The weather library: places with stored history, and how ready each is for Sunny windows
// (served from the local database, /api/library).

import type { MonthRating } from '../lib/monthRatings';
import { getJson, ServiceError } from './http';

export interface LibraryPlace {
  name: string;
  country: string;
  cc: string;
  lat: number;
  lon: number;
  code: string | null;
  /** Complete years of the ones Sunny windows needs. */
  years: number;
  needed: number;
  firstYear: number | null;
  lastYear: number | null;
  status: 'ready' | 'partial' | 'none';
  saved: boolean;
  queue: 'downloading' | 'queued' | 'waiting' | null;
  /** Position in the background download queue (1 = first), or null for places not on it. */
  priority: number | null;
  /** Reached overland from Singapore (coach, bus or train). */
  overland: boolean;
  /** Typical weather per calendar month (Jan first, Sunny windows scoring); null when nothing is stored. */
  months: (MonthRating | null)[] | null;
}

export interface Library {
  needed: number;
  readyYears: number;
  places: LibraryPlace[];
}

export function getLibrary(): Promise<Library> {
  return getJson<Library>('/api/library', {}, 30_000);
}

/** Queue a place's Sunny windows history for background download. */
export async function requestDownload(p: Pick<LibraryPlace, 'name' | 'country' | 'cc' | 'lat' | 'lon' | 'code'>): Promise<void> {
  const res = await fetch('/api/library/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new ServiceError(data.reason ?? `HTTP ${res.status}`, res.status);
  }
}
