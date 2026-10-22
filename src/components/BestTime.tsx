import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  bestTimes,
  HORIZON_DAYS,
  MAX_TRIP_DAYS,
  MIN_TRIP_DAYS,
  monthlyNormals,
  WEEKEND_DEFAULT_MAX_HOURS,
  WEEKENDS,
  type BestTimeResult,
  type WeekendKind,
  type WindowScore,
} from '../lib/bestTime';
import { addDays, daysBetween, formatDate, formatShortDate, monthName, todayISO } from '../lib/dates';
import { haversineKm } from '../lib/geo';
import { estimateFlightHours, RATING_CLASS } from '../lib/outlook';
import type { SuitabilityRating } from '../lib/weatherAnalysis';
import { safetyAt, useAdvisories } from '../services/advisories';
import type { TripCalendar } from '../services/calendar';
import { destinationHours, loadDestinations } from '../services/destinations';
import { services } from '../services';
import { risksThroughYear } from '../services/seasonalRisks';
import type { Place, TripQuery } from '../types';
import { useBestTimeHistory, type BestTimeHistory } from '../useBestTime';
import { aqiBand, aqiTone } from '../lib/lookout';
import { useFxLines } from '../services/fx';
import { getJson, OPEN_METEO } from '../services/http';
import { Mascot, type MascotMood } from './Brand';
import { useTripCalendar } from './CalendarPanel';
import { RainLately } from './RainLately';
import { ThroughTheYear } from './ThroughTheYear';
import { AlertStrip, SafetyCard } from './SafetyCard';
import { Badge, Notice } from './ui';
import { ratingTone } from './WeatherSection';

/** A place to search, with what the trip analysis needs when a window is picked. */
export type WhenTarget = Pick<TripQuery, 'place' | 'destinationCode' | 'destinationLabel' | 'via'>;

/** A crowd, holiday or long-weekend period, and the strip columns whose trip would overlap it. */
interface CrowdMark {
  key: string;
  label: string;
  start: string;
  end: string;
  level: 'high' | 'medium' | 'long';
  /** First and last overlapping column (an index into `result.starts`). */
  from: number;
  to: number;
}

const RATING_ORDER: SuitabilityRating[] = ['Pleasant', 'Generally pleasant', 'Mixed', 'Challenging'];
const ratingKey = (r: SuitabilityRating) => r.toLowerCase().replace(' ', '-');
const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Marks for every period a column's trip overlaps; Singapore long weekends are tagged separately. */
function crowdMarks(cal: TripCalendar, starts: string[], tripDays: number): { crowd: CrowdMark[]; long: CrowdMark[] } {
  const raw: Omit<CrowdMark, 'from' | 'to'>[] = [
    ...cal.events.map((e) => ({ key: `e|${e.id}|${e.start}`, label: e.name, start: e.start, end: e.end, level: e.impact })),
    // Breaks of 3+ days only: single public holidays would clutter the year.
    ...cal.periods.filter((p) => p.days >= 3).map((p) => ({ key: `p|${p.start}`, label: `${p.name} (${cal.country} holiday)`, start: p.start, end: p.end, level: 'medium' as const })),
    ...cal.china.overlapping.filter((p) => p.days >= 3).map((p) => ({ key: `c|${p.start}`, label: `China: ${p.name}${p.tentative ? ' (provisional)' : ''}`, start: p.start, end: p.end, level: 'high' as const })),
    ...cal.singapore.filter((p) => p.days >= 3).map((p) => ({ key: `s|${p.start}`, label: `Singapore long weekend: ${p.name}`, start: p.start, end: p.end, level: 'long' as const })),
  ];
  const seen = new Set<string>();
  const marks = raw
    .filter((m) => !seen.has(m.key) && seen.add(m.key))
    .flatMap((m) => {
      const hits = starts.flatMap((s, i) => (s <= m.end && addDays(s, tripDays - 1) >= m.start ? [i] : []));
      return hits.length ? [{ ...m, from: hits[0], to: hits[hits.length - 1] }] : [];
    })
    .sort((a, b) => a.from - b.from);
  return { crowd: marks.filter((m) => m.level !== 'long'), long: marks.filter((m) => m.level === 'long') };
}

