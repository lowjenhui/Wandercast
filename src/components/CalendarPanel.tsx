import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildCalendarItems, crowdAlerts, datesIn, isWeekend, NEARBY_KM, type CalendarItem } from '../lib/calendarAnalysis';
import { formatDate, formatShortDate, parseISODate } from '../lib/dates';
import { getChinaOverlap, getTripCalendar, HOLIDAY_SOURCES, type ChinaOverlap, type HolidayPeriod, type TripCalendar } from '../services/calendar';
import type { Place } from '../types';
import { Badge, Notice } from './ui';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (d: string) => DAY[parseISODate(d).getUTCDay()];
const range = (s: string, e: string) => (s === e ? `${dow(s)} ${formatShortDate(s)}` : `${dow(s)} ${formatShortDate(s)} – ${dow(e)} ${formatShortDate(e)}`);

const TIMING_LABEL: Record<string, string> = {
  fixed: 'Fixed dates',
  'holiday-linked': 'Linked to public holiday',
  typical: 'Typical timing, confirm locally',
  astronomical: 'Lunar date, ±1 day',
};

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; value: T };

/** Shared loader so the summary and the panel use one request. */
export function useTripCalendar(country: string | undefined, start: string, end: string): Load<TripCalendar> | null {
  const [s, setS] = useState<Load<TripCalendar> | null>(null);
  useEffect(() => {
    if (!country || !start || !end || end < start) {
      setS(null);
      return;
    }
    let alive = true;
    setS({ state: 'loading' });
    getTripCalendar(country, start, end)
      .then((value) => alive && setS({ state: 'done', value }))
      .catch((e: Error) => alive && setS({ state: 'error', message: e.message }));
    return () => {
      alive = false;
    };
  }, [country, start, end]);
  return s;
}

/** Home page: do the dates coincide with a China public holiday break? */
export function ChinaHolidayBanner({ start, end }: { start: string; end: string }) {
  const [data, setData] = useState<ChinaOverlap | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!start || !end || end < start) return;
    let alive = true;
    setData(null);
    getChinaOverlap(start, end)
      .then((d) => alive && (setData(d), setError(false)))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [start, end]);

  if (error) return <p className="small muted">China public holiday check unavailable (holiday database not reachable).</p>;
  if (!data) return null;
  const provisional = [...data.overlapping, ...data.nearby].some((p) => p.tentative);
  if (data.overlapping.length) {
    return (
      <Notice kind="warn" title={`Your dates coincide with China's ${data.overlapping.map((p) => p.name).join(' and ')} holiday`}>
        {data.overlapping.map((p) => (
          <p key={p.start} className="small">
            <strong>{p.name}</strong>: {range(p.start, p.end)} ({p.days}-day break, {p.overlapDays} day{p.overlapDays === 1 ? '' : 's'} overlap your trip){p.tentative ? ' · provisional' : ''}
          </p>
        ))}
        <p className="small secondary">
          Chinese outbound travel peaks during these breaks. Fares, hotel rates and crowds usually rise across popular Asian destinations, especially Thailand, Japan, Korea, Singapore, Malaysia and Bali.
          {provisional ? ' Dates after 2026 are provisional until the State Council publishes the official schedule (usually in November).' : ''}
        </p>
      </Notice>
    );
  }
  return (
    <p className="small muted">
      <Badge tone="good">No China holiday</Badge>{' '}
      Your dates don't overlap a China public holiday break.
      {data.nearby.length > 0 && ` Close by: ${data.nearby.map((p) => `${p.name} (${range(p.start, p.end)})`).join('; ')}.`}
    </p>
  );
}

/**
 * Public holidays and crowd-drawing events for the destination country around the dates.
 * `preview` is the compact list under the search form; `full` is the analysis section.
 */
