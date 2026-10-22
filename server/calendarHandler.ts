// HTTP routes for holidays and events, served from SQLite:
//
//   /api/cal/holidays?country=TH&start=…&end=…
//   /api/cal/events?country=TH&start=…&end=…
//   /api/cal/china?start=…&end=…                  China public-holiday break periods near the dates
//   /api/cal/trip?country=TH&start=…&end=…        everything the trip view needs in one call
//   /api/cal/status

import type { IncomingMessage, ServerResponse } from 'node:http';
import { archiveRangeOf } from './tripArchive';
import type { CalendarStore, HolidayRow } from './calendar';

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isDate = (s: string | null): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));

export interface HolidayPeriod {
  name: string;
  start: string;
  end: string;
  days: number;
  overlapDays: number;
  tentative: boolean;
}

/** Groups public-holiday days into break periods (consecutive days, weekends included). */
export function holidayPeriods(rows: HolidayRow[], start: string, end: string): HolidayPeriod[] {
  const days = [...new Set(rows.filter((r) => r.kind === 'public' && !/half-day/i.test(r.name)).map((r) => r.date))].sort();
  const isWeekend = (d: string) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  const periods: { start: string; end: string }[] = [];
  for (const d of days) {
    const last = periods[periods.length - 1];
    // Join across a weekend (e.g. a Friday holiday plus Saturday and Sunday).
    let bridge = last ? addDays(last.end, 1) : null;
    while (bridge && bridge < d && isWeekend(bridge)) bridge = addDays(bridge, 1);
    if (last && bridge && d <= bridge) last.end = d;
    else periods.push({ start: d, end: d });
  }
  return periods.map((p) => {
    // Extend each period over adjacent weekend days, which are part of the break.
    let s = p.start;
    let e = p.end;
    while (isWeekend(addDays(s, -1))) s = addDays(s, -1);
    while (isWeekend(addDays(e, 1))) e = addDays(e, 1);
    const inPeriod = rows.filter((r) => r.date >= p.start && r.date <= p.end && r.kind === 'public');
    const name = periodName(inPeriod.map((r) => r.name));
    const os = s > start ? s : start;
    const oe = e < end ? e : end;
    const overlap = os <= oe ? Math.round((Date.parse(oe) - Date.parse(os)) / 86_400_000) + 1 : 0;
    return { name, start: s, end: e, days: Math.round((Date.parse(e) - Date.parse(s)) / 86_400_000) + 1, overlapDays: overlap, tentative: inPeriod.some((r) => r.tentative) };
  });
}

/** "National Day", or "Children's Day / Tomb Sweeping Day" when a break combines holidays. */
function periodName(names: string[]): string {
  const base = names.map((n) =>
    n
      .replace(/\s*\((?:tentative|observed|regional holiday)\)/gi, '')
      .replace(/^(?:Day off for|Joint Holiday for)\s+/i, '')
      .replace(/\s+(?:Golden Week\s+)?holiday(?:\s+day\s*\d+)?$/i, '')
      .replace(/\s+observed$/i, '')
      .trim(),
  );
  const counts = new Map<string, number>();
  base.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([n]) => n);
  // Drop names that merely extend another (e.g. "National Day Golden Week" vs "National Day").
  const distinct = ranked.filter((n, i) => !ranked.slice(0, i).some((m) => n.startsWith(m)));
  return distinct.slice(0, 2).join(' / ') || 'Public holiday';
}

/** China's State Council publishes each year's official break schedule in about November. */
export const CHINA_OFFICIAL_THROUGH = 2026;

export function createCalendarHandler(cal: CalendarStore) {
  const china = async (start: string, end: string) => {
    await cal.ensureHolidays('CN');
    const rows = cal.holidays('CN', addDays(start, -14), addDays(end, 14));
    // Later years come from the lunar calendar until the official schedule is published.
    const periods = holidayPeriods(rows, start, end).map((p) => ({ ...p, tentative: p.tentative || Number(p.start.slice(0, 4)) > CHINA_OFFICIAL_THROUGH }));
    return {
      overlapping: periods.filter((p) => p.overlapDays > 0),
      nearby: periods.filter((p) => p.overlapDays === 0 && p.end >= addDays(start, -3) && p.start <= addDays(end, 3)),
    };
  };

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const m = url.pathname.match(/^\/api\/cal\/(holidays|events|china|trip|status)$/);
    if (!m) return next();
    const q = url.searchParams;
    try {
      if (m[1] === 'status') return send(res, 200, cal.stats());
      const start = q.get('start');
      const end = q.get('end');
      if (!isDate(start) || !isDate(end) || end < start) return send(res, 400, { error: true, reason: 'start and end must be YYYY-MM-DD with end ≥ start' });
      if (m[1] === 'china') return send(res, 200, await china(start, end));

      const cc = (q.get('country') ?? '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) return send(res, 400, { error: true, reason: 'country must be an ISO 3166-1 alpha-2 code' });
      // Past trips (archive header) use the stored calendars without refreshing them.
      const ensure = (c: string) => (archiveRangeOf(req) !== null ? Promise.resolve() : cal.ensureHolidays(c));
      await Promise.all([cc, ...cal.anchorCountries(cc)].map(ensure));

      if (m[1] === 'holidays') return send(res, 200, cal.holidays(cc, start, end));
      if (m[1] === 'events') return send(res, 200, cal.events(cc, start, end));

      // trip: destination holidays and events (± 3 days for context), China and Singapore breaks.
      await ensure('SG');
      const ctxStart = addDays(start, -3);
      const ctxEnd = addDays(end, 3);
      return send(res, 200, {
        country: cc,
        holidays: cal.holidays(cc, ctxStart, ctxEnd),
        periods: holidayPeriods(cal.holidays(cc, addDays(start, -14), addDays(end, 14)), start, end).filter((p) => p.end >= ctxStart && p.start <= ctxEnd),
        events: cal.events(cc, ctxStart, ctxEnd),
        china: await china(start, end),
        singapore: holidayPeriods(cal.holidays('SG', addDays(start, -14), addDays(end, 14)), start, end).filter((p) => p.end >= ctxStart && p.start <= ctxEnd),
        sources: {
          holidays: (cal.holidays(cc, `${start.slice(0, 4)}-01-01`, `${start.slice(0, 4)}-12-31`)[0]?.source) ?? null,
        },
      });
    } catch (e) {
      return send(res, 502, { error: true, reason: (e as Error).message });
    }
  };
}
