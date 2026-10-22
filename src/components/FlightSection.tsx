import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { CHECKED_KG, baggageFor, type BaggageLabel } from '../data/airlineBaggage';
import { CURRENCY_LABEL, FARE_CURRENCY, formatPrice } from '../lib/currency';
import { formatDate, formatShortDate } from '../lib/dates';
import { MIN_BENCHMARK_SAMPLE, type FareValue } from '../lib/fareAnalysis';
import {
  DEFAULT_FLIGHT_RULES,
  flexSuggestions,
  hoursAtDestination,
  isLongHaul,
  isWorkday,
  rankLegs,
  type FlightRules,
  type Fit,
  type RankedLeg,
} from '../lib/flightRules';
import { ORIGIN } from '../services/airports';
import { getPublicHolidayDates } from '../services/calendar';
import { COMPARABLE_DEPART_WINDOW_DAYS, stayTolerance } from '../services/fares';
import { getFlightRules, saveFlightRules } from '../services/flightRules';
import type { LiveLeg, TripQuery } from '../types';
import type { Async, FareResult } from '../useTripEvaluation';
import { FareHistogram } from './charts';
import { Badge, Notice, SkeletonCard, type Tone } from './ui';
import { ChartBox, Tile } from './WeatherSection';
import { daysBetween } from '../lib/dates';

export const valueTone: Record<FareValue, Tone> = { 'Good value': 'good', Typical: 'warning', Expensive: 'critical' };

const sgd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatPrice(n));