export function CalendarPanel({
  place,
  start,
  end,
  variant,
  data,
  overland,
  headExtra,
  extraRows,
}: {
  place: Place;
  start: string;
  end: string;
  variant: 'preview' | 'full';
  data: Load<TripCalendar> | null;
  /** Reached by road (only, or as an option): adds causeway congestion alerts. */
  overland?: 'only' | 'also';
  /** Shown under the heading (Puff's Lookout: tabs for each stop). */
  headExtra?: ReactNode;
  /** More rows after the holidays and events (Puff's Lookout: events found on Google Events). */
  extraRows?: ReactNode;
}) {
  const items = useMemo(
    () => (data?.state === 'done' ? buildCalendarItems(data.value, start, end, { lat: place.latitude, lon: place.longitude }) : []),
    [data, start, end, place.latitude, place.longitude],
  );
  const alerts = useMemo(
    () => (data?.state === 'done' ? crowdAlerts(data.value, items, place.name, overland ? { start, end, overland } : undefined) : []),
    [data, items, place.name, overland, start, end],
  );
  const [showAll, setShowAll] = useState(false);

  const Wrapper = variant === 'full' ? 'section' : 'div';
  const title = variant === 'full' ? 'Crowds & celebrations' : `Crowds & celebrations in ${place.country}`;

  if (!data) return null;
  if (data.state === 'loading') {
    return (
      <Wrapper className={variant === 'full' ? 'card' : 'notice'} aria-busy="true">
        {variant === 'full' ? <h2>{title}</h2> : <strong>{title}</strong>}
        <p className="small muted">Loading public holidays and events…</p>
      </Wrapper>
    );
  }
  if (data.state === 'error') {
    return (
      <Wrapper className={variant === 'full' ? 'card' : 'notice'}>
        {variant === 'full' ? <h2>{title}</h2> : <strong>{title}</strong>}
        <p className="small error-text">Holiday and event data could not be loaded: {data.message}</p>
      </Wrapper>
    );
  }

  const cal = data.value;
  const inTrip = items.filter((i) => i.inTrip);
  const around = items.filter((i) => !i.inTrip);
  const weekends = datesIn(start, end).filter(isWeekend);
  const list = variant === 'preview' && !showAll ? inTrip.slice(0, 6) : inTrip;

  return (
    <Wrapper className={variant === 'full' ? 'card' : 'notice'} aria-label={title}>
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          {variant === 'full' ? <h2>{title}</h2> : <strong>{title}</strong>}
          <p className="small muted">
            {place.country}, {formatDate(start)} – {formatDate(end)} · weekends in your trip: {weekends.length ? summariseWeekends(weekends) : 'none'}
          </p>
        </div>
        {alerts.some((a) => a.level === 'high') ? <Badge tone="critical">Likely higher prices</Badge> : alerts.length ? <Badge tone="warning">Some crowding likely</Badge> : <Badge tone="good">No major crowd events</Badge>}
      </div>
      {headExtra}

      {variant === 'full' && alerts.length > 0 && (
        <ul className="plain small">
          {alerts.map((a) => (
            <li key={a.text} className={a.level === 'high' ? 'tone-critical' : 'tone-warning'}>{a.text}</li>
          ))}
        </ul>
      )}

      {inTrip.length === 0 ? (
        !extraRows && <p className="small secondary">No public holidays or listed crowd events in {place.country} during your dates.</p>
      ) : (
        <div className="cal-list">
          {list.map((it) => (
            <CalendarRow key={it.key} it={it} full={variant === 'full'} destination={place.name} />
          ))}
        </div>
      )}
      {extraRows}
      {variant === 'preview' && inTrip.length > 6 && (
        <button type="button" className="small" style={{ justifySelf: 'start' }} onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show fewer' : `Show all ${inTrip.length}`}
        </button>
      )}

      {variant === 'full' && around.length > 0 && (
        <details>
          <summary>Just before or after your trip ({around.length})</summary>
          <div className="cal-list">{around.map((it) => <CalendarRow key={it.key} it={it} full destination={place.name} />)}</div>
        </details>
      )}

      {variant === 'full' && (
        <div className="two-col">
          <PeriodBox
            title="China public holidays"
            subtitle="Peak outbound travel from China pushes up fares and crowds across Asia."
            periods={[...cal.china.overlapping, ...cal.china.nearby]}
            empty="None during or right around your dates."
          />
          <PeriodBox
            title="Singapore public holidays (departure side)"
            subtitle="Long weekends in Singapore fill outbound flights from Changi."
            periods={cal.singapore}
            empty="No Singapore public holidays around your dates."
          />
        </div>
      )}

      <p className="small muted">
        Holidays: {cal.sources.holidays ?? 'holiday calendar'}. Events: curated recurring events with crowd and price impact; dates follow each event’s usual rule, so confirm with
        organisers. Sources:{' '}
        {HOLIDAY_SOURCES.map((s, i) => (
          <span key={s.url}>{i > 0 && ' · '}<a href={s.url} target="_blank" rel="noreferrer">{s.name}</a></span>
        ))}
        .
      </p>
    </Wrapper>
  );
}

