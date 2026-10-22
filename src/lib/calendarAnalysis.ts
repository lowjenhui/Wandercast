// Turns raw holidays and events into what matters for a trip: what overlaps the dates,
// what falls on a weekend, long weekends, and likely crowd / price impact.

import type { CrowdEvent, Holiday, HolidayPeriod, TripCalendar } from '../services/calendar';
import { addDays, parseISODate } from './dates';
import { haversineKm } from './geo';

export const NEARBY_KM = 150;

export function isWeekend(d: string): boolean {
  const day = parseISODate(d).getUTCDay();
  return day === 0 || day === 6;
}

export function datesIn(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): string[] {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return s <= e ? datesIn(s, e) : [];
}

export interface CalendarItem {
  key: string;
  type: 'holiday' | 'event';
  name: string;
  start: string;
  end: string;
  inTrip: boolean;
  /** Trip days overlapping this item that fall on a Saturday or Sunday. */
  weekendDays: string[];
  longWeekend: HolidayPeriod | null;
  impact: 'high' | 'medium' | 'low';
  kindLabel: string;
  /** Where a regional holiday is observed (shown on its own line, not in the chip). */
  regions?: string | null;
  timing?: CrowdEvent['timing'];
  tentative?: boolean;
  place?: string | null;
  distanceKm?: number | null;
  note?: string;
  source?: { name: string; url: string };
}

/** Holidays grouped by name and consecutive dates (multi-day holidays become one item). */
function groupHolidays(holidays: Holiday[]): { name: string; start: string; end: string; kind: Holiday['kind']; regions: string | null; tentative: boolean }[] {
  const out: { name: string; start: string; end: string; kind: Holiday['kind']; regions: string | null; tentative: boolean }[] = [];
  for (const h of [...holidays].sort((a, b) => a.date.localeCompare(b.date))) {
    const prev = out.find((o) => o.name === h.name && addDays(o.end, 1) === h.date);
    if (prev) prev.end = h.date;
    else out.push({ name: h.name, start: h.date, end: h.date, kind: h.kind, regions: h.regions, tentative: Boolean(h.tentative) });
  }
  return out;
}

export function buildCalendarItems(cal: TripCalendar, start: string, end: string, at?: { lat: number; lon: number }): CalendarItem[] {
  const items: CalendarItem[] = [];
  const periodFor = (s: string, e: string) => cal.periods.find((p) => p.start <= e && p.end >= s && p.days >= 3) ?? null;

  for (const h of groupHolidays(cal.holidays.filter((x) => x.kind !== 'observance'))) {
    const days = overlapDays(h.start, h.end, start, end);
    const period = h.kind === 'public' ? periodFor(h.start, h.end) : null;
    items.push({
      key: `h:${h.name}:${h.start}`,
      type: 'holiday',
      name: h.name.replace(/\s*\(regional holiday\)/i, ''),
      start: h.start,
      end: h.end,
      inTrip: days.length > 0,
      weekendDays: days.filter(isWeekend),
      longWeekend: period,
      // A public holiday that makes a 3+ day break triggers domestic travel; single days less so.
      impact: h.kind === 'public' ? (period ? 'medium' : 'low') : 'low',
      kindLabel: h.kind === 'public' ? 'Public holiday' : 'Regional holiday',
      regions: h.kind === 'public' ? null : h.regions,
      tentative: h.tentative,
    });
  }

  for (const ev of cal.events) {
    const days = overlapDays(ev.start, ev.end, start, end);
    const dist = at && ev.lat != null && ev.lon != null ? haversineKm(at.lat, at.lon, ev.lat, ev.lon) : null;
    items.push({
      key: `e:${ev.id}:${ev.start}`,
      type: 'event',
      name: ev.name,
      start: ev.start,
      end: ev.end,
      inTrip: days.length > 0,
      weekendDays: days.filter(isWeekend),
      longWeekend: periodFor(ev.start, ev.end),
      impact: ev.impact,
      kindLabel: ev.category === 'closure' ? 'Closure' : 'Event',
      timing: ev.timing,
      place: ev.place,
      distanceKm: dist,
      note: ev.note,
      source: { name: ev.source_name, url: ev.source_url },
    });
  }
  return items.sort((a, b) => a.start.localeCompare(b.start) || (a.type === 'event' ? -1 : 1));
}

export interface CrowdAlert {
  level: 'high' | 'medium';
  text: string;
}

/** Plain-language alerts for things inside the trip dates that push up prices or crowds. */
/** How a trip crosses into Malaysia by road: only overland, or overland as an option beside a flight. */
export interface OverlandTrip {
  start: string;
  end: string;
  overland: 'only' | 'also';
}

const DOW = (d: string) => parseISODate(d).getUTCDay();

/**
 * Causeway and Second Link congestion for road trips: high when the trip overlaps a Singapore or
 * local public-holiday break of 3+ days, otherwise medium when it leaves or returns at a weekend.
 */
export function causewayAlert(cal: TripCalendar, trip: OverlandTrip): CrowdAlert | null {
  const breaks = [...cal.singapore, ...cal.periods].filter((p) => p.overlapDays > 0 && p.days >= 3);
  const how = trip.overland === 'only' ? '' : ' if you go by road';
  if (breaks.length) {
    const names = [...new Set(breaks.map((p) => p.name))].join(' and ');
    return { level: 'high', text: `Causeway congestion likely${how}: ${names} overlaps your dates, and queues at the Woodlands and Tuas checkpoints can add several hours, especially leaving at the start and returning at the end.` };
  }
  const leaves = [5, 6].includes(DOW(trip.start));
  const returns = [0, 1].includes(DOW(trip.end));
  if (leaves || returns) {
    return { level: 'medium', text: `Weekend crossing${how}: expect checkpoint queues${leaves ? ' leaving on a Friday evening or Saturday morning' : ''}${leaves && returns ? ' and' : ''}${returns ? ' returning on a Sunday or Monday' : ''}.` };
  }
  return null;
}

export function crowdAlerts(cal: TripCalendar, items: CalendarItem[], destinationName: string, trip?: OverlandTrip): CrowdAlert[] {
  const alerts: CrowdAlert[] = [];
  const road = trip ? causewayAlert(cal, trip) : null;
  if (road) alerts.push(road);
  for (const it of items.filter((i) => i.inTrip && i.type === 'event')) {
    const where = it.distanceKm == null || it.distanceKm <= NEARBY_KM ? '' : ` (${it.place}, about ${Math.round(it.distanceKm)} km from ${destinationName})`;
    alerts.push({
      level: it.impact === 'high' && (it.distanceKm == null || it.distanceKm <= NEARBY_KM) ? 'high' : 'medium',
      text: `${it.name}${where}${it.weekendDays.length ? ' falls on your weekend' : ' overlaps your dates'}.`,
    });
  }
  for (const p of cal.periods.filter((x) => x.overlapDays > 0 && x.days >= 3)) {
    alerts.push({ level: 'medium', text: `${p.name} break (${p.days} days) overlaps ${p.overlapDays} of your days: expect domestic travel crowds.` });
  }
  for (const p of cal.china.overlapping) {
    alerts.push({ level: p.days >= 5 ? 'high' : 'medium', text: `China's ${p.name} holiday overlaps your dates: Chinese outbound travel peaks, so fares and hotels across Asia often rise.` });
  }
  for (const p of cal.singapore.filter((x) => x.overlapDays > 0 && x.days >= 3)) {
    if (trip?.overland === 'only') continue; // covered by the causeway alert
    alerts.push({ level: 'medium', text: `Singapore ${p.name} long weekend: departures from Changi are in high demand.` });
  }
  return alerts;
}
