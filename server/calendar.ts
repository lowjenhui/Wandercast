// Public holidays and crowd-drawing events, stored in SQLite for fast lookup.
//
// Holidays: Google's public holiday calendars (ICS, years ~2021–2029, distinguishes public,
// regional and observance days), falling back to Nager.Date. Refreshed every 30 days.
// Events: curated rules (eventsData.ts) expanded into dated rows for the surrounding years.

import type { DB } from './db';
import { EVENTS, type EventDef } from './eventsData';

export interface HolidayRow {
  country: string;
  date: string;
  name: string;
  kind: 'public' | 'regional' | 'observance';
  regions: string | null;
  tentative: number;
  source: string;
}

export interface EventRow {
  id: string;
  name: string;
  country: string;
  start: string;
  end: string;
  place: string | null;
  lat: number | null;
  lon: number | null;
  impact: string;
  category: string;
  timing: string;
  note: string;
  source_name: string;
  source_url: string;
}

const REFRESH_MS = 30 * 24 * 3600_000;

// Older Google calendar IDs for countries whose ISO-coded calendar is empty.
const LEGACY_SLUG: Record<string, string> = {
  TW: 'taiwan', KR: 'south_korea', ID: 'indonesian', VN: 'vietnamese', PH: 'philippines', IN: 'indian', MY: 'malaysia', HK: 'hong_kong',
  SG: 'singapore', JP: 'japanese', CN: 'china', TH: 'th', AU: 'australian', NZ: 'new_zealand', GB: 'uk', US: 'usa', DE: 'german', FR: 'french',
  IT: 'italian', ES: 'spain', NL: 'dutch', CA: 'canadian', BR: 'brazilian', MX: 'mexican', IE: 'irish', AT: 'austrian', DK: 'danish',
  FI: 'finnish', NO: 'norwegian', SE: 'swedish', PL: 'polish', PT: 'portuguese', RU: 'russian', SA: 'saudiarabian', ZA: 'sa', GR: 'greek',
};