function summariseWeekends(days: string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const next = days[i + 1];
    if (dow(d) === 'Sat' && next && dow(next) === 'Sun') {
      const [d1, m1] = formatShortDate(d).split(' ');
      const [d2, m2] = formatShortDate(next).split(' ');
      pairs.push(m1 === m2 ? `${d1}–${d2} ${m1}` : `${d1} ${m1} – ${d2} ${m2}`);
      i++;
    } else pairs.push(`${dow(d)} ${formatShortDate(d)}`);
  }
  return pairs.join(', ');
}

export function CalendarRow({ it, full, destination }: { it: CalendarItem; full: boolean; destination: string }) {
  const far = it.distanceKm != null && it.distanceKm > NEARBY_KM;
  return (
    <div className={`cal-row${it.impact === 'high' ? ' high' : ''}`}>
      <div className="cal-date">{range(it.start, it.end)}</div>
      <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <div className="risk-head">
          <strong>{it.name}</strong>
          <Badge tone={it.type === 'holiday' ? 'info' : it.kindLabel === 'Closure' ? 'critical' : 'neutral'}>{it.kindLabel}</Badge>
          {it.type === 'event' && <Badge tone={it.impact === 'high' ? 'critical' : 'warning'}>{it.impact === 'high' ? 'High crowd & price impact' : 'Busy'}</Badge>}
          {it.weekendDays.length > 0 && <Badge tone="serious">On your weekend</Badge>}
          {it.longWeekend && it.type === 'holiday' && <Badge tone="warning">{it.longWeekend.days}-day break</Badge>}
          {it.tentative && <Badge tone="neutral">Tentative</Badge>}
        </div>
        {it.regions && <div className="small secondary">Observed in: {it.regions}</div>}
        {it.type === 'event' && (
          <div className="small secondary">
            {it.place ? `${it.place}${it.distanceKm != null ? (far ? ` · about ${Math.round(it.distanceKm)} km from ${destination}` : ` · near ${destination}`) : ''}` : 'Nationwide'}
            {it.timing ? ` · ${TIMING_LABEL[it.timing]}` : ''}
          </div>
        )}
        {full && it.note && <div className="small secondary">{it.note}</div>}
        {full && it.source && (
          <div className="small"><a href={it.source.url} target="_blank" rel="noreferrer">{it.source.name}</a></div>
        )}
      </div>
    </div>
  );
}

export function PeriodBox({ title, subtitle, periods, empty }: { title: string; subtitle: string; periods: HolidayPeriod[]; empty: string }) {
  return (
    <div className="risk">
      <strong>{title}</strong>
      <span className="small muted">{subtitle}</span>
      {periods.length === 0 ? (
        <span className="small secondary">{empty}</span>
      ) : (
        periods.map((p) => (
          <div key={p.start} className="small">
            <strong>{p.name}</strong>: {range(p.start, p.end)} ({p.days} days){' '}
            {p.overlapDays > 0 ? <Badge tone="warning">{p.overlapDays} day{p.overlapDays === 1 ? '' : 's'} overlap</Badge> : <span className="muted">· just outside your dates</span>}
            {p.tentative && <span className="muted"> · provisional</span>}
          </div>
        ))
      )}
    </div>
  );
}
