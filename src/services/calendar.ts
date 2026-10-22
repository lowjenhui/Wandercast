// Public holidays and crowd events, served by the local SQLite-backed server (/api/cal/*).

import { getJson } from './http';

export interface Holiday {
  country: string;
  date: string;
  name: string;
  kind: 'public' | 'regional' | 'observance';
  regions: string | null;
  tentative: number;
  source: string;
}

export interface HolidayPeriod {
  name: string;
  start: string;
  end: string;
  days: number;
  overlapDays: number;
  tentative: boolean;
}

export interface CrowdEvent {
  id: string;
  name: string;
  country: string;
  start: string;
  end: string;
  place: string | null;
  lat: number | null;
  lon: number | null;
  impact: 'high' | 'medium';
  category: string;
  timing: 'fixed' | 'holiday-linked' | 'typical' | 'astronomical';
  note: string;
  source_name: string;
  source_url: string;
}

export interface ChinaOverlap {
  overlapping: HolidayPeriod[];
  nearby: HolidayPeriod[];
}

export interface TripCalendar {
  country: string;
  holidays: Holiday[];
  periods: HolidayPeriod[];
  events: CrowdEvent[];
  china: ChinaOverlap;
  singapore: HolidayPeriod[];
  sources: { holidays: string | null };
}

const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export function getTripCalendar(country: string, start: string, end: string): Promise<TripCalendar> {
  const q = new URLSearchParams({ country, start, end });
  return cached(`trip|${q}`, () => getJson<TripCalendar>(`/api/cal/trip?${q}`, {}, 45_000));
}

/** Public holiday dates in a country between two dates (inclusive), e.g. Singapore's for workdays. */
export function getPublicHolidayDates(country: string, start: string, end: string): Promise<Set<string>> {
  const q = new URLSearchParams({ country, start, end });
  return cached(`holidays|${q}`, () =>
    getJson<Holiday[]>(`/api/cal/holidays?${q}`, {}, 30_000).then((hs) => new Set(hs.filter((h) => h.kind === 'public').map((h) => h.date))),
  );
}

export function getChinaOverlap(start: string, end: string): Promise<ChinaOverlap> {
  const q = new URLSearchParams({ start, end });
  return cached(`china|${q}`, () => getJson<ChinaOverlap>(`/api/cal/china?${q}`, {}, 30_000));
}

export const HOLIDAY_SOURCES = [
  { name: 'Google Calendar public holidays', url: 'https://support.google.com/calendar/answer/6084659' },
  { name: 'Nager.Date', url: 'https://date.nager.at/' },
  { name: 'China State Council holiday schedule (via China Briefing)', url: 'https://www.china-briefing.com/news/china-2026-public-holiday-schedule/' },
];