/** Section title with the currency badge beside it. */
const Title = ({ children }: { children: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
    <h2 id="fl-h">{children}</h2>
    <Badge tone="info">{CURRENCY_LABEL}</Badge>
  </div>
);

export function FlightSection({ result, query, onDates }: { result: Async<FareResult>; query: TripQuery; onDates?: (start: string, end: string) => void }) {
  if (result.state === 'idle') return null;
  if (result.state === 'loading') return <SkeletonCard title="Up, up and away" note={`Looking up fares from ${ORIGIN.iata} to ${query.destinationCode}…`} />;

  const route = `${ORIGIN.iata} → ${query.destinationCode || '?'}`;
  const nights = daysBetween(query.startDate, query.endDate);
  const overland = query.land ? <OverlandBlock land={query.land} /> : null;
  const header = query.land?.only && !query.ferry ? (
    <div style={{ display: 'grid', gap: 4 }}>
      <Title>On the road!</Title>
      <p className="small muted">
        Singapore → {query.land.name} overland · {formatDate(query.startDate)} – {formatDate(query.endDate)}
      </p>
    </div>
  ) : query.ferry ? (
    <div style={{ display: 'grid', gap: 4 }}>
      <Title>All aboard!</Title>
      <p className="small muted">
        Singapore ({query.ferry.terminal}) → {query.ferry.name} by ferry · {formatDate(query.startDate)} – {formatDate(query.endDate)}
      </p>
    </div>
  ) : (
    <div style={{ display: 'grid', gap: 4 }}>
      <Title>Up, up and away</Title>
      <p className="small muted">
        {route} · {formatDate(query.startDate)} – {formatDate(query.endDate)} (landing back in Singapore) · economy · 1 adult · {FARE_CURRENCY}
        {query.via && (
          <>
            <br />
            Fares are for flights to {query.via.name} ({query.via.code}); {query.place.name} is then about {query.via.minutes[0]}–{query.via.minutes[1]} min by {query.via.mode}.
          </>
        )}
      </p>
    </div>
  );

  if (result.state === 'error') {
    return (
      <section className="card" aria-labelledby="fl-h">
        {header}
        <Notice kind="err" title="Airfare data could not be retrieved"><p>{result.message}</p></Notice>
        {overland}
      </section>
    );
  }

  const { data, assessment: fa } = result.value;

  if (data.status !== 'ok' || !fa) {
    return (
      <section className="card" aria-labelledby="fl-h">
        {header}
        <Notice kind={data.status === 'error' ? 'err' : 'warn'} title={
          data.status === 'ferry' ? 'Reached by ferry, no flight needed'
          : data.status === 'land' ? 'Reached overland, no flight needed'
          : data.status === 'not-configured' ? 'No airfare provider configured'
          : data.status === 'past-dates' ? 'Dates are in the past'
          : data.status === 'error' ? 'Airfare provider error'
          : 'No reliable airfare data for this route'
        }>
          <p>{data.message}</p>
          <p className="small muted">
            {data.status === 'ferry' ? 'Ferry fares aren’t tracked by Wandercast.' : data.status === 'land' ? 'Coach, bus and train fares aren’t tracked by Wandercast.' : 'No prices are estimated or invented.'} {query.manualFareSgd ? `Your entered fare (${sgd(query.manualFareSgd)}) cannot be judged without a benchmark.` : ''}
          </p>
        </Notice>
        {overland}
        <Sources data={data} />
      </section>
    );
  }

  const b = fa.benchmark;
  const refLabel = fa.reference?.kind === 'manual' ? 'your fare' : fa.reference?.kind === 'live' ? 'cheapest live' : 'cheapest cached';
  const refPhrase = fa.reference?.kind === 'manual' ? 'the fare you entered' : fa.reference?.kind === 'live' ? 'the cheapest live Google Flights fare' : 'the cheapest cached fare for your exact dates';

  return (
    <section className="card" aria-labelledby="fl-h">
      <div className="card-head">
        {header}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {fa.value ? <Badge tone={valueTone[fa.value]}>{fa.value}</Badge> : <Badge tone="neutral">No value verdict</Badge>}
          <Badge tone={b.sufficient ? 'good' : 'critical'}>{b.sufficient ? `Sample: ${b.sampleSize} fares` : 'Insufficient sample'}</Badge>
        </div>
      </div>
      <p>{fa.headline}</p>
      <SavedNote data={data} />

      {/* 1. Historical observations */}
      <div style={{ display: 'grid', gap: 10 }}>
        <div className="risk-head">
          <h3>Observed fares for comparable trips</h3>
          <Badge tone="info">
            {b.observationSpanDays !== undefined && b.observationSpanDays < 30 ? 'Historical observations · short recent window' : 'Historical observations'}
          </Badge>
        </div>
        <p className="small secondary">
          Return fares already found by travellers' searches, for departures within ±{COMPARABLE_DEPART_WINDOW_DAYS} days of your start date and stays of {nights} ± {stayTolerance(nights)} nights.
        </p>
        {b.sampleSize === 0 ? (
          <p className="small">No comparable observations were found.</p>
        ) : (
          <>
            <div className="tiles">
              <Tile k="Median fare" v={b.sufficient ? sgd(b.median) : '—'} s={b.sufficient ? 'comparable trips' : `needs ≥${MIN_BENCHMARK_SAMPLE} observations`} />
              <Tile k="Typical range" v={b.sufficient ? `${sgd(b.p25)}–${sgd(b.p75)}` : '—'} s="middle 50% of observed fares" />
              <Tile k="Lowest / highest" v={`${sgd(b.min)} / ${sgd(b.max)}`} s={`${b.sampleSize} observation(s)`} />
              <Tile k="Observation period" v={b.observedFrom ? `${formatShortDate(b.observedFrom)} – ${formatShortDate(b.observedTo!)}` : 'unknown'} s={b.observationSpanDays !== undefined ? `found over ${b.observationSpanDays + 1} day(s)` : 'found dates not reported'} />
              {b.directShare !== null && <Tile k="Direct flights" v={`${Math.round(b.directShare * 100)}%`} s="of observed fares" />}
            </div>
            {b.sufficient && (
              <ChartBox title="Distribution of observed comparable fares" caption={`Each bar counts observed fares in a price band. The dashed line marks the median${fa.reference ? `; the solid line marks ${refPhrase}` : ''}.`}>
                <FareHistogram prices={data.comparable.map((o) => o.priceSgd)} reference={fa.reference?.priceSgd ?? null} referenceLabel={refLabel} median={b.median} />
              </ChartBox>
            )}
            {fa.value && fa.percentile !== null && (
              <p className="small secondary">
                {refPhrase[0].toUpperCase() + refPhrase.slice(1)} is cheaper than about {Math.max(0, 100 - fa.percentile)}% of comparable observed fares.
              </p>
            )}
          </>
        )}
        {fa.seasonal && (
          <p className="small">
            <strong>Seasonal position:</strong> fares for these dates are <strong>{fa.seasonal.position.toLowerCase()}</strong> for this route: the median {sgd(b.median)} compares with {sgd(fa.routeWide.median)} across all observed upcoming departures with a similar stay ({fa.routeWide.sampleSize} fares, ratio {fa.seasonal.ratio.toFixed(2)}).
          </p>
        )}
      </div>

      {/* 2. Cached exact-date fares */}
      <div style={{ display: 'grid', gap: 10 }}>
        <div className="risk-head">
          <h3>Recently cached fares for your exact dates</h3>
          <Badge tone="warning">Cached estimate · not live</Badge>
        </div>
        {data.exactDates.length === 0 ? (
          <p className="small secondary">No cached fares for these exact dates. Nobody has searched this exact itinerary recently.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Airline</th><th>Out</th><th>Back</th><th>Stops (out)</th><th>Price</th><th></th></tr></thead>
              <tbody>
                {data.exactDates.slice(0, 5).map((o, i) => (
                  <tr key={i}>
                    <td>{o.airline ?? '—'}</td>
                    <td>{formatShortDate(o.departDate)}</td>
                    <td>{o.returnDate ? formatShortDate(o.returnDate) : '—'}</td>
                    <td>{o.transfers ?? '—'}</td>
                    <td>{sgd(o.priceSgd)}</td>
                    <td>{o.link && <a href={o.link} target="_blank" rel="noreferrer">Check</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. Live fares */}
      <LiveFaresBlock data={data} query={query} onDates={onDates} />

      {query.manualFareSgd && (
        <p className="small"><Badge tone="neutral">Manual input</Badge> You entered {sgd(query.manualFareSgd)}. Manual fares are only compared with observations and never added to the benchmark.</p>
      )}

      <details>
        <summary>Data limitations & sources</summary>
        <ul className="plain small secondary">
          {fa.limitations.map((t) => <li key={t}>{t}</li>)}
          {data.warnings.map((t) => <li key={t} className="tone-serious">{t}</li>)}
        </ul>
        <Sources data={data} />
      </details>
      {overland}
    </section>
  );
}

/** Getting there overland: departure points, typical times, operators and sources (no fares). */
function OverlandBlock({ land }: { land: NonNullable<TripQuery['land']> }) {
  const [a, b] = land.minutes;
  const h = (m: number) => `${Math.round((m / 60) * 2) / 2}h`;
  const span = b < 120 ? (a === b ? `${a} min` : `${a}–${b} min`) : a === b ? h(a) : `${h(a)}–${h(b)}`;
  return (
    <div className="notice overland" aria-label="Getting there overland">
      <strong>🚌 {land.only ? 'Getting there overland' : 'Or overland'}</strong>
      <p className="small">
        {land.modes.join(' or ')} from {land.from} · typically {span} door to door, including the checkpoint.
        {land.operators.length > 0 && ` Operators: ${land.operators.join(', ')}.`}
      </p>
      {land.notes && <p className="small secondary">{land.notes}</p>}
      <p className="small muted">
        Times are typical on a normal day; weekend and holiday queues at the Woodlands and Tuas checkpoints can add 1–3 hours. Check the operator for fares and schedules. Sources:{' '}
        {land.sources.map((s, i) => (
          <Fragment key={s.url}>{i > 0 && ' · '}<a href={s.url} target="_blank" rel="noreferrer">{s.name}</a></Fragment>
        ))}
      </p>
    </div>
  );
}

const minutes = (m?: number) => (m === undefined ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (date: string) => DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
/** "Fri 23:55" from "2026-12-04 23:55". */
const dayClock = (t: string) => `${dow(t.slice(0, 10))} ${t.slice(11, 16)}`;
const fitTone: Record<Fit, Tone> = { good: 'good', ok: 'warning', poor: 'critical' };

/** Live Google Flights one-way options for the exact dates (SerpApi), ranked by the flight rules. */
function LiveFaresBlock({ data, query, onDates }: { data: FareResult['data']; query: TripQuery; onDates?: (start: string, end: string) => void }) {
  const live = data.live;
  const [rules, setRules] = useState<FlightRules>(DEFAULT_FLIGHT_RULES);
  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  useEffect(() => {
    void getFlightRules().then(setRules);
  }, []);
  useEffect(() => {
    getPublicHolidayDates('SG', query.startDate, query.endDate).then(setHolidays).catch(() => setHolidays(new Set()));
  }, [query.startDate, query.endDate]);

  const tripDays = daysBetween(query.startDate, query.endDate) + 1;
  const japan = query.place.countryCode === 'JP';
  const longHaul = isLongHaul(live?.outbound ?? [], rules);
  const priceRef = live?.roundTrip?.options;
  const outCtx = { date: query.startDate, workday: isWorkday(query.startDate, holidays), tripDays, japan, longHaul, priceRef };
  const backCtx = { date: query.endDate, workday: isWorkday(query.endDate, holidays), tripDays, japan, longHaul, priceRef };
  const outbound = useMemo(() => rankLegs(live?.outbound ?? [], 'outbound', outCtx, rules), [live, rules, outCtx.workday, tripDays, japan]); // eslint-disable-line react-hooks/exhaustive-deps
  const back = useMemo(() => rankLegs(live?.inbound ?? [], 'return', backCtx, rules), [live, rules, backCtx.workday, tripDays, japan]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const toggleMiddleEast = (on: boolean) => {
    const next = { ...rules, avoidMiddleEast: on };
    setRules(next);
    setSaving(true);
    saveFlightRules(next)
      .then(setRules)
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  const head = (badge: React.ReactNode) => (
    <div className="risk-head">
      <h3>Current live fares</h3>
      {badge}
    </div>
  );
  if (!live || live.status === 'not-configured') {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {head(<Badge tone="neutral">Not configured</Badge>)}
        <p className="small secondary">
          No live-search provider is connected, so no bookable real-time fares are shown. Add a free SerpApi key as SERPAPI_KEY in .env.local for live Google Flights prices. Check an airline or OTA before booking.
        </p>
      </div>
    );
  }
  if (live.status === 'error') {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {head(<Badge tone="critical">Unavailable</Badge>)}
        <p className="small secondary">Live Google Flights prices could not be loaded and none were saved for this search: {live.message}</p>
      </div>
    );
  }

  const shownOut = outbound.filter((r) => !r.hidden);
  const shownBack = back.filter((r) => !r.hidden);
  const pick = shownOut[0] && shownBack[0] ? { out: shownOut[0], back: shownBack[0] } : null;
  const rtOptions = live.roundTrip?.options ?? [];
  const rtCheapest = rtOptions.length ? Math.min(...rtOptions.map((l) => l.priceSgd)) : null;
  const rtNonstop = rtOptions.filter((l) => l.stops === 0);
  const rtNonstopCheapest = rtNonstop.length ? Math.min(...rtNonstop.map((l) => l.priceSgd)) : null;
  // The suggested outbound flight as part of a return ticket (long-haul one-ways are often much dearer).
  const pickAsReturn = pick ? rtOptions.find((l) => l.flightNumbers.join() === pick.out.leg.flightNumbers.join()) : undefined;
  const cachedExact = data.exactDates.length ? Math.min(...data.exactDates.map((o) => o.priceSgd)) : null;
  const flex = flexSuggestions([...data.comparable, ...data.exactDates], query.startDate, query.endDate, cachedExact ?? live.cheapestTotal, rules);
  const place = query.via?.name ?? query.place.name;
  const dayKind = (c: { workday: boolean }) => (c.workday ? 'workday' : 'weekend or public holiday');

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {head(<Badge tone={live.saved?.stale ? 'warning' : 'good'}>{live.saved?.stale ? 'Saved · live unavailable' : 'Google Flights · live'}</Badge>)}
      {live.saved?.stale && (
        <Notice kind="warn" title="Showing saved live prices">
          <p>Google Flights prices can’t be fetched right now (for example, this month’s SerpApi searches are used up), so these are the prices saved on {savedTime(live.saved.at)}.</p>
        </Notice>
      )}
      <p className="small secondary">
        <strong>Your flight rules:</strong> out {dow(query.startDate)} {formatShortDate(query.startDate)} ({dayKind(outCtx)}):{' '}
        {outCtx.workday ? `leave ${rules.eveningDepartFrom} or later, else land ${rules.morningArriveFrom}–${rules.morningArriveTo}` : `land ${rules.morningArriveFrom}–${rules.morningArriveTo}`}
        {' · '}back {dow(query.endDate)} {formatShortDate(query.endDate)} ({dayKind(backCtx)}):{' '}
        {backCtx.workday ? `land in Singapore by ${rules.workdayLandBy}` : `leave ${rules.lateReturnFrom} or later`}
        {' · '}
        {longHaul
          ? `long-haul: non-stop first unless it costs ${rules.nonstopPremiumPct}% or ${sgd(rules.nonstopPremiumAmount)} more than a connection; Google's top connections kept${backCtx.workday ? '; returns can’t land before work, so the latest landing on the end date ranks first' : ''}`
          : tripDays <= rules.shortTripDays && !japan
            ? `${tripDays}-day trip: non-stop preferred`
            : japan
              ? 'Japan: short, well-priced connections rank with non-stop'
              : 'connections ranked after non-stop'}
        .
      </p>
      <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left' }}>
        <input type="checkbox" style={{ margin: '2px 0 0' }} checked={rules.avoidMiddleEast} disabled={saving} onChange={(e) => toggleMiddleEast(e.target.checked)} />
        <span>
          Avoid connections through the Middle East{' '}
          <span className="muted">(UAE, Qatar, Bahrain, Kuwait, Oman, Saudi Arabia, Jordan, Israel, Lebanon, Iran, Iraq, Syria, Yemen; non-stop routes aren’t checked)</span>
        </span>
      </label>

      {pick && (
        <div className="tiles">
          <Tile
            k="Suggested outbound + return"
            v={sgd(pick.out.leg.priceSgd + pick.back.leg.priceSgd)}
            s={`${pick.out.leg.airlines.join(' + ')} out, ${pick.back.leg.airlines.join(' + ')} back · two one-way tickets${pickAsReturn ? `; as a return ticket from ${sgd(pickAsReturn.priceSgd)}` : ''}`}
          />
          <Tile k={`Time in ${place}`} v={`${Math.round(hoursAtDestination(pick.out.leg, pick.back.leg))} h`} s={`lands ${dayClock(pick.out.leg.arriveTime)}, leaves ${dayClock(pick.back.leg.departTime)}`} />
          {live.cheapestTotal !== null && <Tile k="Cheapest any time" v={sgd(live.cheapestTotal)} s="outbound + return, ignoring the time rules" />}
          {rtCheapest !== null && (
            <Tile k="Return ticket" v={sgd(rtCheapest)} s={`one round-trip ticket${rtNonstopCheapest !== null ? `; non-stop from ${sgd(rtNonstopCheapest)}` : ''}`} />
          )}
        </div>
      )}
      {pick && (
        <p className="small" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>Out: <AirlineIcons leg={pick.out.leg} /> {pick.out.leg.flightNumbers.join(', ')} {dayClock(pick.out.leg.departTime)}</span>
          <span>Back: <AirlineIcons leg={pick.back.leg} /> {pick.back.leg.flightNumbers.join(', ')} {dayClock(pick.back.leg.departTime)}</span>
          {live.roundTrip?.url && <a href={live.roundTrip.url} target="_blank" rel="noreferrer">Return tickets on Google Flights</a>}
        </p>
      )}

      <LegTable title={`Outbound · ${dow(query.startDate)} ${formatShortDate(query.startDate)}`} rows={outbound} url={live.urls.outbound} />
      <LegTable title={`Return · landing ${dow(query.endDate)} ${formatShortDate(query.endDate)}`} rows={back} url={live.urls.inbound} />

      {flex.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <h4 className="small">Cheaper dates nearby (±1 day)</h4>
          <ul className="plain small">
            {flex.map((f) => (
              <li key={`${f.departDate}|${f.returnDate}`}>
                {dow(f.departDate)} {formatShortDate(f.departDate)} – {dow(f.returnDate)} {formatShortDate(f.returnDate)}: about {sgd(f.priceSgd)} return, {sgd(f.savings)} less (recently cached fare, not live).{' '}
                {onDates && <button type="button" className="link" onClick={() => onDates(f.departDate, f.returnDate)}>Analyse these dates</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="small muted">
        Economy, 1 adult, {FARE_CURRENCY}, one-way prices. Baggage is typical for a standard economy fare (checked bag prices assume {CHECKED_KG} kg each way, pre-booked) and isn’t added to the price; check with the airline. 🌙 marks red-eye flights (in the air 01:00–05:00). {live.saved && !live.saved.stale ? `Searched ${savedTime(live.saved.at)}; saved searches are reused for 6 hours.` : ''}
      </p>
      <RulesEditor rules={rules} onChange={setRules} />
    </div>
  );
}

function LegTable({ title, rows, url }: { title: string; rows: RankedLeg[]; url?: string }) {
  const shown = rows.filter((r) => !r.hidden).slice(0, 6);
  const hidden = rows.filter((r) => r.hidden);
  const [open, setOpen] = useState<number | null>(null);
  const idBase = useId();
  useEffect(() => setOpen(null), [rows]);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <h4 className="small">
        {title} {url && <a href={url} target="_blank" rel="noreferrer" className="muted">· Google Flights</a>}
      </h4>
      {shown.length === 0 ? (
        <p className="small secondary">No flights found for this day{hidden.length ? ' within the layover limits' : ''}.</p>
      ) : (
        <table className="leg-table">
          <colgroup>
            <col className="leg-fit-col" />
            <col className="leg-flight-col" />
            <col className="leg-times-col" />
            <col className="leg-price-col" />
            <col className="leg-toggle-col" />
          </colgroup>
          <thead><tr><th className="leg-fit"><span>Fit</span></th><th>Flight</th><th>Times</th><th>Price</th><th><span className="sr-only">Details</span></th></tr></thead>
          <tbody>
            {shown.map((r, i) => {
              const l = r.leg;
              const bags = baggageFor(l.flightNumbers, l.airlines, l.totalMinutes);
              const isOpen = open === i;
              const detailId = `${idBase}-detail-${i}`;
              const toggle = () => setOpen(isOpen ? null : i);
              return (
                <Fragment key={i}>
                  <tr className={`leg-row${isOpen ? ' open' : ''}`} onClick={toggle}>
                    <td className="leg-fit">
                      <div>
                        <Badge tone={fitTone[r.fit]}>{r.label}</Badge>
                        {r.note && <div><Badge tone="info">{r.note}</Badge></div>}
                      </div>
                    </td>
                    <td>
                      {/* On phones the Fit column is hidden and its badges show here instead. */}
                      <div className="fit-inline">
                        <Badge tone={fitTone[r.fit]}>{r.label}</Badge>
                        {r.note && <> <Badge tone="info">{r.note}</Badge></>}
                      </div>
                      <AirlineIcons leg={l} /> {l.airlines.join(' + ') || '—'}
                    </td>
                    <td>
                      <span className="leg-times"><span className="nowrap">{dayClock(l.departTime)} →</span> <span className="nowrap">{dayClock(l.arriveTime)}</span></span>
                      {r.redEye && <> <span title="Red-eye: in the air between 01:00 and 05:00" aria-label="Red-eye">🌙</span></>}
                      <div className="small muted">
                        {minutes(l.totalMinutes)} · {l.stops === 0 ? 'Non-stop' : `${l.stops} stop${l.stops > 1 ? 's' : ''}`}
                      </div>
                    </td>
                    <td className="leg-price">
                      <strong>{sgd(l.priceSgd)}</strong>
                      <BagHint bags={bags} />
                    </td>
                    <td className="leg-toggle">
                      <button
                        type="button"
                        className="chevron"
                        aria-expanded={isOpen}
                        aria-controls={detailId}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${l.airlines.join(' + ')} ${dayClock(l.departTime)}`}
                        onClick={(e) => { e.stopPropagation(); toggle(); }}
                      >
                        <span aria-hidden>{isOpen ? '▾' : '▸'}</span>
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="leg-detail" id={detailId}>
                      <td colSpan={5}>
                        <dl>
                          {l.flightNumbers.length > 0 && (<><dt>Flights</dt><dd>{l.flightNumbers.join(', ')}</dd></>)}
                          <dt>Route</dt>
                          <dd>
                            {l.route.length ? l.route.join(' → ') : '—'}
                            {l.stops > 0 && <div className="muted">{l.layovers.map((x) => `${minutes(x.minutes)} in ${x.airport}${x.overnight ? ' (overnight)' : ''}`).join(', ')}</div>}
                          </dd>
                          {r.redEye && (<><dt>Red-eye</dt><dd>In the air between 01:00 and 05:00</dd></>)}
                          {r.deprioritised && (<><dt>Ranking</dt><dd>{r.deprioritised}</dd></>)}
                          <dt>Bags (typical)</dt>
                          <dd>
                            {bags.map((b) => (
                              <div key={b.airline}>
                                {bags.length > 1 && <strong>{b.airline}: </strong>}
                                {b.carryOn} · {b.checked}
                                {b.note && <span className="muted"> ({b.note})</span>}
                              </div>
                            ))}
                          </dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {hidden.length > 0 && (
        <details className="small secondary">
          <summary>{hidden.length} option{hidden.length > 1 ? 's' : ''} left out</summary>
          <ul className="plain">
            {hidden.slice(0, 8).map((r, i) => (
              <li key={i}>{r.leg.airlines.join(' + ')} {dayClock(r.leg.departTime)}, {sgd(r.leg.priceSgd)}: {r.hidden}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One logo per airline on the leg, falling back to its IATA code when the image won't load. */
/** Short checked-bag hint under the price: included, or the typical extra fee (the highest when airlines differ). */
function BagHint({ bags }: { bags: BaggageLabel[] }) {
  const fees = bags.map((b) => b.checkedFeeSgd);
  const fee = fees.some((f) => f !== null) ? Math.max(...fees.filter((f): f is number => f !== null)) : null;
  const approx = bags.some((b) => !b.known);
  const text = fee === null ? 'incl.' : `${approx ? '~' : ''}+${sgd(fee)}`;
  const title = fee === null ? 'Checked bag typically included in the fare' : `Checked ${CHECKED_KG} kg bag typically ${approx ? 'about ' : ''}${sgd(fee)} each way, not included in the price`;
  return <div className="bag-hint" title={title}><span aria-hidden>🧳</span> {text}<span className="sr-only">. {title}</span></div>;
}

function AirlineIcons({ leg }: { leg: LiveLeg }) {
  const seen = new Map<string, { code: string; name: string; logo?: string }>();
  for (const s of leg.segments) {
    const code = (s.flightNumber ?? '').replace(/\s+/g, '').slice(0, 2).toUpperCase() || '??';
    if (!seen.has(code)) seen.set(code, { code, name: s.airline ?? code, logo: s.logo });
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, verticalAlign: 'middle' }}>
      {[...seen.values()].map((a) => <AirlineIcon key={a.code} {...a} />)}
    </span>
  );
}

function AirlineIcon({ code, name, logo }: { code: string; name: string; logo?: string }) {
  const [failed, setFailed] = useState(false);
  if (!logo || failed) {
    return (
      <span title={name} className="badge tone-neutral" style={{ fontSize: 10, padding: '0 4px', lineHeight: '18px' }}>
        {code}
      </span>
    );
  }
  return <img src={logo} alt={name} title={name} width={20} height={20} style={{ verticalAlign: 'middle', borderRadius: 4 }} onError={() => setFailed(true)} />;
}

const RULE_FIELDS: { key: keyof FlightRules; label: string; kind: 'time' | 'number' | 'checkbox'; unit?: string }[] = [
  { key: 'eveningDepartFrom', label: 'Workday departure: leave at or after', kind: 'time' },
  { key: 'morningArriveFrom', label: 'Early arrival window from', kind: 'time' },
  { key: 'morningArriveTo', label: 'Early arrival window to', kind: 'time' },
  { key: 'workdayLandBy', label: 'Workday return: land in Singapore by', kind: 'time' },
  { key: 'lateReturnFrom', label: 'Other returns: leave at or after', kind: 'time' },
  { key: 'shortTripDays', label: 'Short trip (non-stop preferred) up to', kind: 'number', unit: 'days' },
  { key: 'connectionCheaperPct', label: 'Short trip: show connections at least', kind: 'number', unit: '% cheaper' },
  { key: 'layoverMinMinutes', label: 'Shortest layover', kind: 'number', unit: 'min' },
  { key: 'layoverMaxMinutes', label: 'Longest layover', kind: 'number', unit: 'min' },
  { key: 'maxExtraMinutes', label: 'At most this much longer than the fastest flight', kind: 'number', unit: 'min' },
  { key: 'flexCheaperPct', label: 'Nearby dates: at least', kind: 'number', unit: '% cheaper' },
  { key: 'flexCheaperAmount', label: 'Nearby dates: and at least', kind: 'number', unit: `${FARE_CURRENCY} cheaper` },
  { key: 'avoidMiddleEast', label: 'Avoid connections through the Middle East', kind: 'checkbox' },
  { key: 'longHaulMinutes', label: 'Long-haul when the fastest flight takes at least', kind: 'number', unit: 'min' },
  { key: 'nonstopPremiumPct', label: 'Long-haul: rank non-stop after connections when it costs', kind: 'number', unit: '% more' },
  { key: 'nonstopPremiumAmount', label: 'Long-haul: … or (whichever is less)', kind: 'number', unit: `${FARE_CURRENCY} more` },
];

/** Edit the flight rules; the ranking updates at once, no new searches needed. */
function RulesEditor({ rules, onChange }: { rules: FlightRules; onChange: (r: FlightRules) => void }) {
  const [draft, setDraft] = useState<FlightRules>(rules);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setDraft(rules), [rules]);
  const save = (next: FlightRules) => {
    setStatus('Saving…');
    saveFlightRules(next)
      .then((r) => {
        onChange(r);
        setStatus('Saved.');
      })
      .catch((e: Error) => setStatus(`Couldn’t save: ${e.message}`));
  };
  return (
    <details>
      <summary className="small">Flight rules</summary>
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {RULE_FIELDS.map((f) => (
          <label key={f.key} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 260 }}>{f.label}</span>
            {f.kind === 'checkbox' ? (
              <input type="checkbox" checked={Boolean(draft[f.key])} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })} />
            ) : (
              <input
                type={f.kind}
                value={String(draft[f.key])}
                min={f.kind === 'number' ? 0 : undefined}
                style={{ width: f.kind === 'time' ? 110 : 80 }}
                onChange={(e) => setDraft({ ...draft, [f.key]: f.kind === 'number' ? Number(e.target.value) : e.target.value })}
              />
            )}
            {f.unit && <span className="muted">{f.unit}</span>}
          </label>
        ))}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => save(draft)}>Save rules</button>
          <button type="button" className="link" onClick={() => save(DEFAULT_FLIGHT_RULES)}>Reset to defaults</button>
          {status && <span className="small muted">{status}</span>}
        </div>
      </div>
    </details>
  );
}

const savedTime = (ms: number) =>
  new Date(ms).toLocaleString('en-SG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Says when fares came from the database rather than straight from the provider. */
function SavedNote({ data }: { data: FareResult['data'] }) {
  if (!data.saved) return null;
  if (data.saved.stale) {
    return (
      <Notice kind="warn" title="Showing saved fares">
        <p>Live fares are unavailable right now, so these are the fares saved on {savedTime(data.saved.at)}. Departures that have already passed are left out.</p>
      </Notice>
    );
  }
  return <p className="small muted">Fares saved {savedTime(data.saved.at)}; refreshed from the provider every 6 hours.</p>;
}

function Sources({ data }: { data: FareResult['data'] }) {
  return (
    <p className="small">
      Provider: {data.provider} · Sources:{' '}
      {data.sources.map((s, i) => (
        <span key={s.url}>{i > 0 && ' · '}<a href={s.url} target="_blank" rel="noreferrer">{s.name}</a></span>
      ))}
    </p>
  );
}