/** Travel time to a place: a known destination's (fastest way), otherwise a direct-flight estimate. */
function useTravelHours(place: Place): number | null {
  const [hours, setHours] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    loadDestinations()
      .then((ds) => {
        const d = ds.find((x) => haversineKm(x.lat, x.lon, place.latitude, place.longitude) < 25);
        if (alive) setHours(d ? destinationHours(d) : estimateFlightHours(place.latitude, place.longitude));
      })
      .catch(() => alive && setHours(estimateFlightHours(place.latitude, place.longitude)));
    return () => {
      alive = false;
    };
  }, [place.latitude, place.longitude]);
  return hours;
}

export function BestTime({
  target,
  tripDays,
  onTripDaysChange,
  onAnalyse,
}: {
  target: WhenTarget;
  tripDays: number;
  onTripDaysChange: (n: number) => void;
  onAnalyse: (start: string, end: string) => void;
}) {
  const { place } = target;
  const history = useBestTimeHistory(place);
  const today = todayISO();
  // One calendar request for the whole horizon, whatever the trip length.
  const calendar = useTripCalendar(place.countryCode || undefined, today, addDays(today, HORIZON_DAYS + MAX_TRIP_DAYS));

  // Weekend mode: on by default for places within a few hours (JB, Batam, KL…), until you choose.
  const hours = useTravelHours(place);
  const [weekend, setWeekend] = useState<WeekendKind | null>(null);
  const [chosen, setChosen] = useState(false);
  useEffect(() => setChosen(false), [place.latitude, place.longitude]);
  useEffect(() => {
    if (!chosen && hours !== null) setWeekend(hours <= WEEKEND_DEFAULT_MAX_HOURS ? 'fri-sun' : null);
  }, [hours, chosen]);
  const pickWeekend = (w: WeekendKind | null) => (setChosen(true), setWeekend(w));

  const result = useMemo(() => {
    if (history.state !== 'done') return null;
    return bestTimes(history.value.daily, {
      tripDays,
      weekend,
      oni: history.value.oni,
      risksFor: (months) => services.risks.risksFor(place, months),
    });
  }, [history, tripDays, weekend, place]);
  // Holidays and events don't depend on the weather, so they show even before (or without) the history.
  const marks = useMemo(() => {
    if (calendar?.state !== 'done') return { crowd: [], long: [] };
    const starts = result?.starts ?? Array.from({ length: HORIZON_DAYS }, (_, i) => addDays(today, i));
    return crowdMarks(calendar.value, starts, result?.tripDays ?? tripDays);
  }, [calendar, result, today, tripDays]);

  const here = { cc: place.countryCode, lat: place.latitude, lon: place.longitude };
  const fx = useFxLines(place.countryCode && place.countryCode !== 'SG' ? [place.countryCode] : []);
  const best = result && !result.flat ? result.best[0] : null;
  const mood: MascotMood = history.state === 'loading' ? 'searching' : history.state === 'error' ? 'sleepy' : !best ? 'happy' : best.rating === 'Challenging' ? 'sleepy' : best.rating === 'Mixed' ? 'searching' : 'happy';

  return (
    <>
      <section className="card lookout-head sunny-head" aria-labelledby="bt-h">
        <div className="lookout-head-row">
          <Mascot mood={mood} size={84} float={history.state === 'loading'} />
          <div className="lookout-hero-text">
            <span className="lookout-kicker">Sunny windows</span>
            <h2 id="bt-h">{place.name}{place.country ? `, ${place.country}` : ''}</h2>
            <span className="secondary">The next 12 months{fx.length ? ` · ${fx.join(' · ')}` : ''}</span>
          </div>
        </div>
        <div className="sunny-trip-row">
          <div className="sunny-trip-group">
            <span className="sunny-trip-label" id="bt-trip-l">Trip</span>
            <div className="layer-toggle" role="group" aria-labelledby="bt-trip-l">
              <button type="button" aria-pressed={!weekend} onClick={() => pickWeekend(null)}>Any days</button>
              <button type="button" aria-pressed={Boolean(weekend)} onClick={() => pickWeekend(weekend ?? 'fri-sun')}>Weekends</button>
            </div>
          </div>
          <div className="sunny-trip-group">
            {weekend ? (
              <>
                <span className="sunny-trip-label" id="bt-len-l">Length</span>
                <div className="layer-toggle" role="group" aria-labelledby="bt-len-l">
                  {(Object.keys(WEEKENDS) as WeekendKind[]).map((k) => (
                    <button key={k} type="button" aria-pressed={weekend === k} onClick={() => pickWeekend(k)} title={WEEKENDS[k].nights}>
                      {WEEKENDS[k].label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <label className="sunny-trip-label" htmlFor="bt-days">Length</label>
                <TripLength id="bt-days" value={tripDays} onChange={onTripDaysChange} />
              </>
            )}
          </div>
        </div>
      </section>

      <SunnySummary result={result} loading={history.state === 'loading'} place={place} />
      <AlertStrip places={[here]} />

      <section className="card best-time" aria-labelledby="bt-best-h">
        <div className="card-head">
          <div style={{ display: 'grid', gap: 4 }}>
            <h2 id="bt-best-h">The best windows</h2>
            <p className="small muted">
              Every possible {weekend ? `${WEEKENDS[weekend].label} weekend` : `${tripDays}-day trip`} over the next 12 months, rated like the trip analysis. ● crowds and higher prices · ★ Singapore long weekends.
            </p>
          </div>
        </div>
        {history.state === 'loading' && (
          <div className="load-line" aria-live="polite">
            <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.round((history.done / history.total) * 100)}%` }} /></div>
            <span className="small muted">
              Reading weather history: {history.done} of {history.total} years. Years not stored yet are downloaded once and kept.
            </span>
          </div>
        )}
        {history.state === 'error' && (
          <Notice kind="err" title="Weather history could not be retrieved">
            <p>{history.message}</p>
            <p className="small muted">The weather provider (Open-Meteo) may be busy or rate-limited. Try again in a minute.</p>
          </Notice>
        )}
        {result && <Results result={result} marks={marks.crowd} longWeekends={marks.long} onAnalyse={onAnalyse} />}
        {calendar?.state === 'error' && <p className="small muted">Holiday and event markers could not be loaded: {calendar.message}</p>}
      </section>

      {history.state === 'done' && <SunnyStory place={place} history={history.value} result={result} />}
      <SunnyCrowds marks={[...marks.crowd, ...marks.long]} calendar={calendar} country={place.country} />

      {result && history.state === 'done' && (
        <div className="small muted bt-notes">
          {history.value.notes.length > 0 && <p>Some years couldn't be retrieved, so scores use fewer years: {history.value.notes.map((n) => n.replace(/\.+$/, '')).join('; ')}.</p>}
          <p>
            Each start date uses the same calendar dates in the last {result.minYears < 10 ? `${result.minYears}–10` : '10'} years, slid ±3 days and weighted toward recent years. It
            is scored like the trip analysis (rain 45%, temperature 35%, humidity 20%, minus seasonal-risk penalties). Crowd markers are shown but don't change
            the score. Data: {history.value.datasetName}.
          </p>
        </div>
      )}
    </>
  );
}

/** − N + days stepper for a trip length (2–30 days). */
export function TripLength({ id, value, onChange }: { id: string; value: number; onChange: (n: number) => void }) {
  const set = (n: number) => onChange(Math.min(MAX_TRIP_DAYS, Math.max(MIN_TRIP_DAYS, n)));
  return (
      <div className="bt-stepper">
        <button type="button" className="icon-button" onClick={() => set(value - 1)} disabled={value <= MIN_TRIP_DAYS} aria-label="One day shorter">−</button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={MIN_TRIP_DAYS}
          max={MAX_TRIP_DAYS}
          value={value}
          onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set(e.target.valueAsNumber)}
        />
        <button type="button" className="icon-button" onClick={() => set(value + 1)} disabled={value >= MAX_TRIP_DAYS} aria-label="One day longer">+</button>
        <span className="small muted">days</span>
      </div>
  );
}

function Results({ result, marks, longWeekends, onAnalyse }: { result: BestTimeResult; marks: CrowdMark[]; longWeekends: CrowdMark[]; onAnalyse: (start: string, end: string) => void }) {
  const { days, best, avoid, flat, starts } = result;
  const scored = days.filter((d): d is WindowScore => d !== null);
  if (!scored.length) {
    return (
      <Notice kind="warn" title="Not enough historical data">
        <p>Fewer than 3 years of usable weather history were available for this place, so no dates can be rated.</p>
      </Notice>
    );
  }
  const at = (m: CrowdMark[], i: number) => m.filter((x) => i >= x.from && i <= x.to);
  const lo = Math.min(...scored.map((d) => d.score));
  const hi = Math.max(...scored.map((d) => d.score));

  return (
    <>
      {flat ? (
        <Notice title={result.flatLabel!}>
          <p className="small">
            Scores stay between {lo} and {hi} all year, so the weather doesn't really pick a season here. Choose dates around other plans; the strip below
            still shows the small differences.
          </p>
        </Notice>
      ) : (
        <ol className="bt-best" aria-label="Best start dates">
          {best.map((w, i) => {
            const col = starts.indexOf(w.start);
            return <BestCard key={w.start} rank={i + 1} w={w} marks={at(marks, col)} longWeekends={at(longWeekends, col)} onAnalyse={onAnalyse} />;
          })}
        </ol>
      )}

      {avoid && (
        <Notice kind="warn" title={`Avoid ${result.weekend ? 'weekends' : 'trips'} starting ${formatShortDate(avoid.from)} – ${formatDate(avoid.to)}`}>
          <p className="small">
            Scores average {Math.round(avoid.meanScore)}/100 here, against {hi} at best.{avoid.reason ? ` ${avoid.reason}` : ''}
          </p>
        </Notice>
      )}

      <YearStrip result={result} marks={marks} longWeekends={longWeekends} onAnalyse={onAnalyse} />
    </>
  );
}

function BestCard({ rank, w, marks, longWeekends, onAnalyse }: { rank: number; w: WindowScore; marks: CrowdMark[]; longWeekends: CrowdMark[]; onAnalyse: (start: string, end: string) => void }) {
  return (
    <li className="bt-card">
      <div className="bt-card-head">
        <span className={`sug-rank ${RATING_CLASS[w.rating]}`}>{rank}</span>
        <div style={{ display: 'grid', minWidth: 0 }}>
          <strong>{formatShortDate(w.start)} – {formatDate(w.end)}</strong>
          <span className="small muted">start {weekday(w.start)}</span>
        </div>
      </div>
      <div className="bt-card-rating">
        <Badge tone={ratingTone[w.rating]}>{w.rating}</Badge>
        <span className="small muted">{w.score}/100</span>
      </div>
      <ul className="plain small bt-facts">
        <li><strong>{pct(w.pMostlyDry)}</strong> chance of a mostly dry trip</li>
        <li>About {w.wetDays.toFixed(1)} wet day{Math.abs(w.wetDays - 1) < 0.05 ? '' : 's'} of {daysBetween(w.start, w.end) + 1}</li>
        <li>Highs near {Math.round(w.tMax ?? 0)} °C, lows {Math.round(w.tMin ?? 0)} °C{w.rh !== null ? `, humidity ${Math.round(w.rh)}%` : ''}</li>
      </ul>
      {(marks.length > 0 || longWeekends.length > 0 || w.risks.some((r) => r.severity !== 'info')) && (
        <ul className="plain small bt-flags">
          {longWeekends.map((m) => <li key={m.key} className="tone-info">★ {m.label}</li>)}
          {w.risks.filter((r) => r.severity !== 'info').map((r) => (
            <li key={r.id} className={r.severity === 'high' ? 'tone-critical' : 'tone-warning'}>{r.title}</li>
          ))}
          {marks.map((m) => (
            <li key={m.key} className={m.level === 'high' ? 'tone-critical' : 'tone-warning'}>● {m.label}</li>
          ))}
        </ul>
      )}
      <button type="button" className="primary small" onClick={() => onAnalyse(w.start, w.end)}>Analyse these dates</button>
    </li>
  );
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];

function YearStrip({ result, marks, longWeekends, onAnalyse }: { result: BestTimeResult; marks: CrowdMark[]; longWeekends: CrowdMark[]; onAnalyse: (start: string, end: string) => void }) {
  const { days, starts, horizonStart, best, avoid, tripDays, weekend } = result;
  const n = days.length;
  const [cursor, setCursor] = useState<number | null>(null);
  const bestIdx = best.map((b) => starts.indexOf(b.start));
  const avoidSpan = avoid ? [starts.indexOf(avoid.from), starts.indexOf(avoid.to)] : null;

  // Month boundaries within the horizon, and each month's best start.
  const months = useMemo(() => {
    const out: { label: string; from: number; to: number; best: WindowScore | null }[] = [];
    starts.forEach((date, i) => {
      const d = days[i];
      // Years on January and on both ends' month (the horizon starts and ends in the same month).
      const yearShown = i === 0 || date.slice(5, 7) === '01' || date.slice(5, 7) === horizonStart.slice(5, 7);
      const label = `${monthName(Number(date.slice(5, 7)))}${yearShown ? ` ${date.slice(2, 4)}` : ''}`;
      const last = out[out.length - 1];
      if (!last || starts[i - 1].slice(0, 7) !== date.slice(0, 7)) out.push({ label, from: i, to: i, best: d });
      else {
        last.to = i;
        if (d && (!last.best || d.score > last.best.score)) last.best = d;
      }
    });
    return out;
  }, [days, starts, horizonStart]);

  const pickIndex = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
  };
  const open = (i: number) => onAnalyse(starts[i], addDays(starts[i], tripDays - 1));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? (weekend ? 4 : 7) : 1;
    if (e.key === 'ArrowRight') setCursor((c) => Math.min(n - 1, (c ?? -1) + step));
    else if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, (c ?? 1) - step));
    else if (e.key === 'Enter' && cursor !== null && days[cursor]) open(cursor);
    else return;
    e.preventDefault();
  };

  const cur = cursor !== null ? days[cursor] : null;
  const curMarks = cursor !== null ? marks.filter((m) => cursor >= m.from && cursor <= m.to) : [];
  const curLong = cursor !== null ? longWeekends.filter((m) => cursor >= m.from && cursor <= m.to) : [];
  const x = (i: number) => (i / n) * 100;

  return (
    <div className="bt-year">
      <div className="panel-head">
        <h3>The year at a glance</h3>
        <span className="small muted">
          {weekend ? `Each column is a ${WEEKENDS[weekend].label} weekend (${WEEKENDS[weekend].nights}).` : `Each column is a ${tripDays}-day trip starting that day.`} Click one to analyse it.
        </span>
      </div>
      <div className="bt-strip-wrap">
        <div className="bt-pins" aria-hidden>
          {bestIdx.map((i, k) => (
            <span key={i} className="bt-pin" style={{ left: `${x(i + 0.5)}%` }}>{k + 1}</span>
          ))}
        </div>
        <svg
          className="bt-strip"
          viewBox={`0 0 ${n} 10`}
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-label={`Weather rating for each ${weekend ? 'weekend' : 'trip start date'} from ${formatDate(horizonStart)}. Use the arrow keys to move and Enter to analyse.`}
          onMouseMove={(e) => setCursor(pickIndex(e))}
          onMouseLeave={() => setCursor(null)}
          onClick={(e) => {
            const i = pickIndex(e);
            if (days[i]) open(i);
          }}
          onKeyDown={onKey}
        >
          {days.map((d, i) => (
            <rect key={i} x={i} y={0} width={weekend ? 0.92 : 1.04} height={10} className={`bt-cell ${d ? ratingKey(d.rating) : 'nodata'}`} />
          ))}
          {cursor !== null && <rect x={cursor} y={0} width={1} height={10} className="bt-cursor" />}
          {months.slice(1).map((m) => (
            <line key={m.from} x1={m.from} x2={m.from} y1={0} y2={10} className="bt-month-line" />
          ))}
        </svg>
        <svg className="bt-crowd" viewBox={`0 0 ${n} 4`} preserveAspectRatio="none" aria-hidden>
          {avoidSpan && avoidSpan[0] >= 0 && <rect x={avoidSpan[0]} y={0} width={avoidSpan[1] - avoidSpan[0] + 1} height={1.2} className="bt-avoid-bar" />}
          {weekend && longWeekends.map((m) => <rect key={m.key} x={m.from} y={1.8} width={m.to - m.from + 1} height={2.2} className="bt-mark long" />)}
          {marks.map((m) => (
            <rect key={m.key} x={m.from} y={1.8} width={m.to - m.from + 1} height={2.2} className={`bt-mark ${m.level}`} />
          ))}
        </svg>
        <div className="bt-months" aria-hidden>
          {months.map((m) => (
            <span key={m.from} style={{ left: `${x(m.from)}%`, width: `${x(m.to - m.from + 1)}%` }}>{(m.to - m.from + 1) / n >= 0.03 ? m.label.split(' ')[0] : ''}</span>
          ))}
        </div>
      </div>

      <p className="small bt-readout" aria-live="polite">
        {cursor === null ? (
          <span className="muted">Hover or use the arrow keys to see a {weekend ? 'weekend' : 'start date'}.</span>
        ) : cur ? (
          <>
            <strong>{formatShortDate(cur.start)} – {formatShortDate(cur.end)}</strong>{' '}
            <Badge tone={ratingTone[cur.rating]}>{cur.rating}</Badge> {cur.score}/100 · {pct(cur.pMostlyDry)} mostly dry · {Math.round(cur.tMax ?? 0)}° / {Math.round(cur.tMin ?? 0)}°
            {curLong.length > 0 && <span className="tone-info"> · ★ {curLong.map((m) => m.label).join(', ')}</span>}
            {curMarks.length > 0 && <span className="tone-warning"> · ● {curMarks.map((m) => m.label).join(', ')}</span>}
          </>
        ) : (
          <span className="muted">{formatShortDate(starts[cursor])}: not enough history to rate.</span>
        )}
      </p>

      <div className="bt-legend small">
        {RATING_ORDER.map((r) => (
          <span key={r} className="legend-chip static"><span className={`bt-swatch ${ratingKey(r)}`} />{r}</span>
        ))}
        {weekend && longWeekends.length > 0 && <span className="legend-chip static"><span className="bt-swatch long" />★ Singapore long weekend</span>}
        {marks.length > 0 && <span className="legend-chip static"><span className="bt-swatch mark" />Holidays & events (trips overlapping them)</span>}
        {avoidSpan && <span className="legend-chip static"><span className="bt-swatch avoid" />Avoid</span>}
      </div>

      <div className="bt-month-list" role="list" aria-label={`Best ${weekend ? 'weekend' : 'start date'} in each month`}>
        {months.filter((m) => m.best).map((m) => (
          <button
            key={m.from}
            type="button"
            role="listitem"
            className="bt-month-btn"
            onClick={() => onAnalyse(m.best!.start, m.best!.end)}
            title={`Best ${weekend ? 'weekend' : 'start'} in ${m.label}: ${formatShortDate(m.best!.start)} (${m.best!.rating}, ${m.best!.score}/100)`}
          >
            <span className={`bt-swatch ${ratingKey(m.best!.rating)}`} />
            <span className="bt-month-name">{m.label}</span>
            <span className="muted">{formatShortDate(m.best!.start)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Nov–Feb" for a run of months (wrapping the year end), or a list when they aren't one run. */
function monthSpan(ms: number[]): string {
  if (ms.length === 12) return 'all year';
  const set = new Set(ms);
  const first = ms.find((m) => !set.has(m === 1 ? 12 : m - 1));
  if (first === undefined) return 'all year';
  const run: number[] = [];
  for (let m = first; set.has(m) && run.length < 12; m = m === 12 ? 1 : m + 1) run.push(m);
  return run.length === ms.length ? (run.length === 1 ? monthName(run[0]) : `${monthName(run[0])}–${monthName(run[run.length - 1])}`) : ms.map(monthName).join(', ');
}

/** The summary row, in the same order as the trip analysis and Puff's Lookout. */
function SunnySummary({ result, loading, place }: { result: BestTimeResult | null; loading: boolean; place: Place }) {
  const { ctx, error } = useAdvisories();
  const here = { cc: place.countryCode, lat: place.latitude, lon: place.longitude };
  const safety = ctx ? safetyAt(ctx, here) : null;
  const air = useAirNow(place.latitude, place.longitude);
  const best = result?.best ?? [];
  const months = [...new Set(best.map((w) => Number(w.start.slice(5, 7))))];
  return (
    <section className="summary" aria-label="Summary">
      <div className="card verdict">
        <span className="label">Weather outlook</span>
        <span className="value">
          {!result ? (
            <Badge tone="neutral">{loading ? 'Loading…' : 'Unavailable'}</Badge>
          ) : result.flat ? (
            <Badge tone="good">{result.flatLabel}</Badge>
          ) : (
            <Badge tone={ratingTone[best[0].rating]}>Best: {monthSpan(months.sort((x, y) => x - y))}</Badge>
          )}
        </span>
        <p className="small secondary">
          {result && !result.flat && best.length > 0 && `Best starts: ${best.map((w) => formatShortDate(w.start)).join(', ')}. `}
          {result?.avoid ? `Avoid ${formatShortDate(result.avoid.from)} – ${formatShortDate(result.avoid.to)}${result.avoid.reason ? `. ${result.avoid.reason.replace(/\.$/, '')}` : ''}.` : result ? 'No stretch to avoid.' : ''}
        </p>
      </div>
      <div className="card verdict">
        <span className="label">Air quality</span>
        <span className="value">
          {air === undefined ? <Badge tone="neutral">Loading…</Badge> : air === null ? <Badge tone="neutral">Unavailable</Badge> : <Badge tone={aqiTone(air)}>{aqiBand(air)}</Badge>}
        </span>
        <p className="small secondary">
          {air != null ? `AQI ${Math.round(air)} right now (US EPA scale, from PM2.5 and PM10). ` : air === null ? 'The current reading couldn’t be loaded. ' : ''}Typical air quality by month comes with the air-quality layer.
        </p>
      </div>
      <SafetyCard ctx={ctx} safety={safety} error={error} places={[here]} />
    </section>
  );
}

/** The AQI right now (PM2.5 and PM10, as aqicn.org headlines), cached for 30 minutes by the server. */
function useAirNow(lat: number, lon: number): number | null | undefined {
  const [aqi, setAqi] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setAqi(undefined);
    const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), current: 'us_aqi_pm2_5,us_aqi_pm10', timezone: 'auto' });
    getJson<{ current?: { us_aqi_pm2_5?: number | null; us_aqi_pm10?: number | null } }>(`${OPEN_METEO.airQuality}?${q}`)
      .then((r) => {
        const a = r.current?.us_aqi_pm2_5;
        const b = r.current?.us_aqi_pm10;
        if (live) setAqi(a == null && b == null ? null : Math.max(a ?? 0, b ?? 0));
      })
      .catch(() => live && setAqi(null));
    return () => {
      live = false;
    };
  }, [lat, lon]);
  return aqi;
}

/** The weather story for the whole year: through the year, seasonal weather, El Niño / La Niña, rain lately. */
function SunnyStory({ place, history, result }: { place: Place; history: BestTimeHistory; result: BestTimeResult | null }) {
  const risks = useMemo(() => risksThroughYear(place), [place]);
  const normals = useMemo(() => monthlyNormals(history.daily), [history.daily]);
  const years = history.daily.length ? `${history.daily[0].date.slice(0, 4)}–${history.daily[history.daily.length - 1].date.slice(0, 4)}` : '';
  const wet = normals.filter((m) => m.wetDays !== null);
  const wettest = [...wet].sort((a, b) => (b.wetDays ?? 0) - (a.wetDays ?? 0)).slice(0, 2).map((m) => m.month).sort((a, b) => a - b);
  const driest = [...wet].sort((a, b) => (a.wetDays ?? 0) - (b.wetDays ?? 0)).slice(0, 2).map((m) => m.month).sort((a, b) => a - b);
  const highs = normals.filter((m) => m.tMax !== null);
  const cool = highs.length ? highs.reduce((a, b) => ((a.tMax ?? 0) < (b.tMax ?? 0) ? a : b)) : null;
  const hot = highs.length ? highs.reduce((a, b) => ((a.tMax ?? 0) > (b.tMax ?? 0) ? a : b)) : null;
  const headline =
    wet.length && cool && hot
      ? `Driest in ${monthSpan(driest)}, wettest in ${monthSpan(wettest)}. Highs range from about ${Math.round(cool.tMax!)} °C in ${monthName(cool.month)} to ${Math.round(hot.tMax!)} °C in ${monthName(hot.month)}.`
      : null;
  const best = result && !result.flat ? result.best[0] : null;
  return (
    <section className="card" aria-labelledby="bt-story-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="bt-story-h">The weather story</h2>
          <p className="small muted">
            {place.name} through the year, from typical weather in {years}. Scores and averages come from past years; this is not a forecast.
          </p>
        </div>
        {best ? <Badge tone={ratingTone[best.rating]}>{best.rating} at best</Badge> : result?.flat ? <Badge tone="good">{result.flatLabel}</Badge> : null}
      </div>
      {headline && <p>{headline}</p>}
      <ThroughTheYear daily={history.daily} lat={place.latitude} lon={place.longitude} timeZone={history.timezone} />
      <div className="two-col">
        <div className="risk">
          <strong>Seasonal weather</strong>
          {risks.length === 0 ? (
            <span className="small muted">No curated seasonal risks for this area. The months above show its typical rain and temperatures.</span>
          ) : (
            <ul className="plain bt-risks">
              {risks.map((r) => (
                <li key={r.id}>
                  <div className="bt-risk-head">
                    <Badge tone={r.severity === 'high' ? 'critical' : r.severity === 'moderate' ? 'warning' : 'info'}>{monthSpan(r.months)}</Badge>
                    <strong className="small">{r.title}</strong>
                  </div>
                  <p className="small secondary">
                    {r.description}
                    {r.peakMonths.length > 0 && ` Peak: ${monthSpan(r.peakMonths)}.`}{' '}
                    <a href={r.source.url} target="_blank" rel="noreferrer">{r.source.name}</a>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="risk">
          <strong>El Niño / La Niña</strong>
          <span className="small secondary">{result?.ensoNote ?? 'No current El Niño or La Niña signal affects these scores.'}</span>
          {history.ensoSource && (
            <span className="small">
              Source: <a href={history.ensoSource.url} target="_blank" rel="noreferrer">{history.ensoSource.name}</a>
            </span>
          )}
        </div>
      </div>
      <RainLately embedded places={[{ key: 'place', name: place.name, lat: place.latitude, lon: place.longitude }]} />
    </section>
  );
}

/** Crowds & celebrations for the next 12 months, full width, in the trip analysis's row style. */
function SunnyCrowds({ marks, calendar, country }: { marks: CrowdMark[]; calendar: ReturnType<typeof useTripCalendar>; country: string }) {
  const byMonth = useMemo(() => {
    const groups = new Map<string, CrowdMark[]>();
    [...marks].sort((a, b) => (a.start < b.start ? -1 : 1)).forEach((m) => {
      const k = m.start.slice(0, 7);
      groups.set(k, [...(groups.get(k) ?? []), m]);
    });
    return [...groups.entries()];
  }, [marks]);
  const cal = calendar?.state === 'done' ? calendar.value : null;
  const high = marks.filter((m) => m.level === 'high').length;
  return (
    <section className="card" aria-labelledby="bt-crowds-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="bt-crowds-h">Crowds &amp; celebrations</h2>
          <p className="small muted">
            {country ? `${country}, ` : ''}the next 12 months · ● raises crowds and prices · ★ Singapore long weekend, handy for short trips
          </p>
        </div>
        {high ? <Badge tone="critical">{high} busy period{high === 1 ? '' : 's'}</Badge> : marks.some((m) => m.level === 'medium') ? <Badge tone="warning">Some busy periods</Badge> : cal ? <Badge tone="good">No major crowd events</Badge> : null}
      </div>
      {calendar?.state === 'loading' && <p className="small muted">Loading holidays and events…</p>}
      {calendar?.state === 'error' && <p className="small error-text">Holiday and event data could not be loaded: {calendar.message}</p>}
      {cal && byMonth.length === 0 && <p className="small secondary">No major holidays or events in the next 12 months.</p>}
      {byMonth.length > 0 && (
        <div className="cal-list">
          {byMonth.map(([k, ms]) => (
            <div key={k} className={`cal-row${ms.some((m) => m.level === 'high') ? ' high' : ''}`}>
              <div className="cal-date">{monthName(Number(k.slice(5, 7)))} {k.slice(0, 4)}</div>
              <ul className="plain small" style={{ display: 'grid', gap: 4 }}>
                {ms.map((m) => (
                  <li key={m.key} className="risk-head">
                    <span className={m.level === 'long' ? 'tone-info' : m.level === 'high' ? 'tone-critical' : 'tone-warning'} aria-hidden>{m.level === 'long' ? '★' : '●'}</span>
                    <strong>{m.label}</strong>
                    {m.level === 'high' && <Badge tone="critical">High crowd & price impact</Badge>}
                    {m.level === 'medium' && <Badge tone="warning">Busy</Badge>}
                    <span className="muted">
                      {formatShortDate(m.start)}
                      {m.end !== m.start ? ` – ${formatShortDate(m.end)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {cal && (
        <div className="two-col">
          <HolidayBox title="China public holidays" subtitle="Peak outbound travel from China pushes up fares and crowds across Asia." periods={[...cal.china.overlapping, ...cal.china.nearby].filter((p) => p.days >= 3)} />
          <HolidayBox title="Singapore long weekends" subtitle="Handy for short trips; they also fill flights from Changi." periods={cal.singapore.filter((p) => p.days >= 3)} star />
        </div>
      )}
    </section>
  );
}

/** A list of holiday breaks over the year (name and dates), for the crowds card's two boxes. */
function HolidayBox({ title, subtitle, periods, star = false }: { title: string; subtitle: string; periods: { name: string; start: string; end: string; days: number; tentative?: boolean }[]; star?: boolean }) {
  const seen = new Set<string>();
  const list = periods.filter((p) => !seen.has(p.start) && seen.add(p.start)).sort((a, b) => a.start.localeCompare(b.start));
  return (
    <div className="risk">
      <strong>{title}</strong>
      <span className="small muted">{subtitle}</span>
      {list.length === 0 ? (
        <span className="small secondary">None in the next 12 months.</span>
      ) : (
        <ul className="plain small" style={{ display: 'grid', gap: 2 }}>
          {list.map((p) => (
            <li key={p.start}>
              {star && <span className="tone-info" aria-hidden>★ </span>}
              <strong>{p.name}</strong>: {formatShortDate(p.start)}
              {p.end !== p.start ? ` – ${formatShortDate(p.end)}` : ''} ({p.days} days){p.tentative ? ' · provisional' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