export function initCalendarTables(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS holidays (
      country TEXT NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, regions TEXT, tentative INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
      PRIMARY KEY (country, date, name)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS holidays_date ON holidays (country, date);
    CREATE TABLE IF NOT EXISTS holiday_fetch (country TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, name TEXT NOT NULL, country TEXT NOT NULL,
      place TEXT, lat REAL, lon REAL, impact TEXT NOT NULL, category TEXT NOT NULL, timing TEXT NOT NULL,
      note TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL,
      PRIMARY KEY (id, start)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS events_country ON events (country, start);
  `);
}

// ---------------------------------------------------------------- ICS parsing

const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseIcs(text: string): Omit<HolidayRow, 'country' | 'source'>[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const out: Omit<HolidayRow, 'country' | 'source'>[] = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const get = (k: string) => block.match(new RegExp(`\\n${k}[^:\\n]*:(.*)`))?.[1]?.trim();
    const start = get('DTSTART');
    const end = get('DTEND');
    const summary = get('SUMMARY')?.replace(/\\,/g, ',').replace(/\\;/g, ';');
    const desc = (get('DESCRIPTION') ?? '').replace(/\\n/g, '\n').replace(/\\,/g, ',');
    if (!start || !summary || !/^\d{8}/.test(start)) continue;
    const first = desc.split('\n')[0];
    const kind: HolidayRow['kind'] = /^Public holiday in /.test(first) || /regional holiday/i.test(summary) ? 'regional' : /^Public holiday/.test(first) ? 'public' : 'observance';
    const regions = kind === 'regional' ? first.replace(/^Public holiday in /, '').trim() || null : null;
    const tentative = /tentative/i.test(summary) || /Date is tentative|may change/i.test(desc) ? 1 : 0;
    // DTEND is exclusive; most entries are single days.
    const s = ymd(start);
    const e = end && /^\d{8}/.test(end) ? addDays(ymd(end), -1) : s;
    for (let d = s; d <= e; d = addDays(d, 1)) out.push({ date: d, name: summary, kind, regions, tentative });
  }
  return out;
}

// ---------------------------------------------------------------- event expansion

const SYNODIC = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14); // a known new moon

/** Approximate full-moon dates (UTC+8 calendar day) for a year; accurate to about ±1 day. */
export function fullMoons(year: number): string[] {
  const out: string[] = [];
  const startK = Math.floor((Date.UTC(year, 0, 1) - NEW_MOON_REF) / (SYNODIC * 86_400_000)) - 1;
  for (let k = startK; k < startK + 15; k++) {
    const t = NEW_MOON_REF + (k + 0.5) * SYNODIC * 86_400_000 + 8 * 3600_000;
    const d = new Date(t).toISOString().slice(0, 10);
    if (d.startsWith(String(year))) out.push(d);
  }
  return out;
}

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)).toISOString().slice(0, 10);
  }
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, -offset)).toISOString().slice(0, 10);
}

/** Groups sorted dates into runs, allowing a gap of up to `gap` days within a run. */
function clusters(dates: string[], gap = 2): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...new Set(dates)].sort()) {
    const last = out[out.length - 1];
    if (last && d <= addDays(last[1], gap)) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

export function expandEvent(def: EventDef, year: number, holidaysFor: (cc: string) => { date: string; name: string }[]): [string, string][] {
  const r = def.rule;
  const pad = (s: string, e: string, before = 0, after = 0): [string, string] => [addDays(s, -before), addDays(e, after)];
  switch (r.kind) {
    case 'fixed': {
      const s = `${year}-${r.start}`;
      const e = r.end < r.start ? `${year + 1}-${r.end}` : `${year}-${r.end}`;
      return [[s, e]];
    }
    case 'nthWeekday': {
      const d = nthWeekday(year, r.month, r.weekday, r.n);
      return [pad(d, d, r.before, r.after)];
    }
    case 'fullMoon':
      return fullMoons(year)
        .filter((d) => !r.months || r.months.includes(Number(d.slice(5, 7))))
        .map((d) => pad(d, d, r.before, r.after));
    case 'oktoberfest': {
      // Ends on the first Sunday of October, or on 3 October if that is later; runs 16–18 days.
      let end = nthWeekday(year, 10, 0, 1);
      if (end < `${year}-10-03`) end = `${year}-10-03`;
      return [[addDays(nthWeekday(year, 10, 0, 1), -15), end]];
    }
    case 'anchor': {
      const re = new RegExp(r.match, 'i');
      const dates = holidaysFor(r.country)
        .filter((h) => h.date.startsWith(String(year)) && re.test(h.name))
        .map((h) => h.date);
      return clusters(dates).map(([s, e]) => pad(s, e, r.before, r.after));
    }
  }
}

// ---------------------------------------------------------------- store

export class CalendarStore {
  private inflight = new Map<string, Promise<void>>();

  constructor(private db: DB) {
    initCalendarTables(db);
  }

  private holidaysRaw(cc: string) {
    return this.db.prepare("SELECT date, name FROM holidays WHERE country = ? AND kind != 'observance'").all(cc) as { date: string; name: string }[];
  }

  isFresh(cc: string): boolean {
    const row = this.db.prepare('SELECT fetched_at, ok FROM holiday_fetch WHERE country = ?').get(cc) as { fetched_at: number; ok: number } | undefined;
    return Boolean(row && Date.now() - row.fetched_at < (row.ok ? REFRESH_MS : 6 * 3600_000));
  }

  /** Fetch and store a country's holidays if missing or stale (deduplicated per country). */
  ensureHolidays(ccIn: string): Promise<void> {
    const cc = ccIn.toUpperCase();
    if (this.isFresh(cc)) return Promise.resolve();
    const existing = this.inflight.get(cc);
    if (existing) return existing;
    const p = this.fetchHolidays(cc).finally(() => this.inflight.delete(cc));
    this.inflight.set(cc, p);
    return p;
  }

  private async fetchHolidays(cc: string) {
    let rows: Omit<HolidayRow, 'country' | 'source'>[] = [];
    let source = '';
    for (const slug of [cc.toLowerCase(), LEGACY_SLUG[cc]].filter(Boolean)) {
      try {
        const res = await fetch(`https://calendar.google.com/calendar/ical/en.${slug}%23holiday%40group.v.calendar.google.com/public/basic.ics`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) continue;
        rows = parseIcs(await res.text());
        if (rows.length) {
          source = `Google public holiday calendar (en.${slug})`;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!rows.length) {
      // Fallback: Nager.Date (public holidays only), current and next two years.
      const year = new Date().getUTCFullYear();
      for (const y of [year - 1, year, year + 1, year + 2]) {
        try {
          const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/${cc}`, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) continue;
          const list = (await res.json()) as { date: string; name: string; global: boolean; counties: string[] | null }[];
          list.forEach((h) => rows.push({ date: h.date, name: h.name, kind: h.global ? 'public' : 'regional', regions: h.counties?.join(', ') ?? null, tentative: 0 }));
        } catch {
          /* ignore */
        }
      }
      if (rows.length) source = 'Nager.Date public holidays';
    }

    const ins = this.db.prepare('INSERT OR REPLACE INTO holidays (country, date, name, kind, regions, tentative, source) VALUES (?,?,?,?,?,?,?)');
    this.db.exec('BEGIN');
    try {
      if (rows.length) this.db.prepare('DELETE FROM holidays WHERE country = ?').run(cc);
      rows.forEach((r) => ins.run(cc, r.date, r.name, r.kind, r.regions, r.tentative, source));
      this.db.prepare('INSERT OR REPLACE INTO holiday_fetch (country, fetched_at, source, ok) VALUES (?,?,?,?)').run(cc, Date.now(), source || 'none', rows.length ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.rebuildEvents(cc);
  }

  /** Re-expand curated events for a country into the events table (years −1 … +2). */
  rebuildEvents(cc?: string) {
    const year = new Date().getUTCFullYear();
    const defs = EVENTS.filter((e) => !cc || e.cc === cc || (e.rule.kind === 'anchor' && e.rule.country === cc));
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO events (id, start, end, name, country, place, lat, lon, impact, category, timing, note, source_name, source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const def of defs) {
        this.db.prepare('DELETE FROM events WHERE id = ?').run(def.id);
        for (let y = year - 1; y <= year + 2; y++) {
          for (const [s, e] of expandEvent(def, y, (c) => this.holidaysRaw(c))) {
            ins.run(def.id, s, e, def.name, def.cc, def.place ?? null, def.lat ?? null, def.lon ?? null, def.impact, def.category, def.timing, def.note, def.source.name, def.source.url);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  holidays(cc: string, start: string, end: string): HolidayRow[] {
    return this.db.prepare('SELECT * FROM holidays WHERE country = ? AND date BETWEEN ? AND ? ORDER BY date, name').all(cc.toUpperCase(), start, end) as unknown as HolidayRow[];
  }

  events(cc: string, start: string, end: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE country = ? AND start <= ? AND end >= ? ORDER BY start').all(cc.toUpperCase(), end, start) as unknown as EventRow[];
  }

  /** Countries whose events depend on that country's holiday calendar. */
  anchorCountries(cc: string): string[] {
    return [...new Set(EVENTS.filter((e) => e.cc === cc.toUpperCase() && e.rule.kind === 'anchor').map((e) => (e.rule as { country: string }).country))];
  }

  stats() {
    const h = this.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT country) AS c FROM holidays').get() as { n: number; c: number };
    const e = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return { holidayRows: h.n, countries: h.c, eventRows: e.n, eventDefinitions: EVENTS.length };
  }
}
