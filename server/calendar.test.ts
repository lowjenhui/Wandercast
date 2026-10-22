import { describe, expect, it } from 'vitest';
import { CalendarStore, expandEvent, fullMoons, parseIcs } from './calendar';
import { holidayPeriods } from './calendarHandler';
import { openDb } from './db';
import { EVENTS } from './eventsData';

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261001
DTEND;VALUE=DATE:20261002
SUMMARY:National Day
DESCRIPTION:Public holiday
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261002
DTEND;VALUE=DATE:20261008
SUMMARY:National Day Holiday
DESCRIPTION:Public holiday
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261018
DTEND;VALUE=DATE:20261019
SUMMARY:Double Ninth Festival
DESCRIPTION:Observance\\nTo hide observances\\, go to Google Calendar Setting
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261010
DTEND;VALUE=DATE:20261011
SUMMARY:Harvest Festival (regional holiday)
DESCRIPTION:Public holiday in Sabah\\, Lab
 uan
END:VEVENT
END:VCALENDAR`;

describe('holiday calendar', () => {
  it('parses ICS days, kinds, folded lines and multi-day entries', () => {
    const rows = parseIcs(ICS);
    expect(rows.filter((r) => r.name === 'National Day Holiday').map((r) => r.date)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(rows.find((r) => r.name.startsWith('Double'))?.kind).toBe('observance');
    const regional = rows.find((r) => r.name.startsWith('Harvest'))!;
    expect(regional.kind).toBe('regional');
    expect(regional.regions).toBe('Sabah, Labuan');
  });

  it('groups public days into break periods including weekends', () => {
    const rows = parseIcs(ICS).map((r) => ({ ...r, country: 'CN', source: 't' }));
    const [p] = holidayPeriods(rows, '2026-10-05', '2026-10-12');
    expect(p).toMatchObject({ name: 'National Day', start: '2026-10-01', end: '2026-10-07', overlapDays: 3 });
  });

  it('computes full moons within a day of known dates', () => {
    const fm = fullMoons(2026);
    expect(fm.length).toBeGreaterThanOrEqual(12);
    // Known full moons (UTC+8): 3 Jan 2026, 24 Nov 2026.
    const near = (d: string) => fm.some((x) => Math.abs(Date.parse(x) - Date.parse(d)) <= 86_400_000);
    expect(near('2026-01-03')).toBe(true);
    expect(near('2026-11-24')).toBe(true);
  });

  it('expands rules: fixed, nth weekday, Oktoberfest and holiday anchors', () => {
    const def = (id: string) => EVENTS.find((e) => e.id === id)!;
    const none = () => [];
    expect(expandEvent(def('th-songkran'), 2027, none)).toEqual([['2027-04-12', '2027-04-16']]);
    expect(expandEvent(def('jp-new-year'), 2026, none)).toEqual([['2026-12-28', '2027-01-03']]);
    expect(expandEvent(def('ph-sinulog'), 2027, none)).toEqual([['2027-01-15', '2027-01-17']]); // 3rd Sunday = 17 Jan
    expect(expandEvent(def('au-melbourne-cup'), 2026, none)).toEqual([['2026-10-31', '2026-11-03']]); // 1st Tue = 3 Nov
    expect(expandEvent(def('de-oktoberfest'), 2026, none)).toEqual([['2026-09-19', '2026-10-04']]);
    const tw = [
      { date: '2027-04-04', name: "Children's Day" },
      { date: '2027-04-05', name: 'Tomb Sweeping Day' },
      { date: '2027-04-06', name: "Day off for Children's Day" },
    ];
    expect(expandEvent(def('tw-spring-scream'), 2027, () => tw)).toEqual([['2027-04-04', '2027-04-06']]);
  });

  it('stores expanded events and returns those overlapping a range', () => {
    const cal = new CalendarStore(openDb(':memory:'));
    cal.rebuildEvents();
    const year = new Date().getUTCFullYear() + 1;
    expect(cal.events('JP', `${year}-05-01`, `${year}-05-02`).map((e) => e.id)).toContain('jp-golden-week');
    expect(cal.events('JP', `${year}-06-01`, `${year}-06-02`)).toHaveLength(0);
  });
});

import { SavedRanges } from './savedRanges';

describe('saved date ranges', () => {
  it('validates, rejects duplicates, edits and deletes', () => {
    const store = new SavedRanges(openDb(':memory:'));
    const a = store.add({ label: 'Year-end break', start: '2026-12-15', end: '2027-01-10' });
    expect(typeof a).toBe('object');
    const id = (a as { id: number }).id;
    expect(store.add({ start: '2027-01-10', end: '2026-12-15' })).toMatch(/on or after/);
    expect(store.add({ start: '2027-01-01', end: '2027-06-01' })).toMatch(/up to 92 days/);
    expect(store.add({ label: 'Again', start: '2026-12-15', end: '2027-01-10' })).toMatch(/already saved as “Year-end break”/);

    // Edit label only, then dates only.
    expect(store.update(id, { label: '  Christmas  ' })).toMatchObject({ label: 'Christmas', start: '2026-12-15' });
    expect(store.update(id, { start: '2026-12-20' })).toMatchObject({ label: 'Christmas', start: '2026-12-20', end: '2027-01-10' });
    expect(store.update(id, { end: '2026-12-01' })).toMatch(/on or after/);
    // Can't edit into another saved range's dates.
    const b = store.add({ label: 'Feb', start: '2027-02-01', end: '2027-02-05' }) as { id: number };
    expect(store.update(b.id, { start: '2026-12-20', end: '2027-01-10' })).toMatch(/already saved/);
    expect(store.update(999, { label: 'x' })).toBeNull();

    expect(store.remove(id)).toBe(true);
    expect(store.list().map((r) => r.label)).toEqual(['Feb']);
  });
});
