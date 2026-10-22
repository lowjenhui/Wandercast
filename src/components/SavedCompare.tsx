// Probable destinations for a saved date range: a compact side-by-side comparison, a search box
// to add more, duration-based ideas, and the editable flight-time exceptions.
//
// Weather for added destinations is pre-fetched into the database by the server; a row's full
// analysis only runs once its history is stored, so comparing costs no extra API budget.

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildCalendarItems, crowdAlerts, type CrowdAlert } from '../lib/calendarAnalysis';
import { monthsInRange } from '../lib/dates';
import { haversineKm } from '../lib/geo';
import { estimateFlightHours, formatHours, rankCandidates, rateOutlook } from '../lib/outlook';
import { durationLabel, fitsTrip, LIMIT_TIERS, tierFor, tripDays, type TravelException } from '../lib/travelTime';
import { dryMaxWetDays } from '../lib/tripOdds';
import { services } from '../services';
import { nearestAirports } from '../services/airports';
import { getTripCalendar } from '../services/calendar';
import { destinationHours, destinationId, destinationPlace, directAirlinesOn, ferryHours, landOnly, loadDestinations, travelLabel, type Destination } from '../services/destinations';
import {
  addSavedDestination,
  getTravelExceptions,
  removeSavedDestination,
  setTravelExceptions,
  type SavedDestination,
  type SavedRange,
} from '../services/savedRanges';
import { getOutlookStore, usableOutlook } from '../services/tripOutlook';
import { useAdvisoryLevels } from '../services/advisories';
import type { Place } from '../types';
import { evaluateWeather, type WeatherResult } from '../useTripEvaluation';
import { ratingTone } from './WeatherSection';
import { Badge } from './ui';

// ------------------------------------------------------------------ shared helpers

/** Travel info for a saved destination departing on `date`: a ferry crossing if it's a ferry port, else a flight. */
function travelFor(d: { lat: number; lon: number }, dests: Destination[] | null, date: string): { hours: number; label: string; ferry: boolean } {
  const ferry = dests?.find((x) => x.ferry && haversineKm(x.lat, x.lon, d.lat, d.lon) < 25);
  if (ferry?.ferry) return { hours: ferryHours(ferry.ferry), label: travelLabel(ferry), ferry: true };
  // A known place within 15 km (e.g. Hoi An, reached via Da Nang) brings its travel info.
  const match = dests?.find((x) => !x.ferry && haversineKm(x.lat, x.lon, d.lat, d.lon) < 15);
  if (match) return { hours: destinationHours(match), label: travelLabel(match, date), ferry: false };
  return { hours: estimateFlightHours(d.lat, d.lon), label: `✈ ≈${formatHours(estimateFlightHours(d.lat, d.lon))} +conn.`, ferry: false };
}

export function savedPlace(d: SavedDestination): Place {
  return { id: `s:${d.id}`, name: d.name, admin1: d.admin1 ?? undefined, country: d.country, countryCode: d.cc, latitude: d.lat, longitude: d.lon };
}

function useDestinations() {
  const [dests, setDests] = useState<Destination[] | null>(null);
  useEffect(() => {
    loadDestinations().then(setDests, () => setDests([]));
  }, []);
  return dests;
}

function useExceptions() {
  const [ex, setEx] = useState<TravelException[] | null>(null);
  const [defaults, setDefaults] = useState<TravelException[]>([]);
  useEffect(() => {
    getTravelExceptions().then((r) => (setEx(r.exceptions), setDefaults(r.defaults)), () => setEx([]));
  }, []);
  const save = async (next: TravelException[]) => {
    const r = await setTravelExceptions(next);
    setEx(r.exceptions);
  };
  return { exceptions: ex ?? [], loaded: ex !== null, defaults, save };
}

// Row analyses are cached per destination and dates for the session.
const rowCache = new Map<string, Promise<{ weather: WeatherResult; alerts: CrowdAlert[] }>>();

function analyseRow(d: SavedDestination, start: string, end: string) {
  const key = `${d.id}|${start}|${end}`;
  let p = rowCache.get(key);
  if (!p) {
    const place = savedPlace(d);
    p = Promise.all([
      evaluateWeather({ place, destinationCode: d.code, destinationLabel: d.name, startDate: start, endDate: end }, new AbortController().signal, { comfort: false }),
      Promise.all([getTripCalendar(d.cc, start, end), loadDestinations().catch(() => [] as Destination[])])
        .then(([cal, ds]) => {
          const l = ds.find((x) => x.land && haversineKm(x.lat, x.lon, d.lat, d.lon) < 25);
          return crowdAlerts(cal, buildCalendarItems(cal, start, end, { lat: d.lat, lon: d.lon }), d.name, l ? { start, end, overland: landOnly(l) ? 'only' : 'also' } : undefined);
        })
        .catch(() => [] as CrowdAlert[]),
    ]).then(([weather, alerts]) => ({ weather, alerts }));
    p.catch(() => rowCache.delete(key));
    rowCache.set(key, p);
  }
  return p;
}

// ------------------------------------------------------------------ main component

export function SavedCompare({
  range,
  onChanged,
  onOpen,
}: {
  range: SavedRange;
  onChanged: () => void;
  onOpen?: (d: SavedDestination, r: SavedRange) => void;
}) {
  const dests = useDestinations();
  const { exceptions, loaded: exLoaded, defaults, save } = useExceptions();
  const list = range.destinations ?? [];
  const days = tripDays(range.start, range.end);
  const [error, setError] = useState<string | null>(null);
  const past = range.end < new Date().toISOString().slice(0, 10);

  const add = async (d: { name: string; admin1?: string; country: string; cc: string; lat: number; lon: number; code?: string }) => {
    setError(null);
    try {
      let code = d.code ?? '';
      if (!code) code = (await nearestAirports(d.lat, d.lon, 1).catch(() => []))[0]?.cityCode ?? '';
      await addSavedDestination(range.id, { ...d, code });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (d: SavedDestination) => {
    try {
      await removeSavedDestination(range.id, d.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="compare" aria-label="Destinations to compare">
      <div className="compare-head">
        <strong className="small">Destinations to compare</strong>
        <span className="small muted">{durationLabel(days)}</span>
      </div>

      {list.length > 0 ? (
        <div className="compare-scroll">
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col">Place</th>
              <th scope="col">Weather</th>
              <th scope="col" title={`Chance of a dry trip (at least ${days - dryMaxWetDays(days)} of ${days} days dry)`}>Dry trip</th>
              <th scope="col" title="Likely rainfall over the trip (middle half of past trips)">Rain mm</th>
              <th scope="col" title="Average daily high">High</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <CompareRow key={d.id} d={d} range={range} dests={dests} days={days} exceptions={exceptions} onOpen={onOpen} onRemove={() => void remove(d)} />
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <p className="small muted">Add places you’re considering to compare their weather, crowds and flight times side by side.</p>
      )}

      {!past && <AddDestination onAdd={add} dests={dests} date={range.start} />}
      {error && <p className="small error-text" role="alert">{error}</p>}
      {list.length > 0 && (
        <p className="small muted">
          Click a place for its full analysis. Weather history for each place is saved in the background, so comparing costs nothing once stored.
        </p>
      )}

      {!past && exLoaded && (
        <DurationIdeas range={range} days={days} dests={dests} exceptions={exceptions} taken={list} onAdd={(d) => void add({ ...destinationPlaceInput(d), code: d.code })} />
      )}
      {!past && exLoaded && <LimitsEditor days={days} exceptions={exceptions} defaults={defaults} dests={dests} onSave={save} />}
    </div>
  );
}

function destinationPlaceInput(d: Destination) {
  const p = destinationPlace(d);
  return { name: p.name, admin1: p.admin1, country: p.country, cc: p.countryCode, lat: p.latitude, lon: p.longitude };
}

// ------------------------------------------------------------------ one row

function CompareRow({
  d,
  range,
  dests,
  days,
  exceptions,
  onOpen,
  onRemove,
}: {
  d: SavedDestination;
  range: SavedRange;
  dests: Destination[] | null;
  days: number;
  exceptions: TravelException[];
  onOpen?: (d: SavedDestination, r: SavedRange) => void;
  onRemove: () => void;
}) {
  // Analyse once the history is stored; from 95% the few missing days come through the normal
  // search budget (a couple of units) rather than waiting for the background prefetch.
  const ready = !d.weather || d.weather.state === 'complete' || d.weather.state === 'past' || d.weather.pct >= 95;
  const [row, setRow] = useState<{ weather: WeatherResult; alerts: CrowdAlert[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Keyed by id and dates, not the row object: the list is re-read every few seconds while
  // downloads are pending, and re-running (or blanking) each row would make the card jump.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setErr(null);
    analyseRow(d, range.start, range.end).then(
      (r) => alive && setRow(r),
      (e: Error) => alive && setErr(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, d.id, range.start, range.end]);

  const travel = travelFor(d, dests, range.start);
  const fit = fitsTrip({ cc: d.cc, name: d.name, hours: travel.hours, ferry: travel.ferry }, days, exceptions);
  const a = row?.weather.analysis;
  const s = a?.suitability;
  const o = a?.odds;
  const high = row?.alerts.some((x) => x.level === 'high');

  return (
    <tr className="compare-row" onClick={() => onOpen?.(d, range)} title={`Open the full analysis for ${d.name}`}>
      <td>
        <div className="cmp-name">
          <strong>{d.name}</strong>
          {row && row.alerts.length > 0 && (
            <span className={high ? 'tone-critical' : 'tone-warning'} title={row.alerts.map((x) => x.text).join('\n')} aria-label={`${row.alerts.length} crowd or price alerts`}>
              ● {row.alerts.length > 1 ? row.alerts.length : ''}
            </span>
          )}
        </div>
        <div className="small muted">
          {travel.label}
          {!fit.ok && <span className="tone-warning" title={`Longer than the ${formatHours(fit.limit)} guide for a ${durationLabel(days)} trip`}> · long</span>}
          {fit.ok && fit.reason === 'exception' && <span title={`Allowed by your exception: ${fit.exception?.label}`}> · ★</span>}
        </div>
      </td>
      {!ready ? (
        <td colSpan={4}>
          <div className="bar-track" title={d.weather?.detail}><div className="bar-fill" style={{ width: `${Math.max(3, d.weather?.pct ?? 0)}%` }} /></div>
          <span className="small muted">{d.weather?.state === 'waiting' ? 'Waiting for API budget' : `Saving history ${d.weather?.pct ?? 0}%`}</span>
        </td>
      ) : err ? (
        <td colSpan={4} className="small error-text">{err}</td>
      ) : !row ? (
        <td colSpan={4} className="small muted">Analysing…</td>
      ) : (
        <>
          <td>{s ? <Badge tone={ratingTone[s.rating]}>{s.rating === 'Generally pleasant' ? 'Fair' : s.rating}</Badge> : '—'}</td>
          <td className="num">{o ? `${Math.round(o.pMostlyDry * 100)}%` : '—'}</td>
          <td className="num">{o ? `${Math.round(o.rainMm.p25)}–${Math.round(o.rainMm.p75)}` : '—'}</td>
          <td className="num">{o?.meanTMax != null ? `${Math.round(o.meanTMax)}°` : '—'}</td>
        </>
      )}
      <td>
        <button
          type="button"
          className="icon-button small"
          aria-label={`Remove ${d.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ add box

function AddDestination({ onAdd, dests, date }: { onAdd: (p: { name: string; admin1?: string; country: string; cc: string; lat: number; lon: number; code?: string }) => Promise<void>; dests: Destination[] | null; /** Trip start: routes that begin later don't count as direct. */ date: string }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<{ key: string; label: string; sub: string; value: Parameters<typeof onAdd>[0] }[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < 2) return setResults([]);
    const ctrl = new AbortController();
    timer.current = window.setTimeout(async () => {
      // Known destinations first (they carry fare codes and direct-flight info), then geocoding.
      const lc = q.toLowerCase();
      type Result = (typeof results)[number];
      const local: Result[] = (dests ?? [])
        .filter((d) => d.name.toLowerCase().startsWith(lc) || d.name.toLowerCase().includes(` ${lc}`))
        .slice(0, 4)
        .map((d) => ({ key: destinationId(d), label: d.name, sub: `${d.country ?? d.cc}${d.ferry ? ' · ferry' : d.via ? ` · via ${d.via.name}` : directAirlinesOn(d, date) ? ' · direct flight' : ''}`, value: { ...destinationPlaceInput(d), code: d.code } }));
      let geo: Result[] = [];
      try {
        const places = await services.geocoding.search(q, ctrl.signal);
        geo = places
          .filter((p) => !local.some((l) => haversineKm(l.value.lat, l.value.lon, p.latitude, p.longitude) < 30))
          .slice(0, 5)
          .map((p) => ({
            key: p.id,
            label: p.name,
            sub: [p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(', '),
            value: { name: p.name, admin1: p.admin1, country: p.country, cc: p.countryCode, lat: p.latitude, lon: p.longitude },
          }));
      } catch {
        /* offline or aborted: local matches only */
      }
      if (!ctrl.signal.aborted) {
        setResults([...local, ...geo]);
        setActive(0);
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer.current);
    };
  }, [text, dests, date]);

  const pick = async (i: number) => {
    const r = results[i];
    if (!r || busy) return;
    setBusy(true);
    await onAdd(r.value);
    setBusy(false);
    setText('');
    setResults([]);
  };

  return (
    <div className="cmp-add">
      <input
        type="text"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={`${id}-list`}
        aria-label="Add a destination to compare"
        placeholder="+ Add a destination, e.g. Da Nang"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(results.length - 1, a + 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
          else if (e.key === 'Enter') (e.preventDefault(), void pick(active));
          else if (e.key === 'Escape') setResults([]);
        }}
      />
      {results.length > 0 && (
        <ul className="cmp-results" id={`${id}-list`} role="listbox">
          {results.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void pick(i)}>
                <strong>{r.label}</strong> <span className="small muted">{r.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ duration ideas

const IDEAS = 5;

function DurationIdeas({
  range,
  days,
  dests,
  exceptions,
  taken,
  onAdd,
}: {
  range: SavedRange;
  days: number;
  dests: Destination[] | null;
  exceptions: TravelException[];
  taken: SavedDestination[];
  onAdd: (d: Destination) => void;
}) {
  const { store, plan } = useMemo(() => getOutlookStore(range.start, range.end), [range.start, range.end]);
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const tier = tierFor(days);
  const months = useMemo(() => monthsInRange(range.start, range.end), [range.start, range.end]);

  const takenKey = taken.map((t) => t.id).join(',');
  const fitting = useMemo(() => {
    if (!dests) return [];
    return dests
      .map((d) => ({ d, hours: destinationHours(d) }))
      .filter(({ d, hours }) => fitsTrip({ cc: d.cc, name: d.name, hours, ferry: Boolean(d.ferry) }, days, exceptions).ok)
      .filter(({ d }) => !taken.some((t) => haversineKm(t.lat, t.lon, d.lat, d.lon) < 30));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dests, days, exceptions, takenKey]);

  // Typical weather for these dates; already saved for map places when the range was pre-fetched.
  useEffect(() => {
    if (plan.basis !== 'none' && fitting.length) store.request(fitting.map(({ d }) => ({ id: destinationId(d), lat: d.lat, lon: d.lon })));
  }, [fitting, store, plan]);

  // MFA "defer all travel" places are left out, with a count; others carry a flag.
  const levels = useAdvisoryLevels(dests, destinationId);
  const deferred = fitting.filter(({ d }) => levels.get(destinationId(d)) === 'all').length;
  const ranked = useMemo(() => {
    const items = fitting.filter(({ d }) => levels.get(destinationId(d)) !== 'all').map(({ d, hours }) => {
      const o = usableOutlook(store.get(destinationId(d)));
      return { dest: d, hours, suitability: o ? rateOutlook(o, services.risks.risksFor(destinationPlace(d), months)) : null };
    });
    return rankCandidates(items, 'balanced', null).filter((c) => c.suitability).slice(0, IDEAS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitting, store, version, months, levels]);

  const exNames = exceptions.filter((x) => days >= x.minDays).map((x) => x.label);
  return (
    <div className="cmp-ideas">
      <div className="compare-head">
        <strong className="small">Ideas for {durationLabel(days)}</strong>
        <span className="small muted">
          {tier.hours === null ? 'any flight time' : `flights ≤${formatHours(tier.hours)}`}
          {exNames.length ? ` + ${exNames.join(', ')}` : ''}
        </span>
      </div>
      {ranked.length === 0 ? (
        <p className="small muted">{dests ? 'Loading typical weather for these dates…' : 'Loading destinations…'}</p>
      ) : (
        <ul className="idea-list">
          {ranked.map(({ dest, hours, suitability }) => (
            <li key={destinationId(dest)}>
              <span className="idea-name" title={travelLabel(dest, range.start)}>
                <strong>{dest.name}</strong> <span className="small muted">{dest.via ? `✈+${dest.via.mode} ≈${formatHours(hours)}` : travelLabel(dest, range.start)}</span>
              </span>
              {levels.get(destinationId(dest)) === 'nonEssential' && <Badge tone="critical">MFA: defer non-essential</Badge>}
              {suitability && <Badge tone={ratingTone[suitability.rating]}>{suitability.rating === 'Generally pleasant' ? 'Fair' : suitability.rating}</Badge>}
              <button type="button" className="small" onClick={() => onAdd(dest)} aria-label={`Add ${dest.name}`}>+ Add</button>
            </li>
          ))}
        </ul>
      )}
      <span className="small muted">
        Ranked by typical weather for these dates and shorter travel.
        {deferred ? ` ${deferred} place${deferred === 1 ? '' : 's'} left out: MFA advises deferring all travel.` : ''}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ limits + exceptions

function LimitsEditor({
  days,
  exceptions,
  defaults,
  dests,
  onSave,
}: {
  days: number;
  exceptions: TravelException[];
  defaults: TravelException[];
  dests: Destination[] | null;
  onSave: (next: TravelException[]) => Promise<void>;
}) {
  const [choice, setChoice] = useState('');
  const [minDays, setMinDays] = useState(3);
  const [err, setErr] = useState<string | null>(null);

  // Countries and cities from the destination list, for the exception picker.
  const options = useMemo(() => {
    if (!dests) return [];
    const countries = new Map<string, string>();
    dests.forEach((d) => countries.set(d.cc, d.country ?? d.cc));
    const cs = [...countries].sort((a, b) => a[1].localeCompare(b[1])).map(([cc, name]) => ({ key: `c:${cc}`, label: `All of ${name}`, value: { cc, label: name } }));
    const cities = dests
      .filter((d) => !d.ferry)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ key: `p:${destinationId(d)}`, label: `${d.name} (${d.country ?? d.cc})`, value: { cc: d.cc, city: d.name, label: d.name } }));
    return [...cs, ...cities];
  }, [dests]);

  const update = async (next: TravelException[]) => {
    setErr(null);
    try {
      await onSave(next);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <details className="cmp-limits">
      <summary className="small">Flight-time guide and exceptions</summary>
      <table className="limits-table small">
        <tbody>
          {LIMIT_TIERS.map((t) => (
            <tr key={t.label} className={tierFor(days) === t ? 'current' : undefined}>
              <td>{t.label}</td>
              <td>{t.hours === null ? 'any' : `≤${formatHours(t.hours)}`}</td>
              <td className="muted">{t.examples}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">One-way direct flight time from Changi, estimated from distance. Travel should take at most about 15–20% of the trip; ferries always fit.</p>
      <div className="exceptions">
        <strong className="small">Exceptions</strong>
        {exceptions.length === 0 && <span className="small muted">None</span>}
        {exceptions.map((x, i) => (
          <span key={`${x.cc}:${x.city ?? ''}`} className="legend-chip static ex-chip">
            ★ {x.label} · from {durationLabel(x.minDays)}
            <button type="button" className="icon-button" aria-label={`Remove exception ${x.label}`} onClick={() => void update(exceptions.filter((_, j) => j !== i))}>✕</button>
          </span>
        ))}
      </div>
      <div className="ex-add">
        <select aria-label="Place to allow" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a country or city…</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <select aria-label="From trip length" value={minDays} onChange={(e) => setMinDays(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 7, 10, 14].map((n) => (
            <option key={n} value={n}>from {durationLabel(n)}</option>
          ))}
        </select>
        <button
          type="button"
          className="small"
          disabled={!choice}
          onClick={() => {
            const o = options.find((x) => x.key === choice);
            if (!o) return;
            const rest = exceptions.filter((x) => !(x.cc === o.value.cc && (x.city ?? '') === ((o.value as { city?: string }).city ?? '')));
            void update([...rest, { ...o.value, minDays }]).then(() => setChoice(''));
          }}
        >
          Add
        </button>
        {defaults.length > 0 && JSON.stringify(defaults) !== JSON.stringify(exceptions) && (
          <button type="button" className="link-button small" onClick={() => void update(defaults)}>Reset to default</button>
        )}
      </div>
      {err && <p className="small error-text">{err}</p>}
    </details>
  );
}
