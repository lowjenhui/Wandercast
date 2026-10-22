import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Mascot } from './Brand';
import { CalendarPanel, useTripCalendar } from './CalendarPanel';
import { ItineraryEditor } from './Finalise';
import { savedPlace } from './SavedCompare';
import { RainLately, rainLatelyDue } from './RainLately';
import { AlertStrip, SafetyCard } from './SafetyCard';
import { Badge, SkeletonCard, type Tone } from './ui';
import { ratingTone, WeatherSection } from './WeatherSection';
import { LEVEL_LABEL, type PageLevel } from '../lib/advisory';
import { causewayAlert, datesIn } from '../lib/calendarAnalysis';
import { formatPrice } from '../lib/currency';
import { addDays, daysBetween, formatDate, todayISO } from '../lib/dates';
import { haversineKm } from '../lib/geo';
import {
  airAdvice,
  airFrom,
  aqiBand,
  aqiTone,
  countdown,
  dayLabel,
  forecastFrom,
  forecastSummary,
  legEnds,
  MODE_LABEL,
  modeIcon,
  packingFromForecast,
  psiFromPm25,
  stopDates,
  tripStage,
  tripTotal,
  weatherIcon,
  type AirDay,
  type ForecastDay,
  type Leg,
  type LookoutChange,
  type PlaceWatch,
} from '../lib/lookout';
import { safetyAt, useAdvisories } from '../services/advisories';
import { ferryText, landText, type Destination } from '../services/destinations';
import { gdacsHazards, type Hazard } from '../services/hazards';
import { bookRange, getLookout, markLookoutSeen, unbookRange, type LookoutData, type SavedDestination } from '../services/savedRanges';
import { nearestDestination, useDestinationData } from '../services/travelOptions';
import { useFxLines } from '../services/fx';
import type { Place, TripQuery } from '../types';
import { evaluateWeather, type Async, type WeatherResult } from '../useTripEvaluation';

const forecastTone: Record<string, Tone> = { Fine: 'good', Showery: 'warning', Wet: 'serious', Stormy: 'critical' };
const LEVEL_RANK: Record<PageLevel, number> = { all: 4, nonEssential: 3, unknown: 2, caution: 1, none: 0 };

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const when = (ms: number) => {
  const d = new Date(ms).toLocaleDateString('sv');
  const today = todayISO();
  return d === today ? 'today' : d === addDays(today, -1) ? 'yesterday' : formatDate(d);
};

/** The first day Google Events is searched for a stop (the start of the month before it). */
const eventsFrom = (start: string) => {
  const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};

/** One stop of the booked trip, with its dates and how you arrive. */
interface StopInfo {
  dest: SavedDestination;
  place: Place;
  arrive: string;
  leave: string;
  /** The trip days spent here (a travel day counts for the place you arrive at). */
  days: string[];
  nights: number;
  legIn: Leg;
  watch: PlaceWatch;
  query: TripQuery;
}

/**
 * Puff's Lookout: a booked trip after the tickets are bought, and the only page for it. A header
 * card (the trip, countdown, What Puff spotted beside Your trip), the summary cards, then the
 * forecast, the weather story, air quality, crowds & celebrations and getting there.
 * Day-by-day cards follow the itinerary; per-place cards switch between stops.
 */
export function Lookout({ rangeId, onChangedPlans }: { rangeId: number; onChangedPlans: () => void }) {
  const [data, setData] = useState<LookoutData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // What counts as new: changes after the previous visit (captured before this one is recorded).
  const seenRef = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    getLookout(rangeId)
      .then((d) => {
        if (!live) return;
        seenRef.current ??= d.booking?.seenAt ?? d.booking?.at ?? 0;
        setData(d);
        void markLookoutSeen(rangeId).catch(() => undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [rangeId, reload]);

  const stops: StopInfo[] = useMemo(() => {
    if (!data?.booking) return [];
    const it = data.booking.itinerary;
    const byId = new Map(data.dests.map((d) => [d.id, d]));
    return stopDates(it, data.range.start, data.range.end).flatMap((sd, i) => {
      const dest = byId.get(sd.destId);
      if (!dest || !sd.days.length) return [];
      const place = savedPlace(dest);
      return [
        {
          dest,
          place,
          arrive: sd.arrive,
          leave: sd.leave,
          days: sd.days,
          nights: it.stops[i].nights,
          legIn: it.legs[i] ?? { mode: null },
          watch: data.state.places?.[dest.id] ?? {},
          query: {
            place,
            destinationCode: dest.code,
            destinationLabel: dest.code ? `${dest.code}: ${dest.name}` : dest.name,
            startDate: sd.days[0],
            endDate: sd.days[sd.days.length - 1],
            bookedOn: data.range.booked_on ?? undefined,
            savedRef: { rangeId: data.range.id, destId: dest.id },
          },
        },
      ];
    });
  }, [data]);

  // The weather story for each stop (stored history; a stop's own dates), loaded one at a time.
  const [typical, setTypical] = useState<Record<number, Async<WeatherResult>>>({});
  const stopKey = stops.map((s) => `${s.dest.id}:${s.query.startDate}:${s.query.endDate}`).join('|');
  useEffect(() => {
    if (!stops.length) return;
    const ctrl = new AbortController();
    void (async () => {
      for (const s of stops) {
        setTypical((t) => ({ ...t, [s.dest.id]: { state: 'loading' } }));
        try {
          const w = await evaluateWeather(s.query, ctrl.signal);
          if (!ctrl.signal.aborted) setTypical((t) => ({ ...t, [s.dest.id]: { state: 'done', value: w } }));
        } catch (e) {
          if (!ctrl.signal.aborted) setTypical((t) => ({ ...t, [s.dest.id]: { state: 'error', message: (e as Error).message } }));
        }
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey]);

  const { ctx: advisories, error: advisoryError } = useAdvisories();
  const [hazards, setHazards] = useState<Hazard[]>([]);
  useEffect(() => {
    gdacsHazards.getActive().then(setHazards, () => setHazards([]));
  }, []);
  const destData = useDestinationData();

  if (error) {
    return (
      <section className="card">
        <h2>Puff’s Lookout</h2>
        <p className="small error-text">Couldn’t load this trip: {error}</p>
      </section>
    );
  }
  if (!data || !stops.length) return <SkeletonCard title="Puff is climbing the lookout…" note="Checking the forecast, air quality, events and travel advice for your trip." />;

  const seen = seenRef.current ?? 0;
  const isNew = (at: number) => at > seen;
  const today = todayISO();
  const multi = stops.length > 1;
  const typicalOf = (s: StopInfo) => {
    const t = typical[s.dest.id];
    return t?.state === 'done' ? t.value : null;
  };
  // The strictest MFA advice across the stops, for the summary card.
  const safeties = advisories ? stops.map((s) => ({ s, safety: safetyAt(advisories, { cc: s.dest.cc, lat: s.dest.lat, lon: s.dest.lon }, data.range.booked_on) })) : [];
  const worstSafety = safeties.slice().sort((a, b) => LEVEL_RANK[b.safety.advisory.level] - LEVEL_RANK[a.safety.advisory.level])[0] ?? null;
  const near = stops.flatMap((s) =>
    hazards
      .map((h) => ({ h, s, km: haversineKm(s.dest.lat, s.dest.lon, h.lat, h.lon) }))
      .filter(({ h, km }) => (h.kind === 'cyclone' ? km <= 800 : km <= 300)),
  );
  const inForecast = today >= forecastFrom(data.range.start);
  const rainDue = rainLatelyDue(data.range.start, data.range.end);

  return (
    <>
      <HeaderCard
        data={data}
        stops={stops}
        onChangedPlans={onChangedPlans}
        onSaved={() => setReload((n) => n + 1)}
        spotted={<Spotted data={data} stops={stops} isNew={isNew} typicalOf={typicalOf} safetyLabels={safeties.map(({ s, safety }) => ({ destId: s.dest.id, label: LEVEL_LABEL[safety.advisory.level] }))} />}
      />
      <SummaryRow data={data} stops={stops} typicalOf={typicalOf} safety={{ ctx: advisories, safety: worstSafety?.safety ?? null, error: advisoryError }} />
      <AlertStrip places={stops.map((s) => s.dest)} />
      {near.map(({ h, s, km }) => (
        <div key={`${h.id}-${s.dest.id}`} className="notice warn">
          <strong>{h.kind === 'cyclone' ? `Tropical cyclone ${h.name}` : h.kind === 'fire' ? 'Active wildfire nearby' : h.name}</strong>
          <span className="small">
            About {Math.round(km)} km from {s.dest.name} (GDACS {h.alert} alert). {h.url ? <a href={h.url} target="_blank" rel="noreferrer">Details</a> : null}
          </span>
        </div>
      ))}
      {/* Rain lately is the weather story's last section; once the story folds, it moves to the forecast card so it stays in view. */}
      {inForecast && (
        <ForecastCard
          data={data}
          stops={stops}
          isNew={isNew}
          typicalOf={typicalOf}
          rainLately={rainDue ? <RainLately embedded places={stops.map((s) => ({ key: String(s.dest.id), name: s.dest.name, lat: s.dest.lat, lon: s.dest.lon }))} /> : null}
        />
      )}
      <WeatherStory stops={stops} typical={typical} folded={inForecast} rainLately={rainDue && !inForecast} />
      <AirCard data={data} stops={stops} />
      <Crowds stops={stops} data={data} isNew={isNew} />
      <GettingThere data={data} stops={stops} destData={destData} />
      {data.booking && (
        <p className="small muted">
          Booked {data.range.booked_on ? formatDate(data.range.booked_on) : ''} · on Puff’s lookout since {formatDate(new Date(data.booking.at).toLocaleDateString('sv'))}. Forecast and air quality are checked every 3 hours, events weekly and MFA advice daily{multi ? ', for each stop over its own dates' : ''}.
        </p>
      )}
    </>
  );
}

/**
 * The header card: the trip, its countdown and Change plans, then What Puff spotted beside Your
 * trip (stacked on narrow screens). Puff appears here only: one Puff per page.
 */
function HeaderCard({
  data,
  stops,
  spotted,
  onChangedPlans,
  onSaved,
}: {
  data: LookoutData;
  stops: StopInfo[];
  spotted: ReactNode;
  onChangedPlans: () => void;
  onSaved: () => void;
}) {
  const { range } = data;
  const legs = data.booking?.itinerary.legs ?? [];
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // The itinerary editor needs the card's full width, so it replaces both columns while open.
  const [editing, setEditing] = useState(false);
  const countries = [...new Set(stops.map((s) => s.dest.country))];
  const fx = useFxLines([...new Set(stops.map((s) => s.dest.cc))]);
  const title = stops.length > 1 ? stops.map((s) => s.dest.name).join(' → ') : `${stops[0].dest.name}${stops[0].dest.country ? `, ${stops[0].dest.country}` : ''}`;
  const nights = daysBetween(range.start, range.end);
  return (
    <section className="card lookout-head" aria-labelledby="lookout-title">
      <div className="lookout-head-row">
        <Mascot mood="lookout" size={84} float={tripStage(range.start, range.end, todayISO()) === 'travelling'} />
        <div className="lookout-hero-text">
          <span className="lookout-kicker">Puff’s Lookout</span>
          <h2 id="lookout-title">{title}</h2>
          <span className="secondary">
            {formatDate(range.start)} – {formatDate(range.end)} · {nights} night{nights === 1 ? '' : 's'}
            {stops.length > 1 ? ` · ${countries.join(', ')}` : ''}
            {stops.length === 1 && legs[0]?.mode ? ` · ${modeIcon(legs[0].mode)} by ${MODE_LABEL[legs[0].mode].toLowerCase()}` : ''}
            {range.label ? ` · ${range.label}` : ''}
          </span>
          {fx.map((line) => (
            <span key={line} className="small secondary fx-line">{line}</span>
          ))}
        </div>
        <div className="lookout-hero-actions">
          <span className="countdown-pill">{countdown(range.start, range.end, todayISO())}</span>
          {confirm ? (
            <div className="saved-actions" role="group" aria-label="Confirm change of plans">
              <span className="small">Back to Daydream dates? Puff stops watching.</span>
              <button
                type="button"
                className="small danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void unbookRange(range.id).then(onChangedPlans, () => setBusy(false));
                }}
              >
                Change plans
              </button>
              <button type="button" className="small" onClick={() => setConfirm(false)}>Keep</button>
            </div>
          ) : (
            <button type="button" className="small" onClick={() => setConfirm(true)}>Change plans</button>
          )}
        </div>
      </div>
      {editing ? (
        <section className="lookout-head-edit" aria-labelledby="booking-edit-h">
          <h3 id="booking-edit-h">Your trip</h3>
          <ItineraryEditor
            itinerary={data.booking!.itinerary}
            places={stops.map((s) => ({ id: s.dest.id, name: s.dest.name, country: s.dest.country, lat: s.dest.lat, lon: s.dest.lon }))}
            start={range.start}
            end={range.end}
            bookedOn={range.booked_on}
            onCancel={() => setEditing(false)}
            onSave={async ({ itinerary, bookedOn }) => {
              await bookRange(range.id, { itinerary, booked_on: bookedOn });
              setEditing(false);
              onSaved();
            }}
          />
        </section>
      ) : (
        <div className="lookout-head-cols">
          {spotted}
          <YourTrip data={data} stops={stops} onEdit={() => setEditing(true)} />
        </div>
      )}
    </section>
  );
}

function allForecastDays(stops: StopInfo[]): { day: ForecastDay; stop: StopInfo }[] {
  return stops.flatMap((s) => (s.watch.forecast?.days ?? []).filter((d) => s.days.includes(d.date)).map((day) => ({ day, stop: s })));
}

function allAirDays(stops: StopInfo[]): { day: AirDay; stop: StopInfo }[] {
  return stops.flatMap((s) => (s.watch.air?.days ?? []).filter((d) => s.days.includes(d.date)).map((day) => ({ day, stop: s })));
}

function SummaryRow({
  data,
  stops,
  typicalOf,
  safety,
}: {
  data: LookoutData;
  stops: StopInfo[];
  typicalOf: (s: StopInfo) => WeatherResult | null;
  safety: { ctx: Parameters<typeof SafetyCard>[0]['ctx']; safety: Parameters<typeof SafetyCard>[0]['safety']; error: string | null };
}) {
  const fs = forecastSummary(allForecastDays(stops).map((x) => x.day));
  const air = allAirDays(stops).map((x) => x.day);
  const worst = air.length ? Math.max(...air.map((d) => d.aqi ?? 0)) : null;
  const typ = stops.map((s) => ({ s, a: typicalOf(s)?.analysis.suitability ?? null }));
  const first = typ[0]?.a;
  const airDue = todayISO() >= airFrom(data.range.start);
  return (
    <section className="summary" aria-label="Summary">
      <div className="card verdict">
        <span className="label">Weather outlook</span>
        <span className="value">
          {fs ? <Badge tone={forecastTone[fs.rating]}>{fs.rating}</Badge> : first ? <Badge tone={ratingTone[first.rating]}>{first.rating}</Badge> : <Badge tone="neutral">Loading…</Badge>}
        </span>
        <p className="small secondary">
          {fs
            ? `Forecast: ${fs.headline}`
            : stops.length > 1
              ? typ.map(({ s, a }) => `${s.dest.name}: ${a?.rating ?? '…'}`).join(' · ')
              : first
                ? `Typical for these dates: ${first.headline}`
                : ''}
        </p>
      </div>
      <div className="card verdict">
        <span className="label">Air quality</span>
        <span className="value">
          {worst !== null ? <Badge tone={aqiTone(worst)}>{aqiBand(worst)}</Badge> : <Badge tone="neutral">{airDue ? 'Not loaded yet' : `From ${formatDate(airFrom(data.range.start))}`}</Badge>}
        </span>
        <p className="small secondary">
          {worst !== null
            ? `AQI ${Math.min(...air.map((d) => d.aqi ?? worst))}–${worst} over ${air.length} day${air.length === 1 ? '' : 's'} of your trip.`
            : airDue
              ? 'The air-quality forecast covers your trip but hasn’t loaded yet; Puff tries again every few hours.'
              : 'The 5-day air-quality forecast starts covering your trip then.'}
        </p>
      </div>
      <SafetyCard ctx={safety.ctx} safety={safety.safety} error={safety.error} bookedOn={data.range.booked_on ?? undefined} places={stops.map((s) => s.dest)} />
    </section>
  );
}

function Spotted({
  data,
  stops,
  isNew,
  typicalOf,
  safetyLabels,
}: {
  data: LookoutData;
  stops: StopInfo[];
  isNew: (at: number) => boolean;
  typicalOf: (s: StopInfo) => WeatherResult | null;
  safetyLabels: { destId: number; label: string }[];
}) {
  const [all, setAll] = useState(false);
  const changes: LookoutChange[] = data.changes;
  const fresh = changes.filter((c) => isNew(c.at));
  const booked = data.booking?.at ?? 0;
  const multi = stops.length > 1;
  // "Since booking" comparisons with the analysis seen for each stop when booking.
  const since: string[] = [];
  for (const s of stops) {
    const b = data.baseline?.[s.dest.id];
    const nowDry = typicalOf(s)?.analysis.odds?.pMostlyDry;
    const who = multi ? `${s.dest.name}: ` : '';
    if (b?.weather?.pMostlyDry != null && nowDry != null && Math.abs(nowDry - b.weather.pMostlyDry) >= 0.05) {
      since.push(`${who}Chance of a mostly dry trip ${Math.round(b.weather.pMostlyDry * 100)}% → ${Math.round(nowDry * 100)}% since booking (El Niño / La Niña outlook and newer history).`);
    }
    const label = safetyLabels.find((x) => x.destId === s.dest.id)?.label;
    if (b?.advisory && label && b.advisory.level !== label) since.push(`${who}MFA advice was “${b.advisory.level}” when you booked; now “${label}”.`);
  }
  const shown = all ? changes : changes.slice(0, Math.max(5, fresh.length));
  return (
    <section className="lookout-head-sec" aria-labelledby="spotted-h">
      <div className="card-head">
        <h3 id="spotted-h">What Puff spotted</h3>
        {fresh.length > 0 ? <span className="new-pill">{fresh.length} new</span> : <Badge tone="good">Nothing new</Badge>}
      </div>
      {changes.length === 0 && since.length === 0 ? (
        <>
          <p className="small secondary">
            All quiet since you booked{data.range.booked_on ? ` (${formatDate(data.range.booked_on)})` : ''}
            {data.booking?.seenAt ? ' and since your last visit' : ''}.{lastChecked(data) ? ` Last checked ${ago(lastChecked(data)!)}.` : ''}
          </p>
          <ComingUp data={data} stops={stops} />
        </>
      ) : (
        <ul className="spotted-list">
          {shown.map((c) => (
            <li key={c.id} className={isNew(c.at) ? 'is-new' : undefined}>
              <span>
                {isNew(c.at) && <span className="new-pill">New</span>} {c.text}
              </span>
              <span className="small muted">{when(c.at)}</span>
            </li>
          ))}
          {since.map((t) => (
            <li key={t} className="since">
              <span>{t}</span>
              <span className="small muted">{when(booked)}</span>
            </li>
          ))}
        </ul>
      )}
      {changes.length > shown.length && (
        <button type="button" className="small" style={{ justifySelf: 'start' }} onClick={() => setAll(true)}>
          Show all {changes.length}
        </button>
      )}
      {(changes.length > 0 || since.length > 0) && (
        <p className="small muted">Changes since you booked{data.booking?.seenAt ? ` and since your last visit (${when(data.booking.seenAt)})` : ''}.</p>
      )}
    </section>
  );
}

/** The most recent check of anything Puff watches for this trip. */
function lastChecked(data: LookoutData): number | null {
  const st = data.state;
  const ats = [
    ...Object.values(st.places ?? {}).flatMap((p) => [p.forecast?.at, p.air?.at, p.events?.triedAt ?? p.events?.at]),
    ...Object.values(st.advisories ?? {}).map((a) => a.at),
  ].filter((x): x is number => typeof x === 'number' && x > 0);
  return ats.length ? Math.max(...ats) : null;
}

/** What Puff starts watching next, shown while nothing new has been spotted. Started items drop off. */
function ComingUp({ data, stops }: { data: LookoutData; stops: StopInfo[] }) {
  const today = todayISO();
  const items: { icon: string; when: string; what: string }[] = [];
  const waiting = stops.filter((s) => today < forecastFrom(s.arrive));
  if (waiting.length) {
    items.push({ icon: '🌦', when: `From ${dayLabel(forecastFrom(waiting[0].arrive)).slice(4)}`, what: `Daily forecast for ${waiting.map((s) => s.dest.name).join(', then ')}` });
  }
  if (today < airFrom(data.range.start)) items.push({ icon: '💨', when: `From ${dayLabel(airFrom(data.range.start)).slice(4)}`, what: 'Air-quality forecast' });
  if (data.eventsConfigured && today <= data.range.end) {
    const first = eventsFrom(stops[0].arrive);
    const last = Math.min(...stops.map((s) => s.watch.events?.at ?? Infinity));
    const next = today < first ? first : Number.isFinite(last) ? new Date(last + 7 * 86_400_000).toLocaleDateString('sv') : null;
    if (next) items.push({ icon: '🎉', when: next <= today ? 'Soon' : dayLabel(next), what: today < first ? 'Weekly checks for new events begin' : 'Next weekly check for new events' });
  }
  items.push({ icon: '🛡', when: 'Daily', what: 'MFA advice and FWD cover' });
  items.push({ icon: '⚠', when: 'Twice a day', what: 'US embassy and UK FCDO security alerts' });
  return (
    <>
      <h4 className="small lookout-subhead">Coming up on the lookout</h4>
      <ul className="lookout-lines small">
        {items.map((it) => (
          <li key={it.what}>
            <span aria-hidden>{it.icon}</span>
            <span className="lookout-when">{it.when}</span>
            <span>{it.what}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Your trip: one line per flight, drive or stay, in trip order. Details show only once added. */
function YourTrip({ data, stops, onEdit }: { data: LookoutData; stops: StopInfo[]; onEdit: () => void }) {
  const it = data.booking!.itinerary;
  const ends = legEnds(stops.map((s) => s.dest.name));
  const total = tripTotal(it);
  const missing = it.legs.some((l) => !l.mode);
  const times = (l: Leg) => (l.depart || l.arrive ? `${l.depart ?? '?'} → ${l.arrive ?? '?'}` : null);
  // Anything not filled in yet: one link instead of "not added" on every line.
  const incomplete = it.legs.some((l) => !l.price || !(l.depart || l.arrive)) || it.stops.some((st) => !st.stay?.name || !st.stay?.price);
  const extra = (parts: (string | null | undefined)[]) => {
    const t = parts.filter(Boolean).join(' · ');
    return t ? <span className="small secondary"> · {t}</span> : null;
  };
  return (
    <section className="lookout-head-sec" aria-labelledby="booking-h">
      <div className="card-head">
        <h3 id="booking-h">Your trip</h3>
        <button type="button" className="small" onClick={onEdit}>
          Edit
        </button>
      </div>
      {missing && (
        <p className="small tone-warning">
          Choose how you’re travelling ({ends.filter((_, i) => !it.legs[i]?.mode).map(([a, b]) => `${a} → ${b}`).join(', ')}) under Edit.
        </p>
      )}
      <ul className="lookout-lines">
        {ends.flatMap(([from, to], i) => {
          const l = it.legs[i] ?? { mode: null };
          const stop = stops[i];
          const stay = it.stops[i]?.stay;
          const rows = [
            <li key={`l-${i}`}>
              <span aria-hidden>{modeIcon(l.mode)}</span>
              <span className="lookout-when">{dayLabel(stop ? stop.arrive : data.range.end)}</span>
              <span>
                {from} → {to}
                {extra([l.mode ? MODE_LABEL[l.mode] : null, l.detail, times(l), l.price])}
              </span>
            </li>,
          ];
          if (stop) {
            rows.push(
              <li key={`s-${i}`}>
                <span aria-hidden>🏨</span>
                <span className="lookout-when">
                  {stop.nights} night{stop.nights === 1 ? '' : 's'}
                </span>
                <span>
                  {stop.dest.name}
                  {extra([stay?.name, stay?.price])}
                </span>
              </li>,
            );
          }
          return rows;
        })}
      </ul>
      <p className="small secondary">
        {total !== null ? (
          <>
            Trip total so far: <strong>{formatPrice(total)}</strong> ·{' '}
          </>
        ) : null}
        <span title="FWD covers MFA advisories issued after this date">Booked {data.range.booked_on ? formatDate(data.range.booked_on) : 'date not set'}</span>
        {incomplete && (
          <>
            {' · '}
            <button type="button" className="link-button small" onClick={onEdit}>
              + Add times, stays and prices
            </button>
          </>
        )}
      </p>
    </section>
  );
}

function ForecastCard({ data, stops, isNew, typicalOf, rainLately }: { data: LookoutData; stops: StopInfo[]; isNew: (at: number) => boolean; typicalOf: (s: StopInfo) => WeatherResult | null; rainLately?: React.ReactNode }) {
  const multi = stops.length > 1;
  const days = allForecastDays(stops);
  const byDate = new Map(days.map((x) => [x.day.date, x]));
  const fs = forecastSummary(days.map((x) => x.day));
  const at = Math.max(0, ...stops.map((s) => s.watch.forecast?.at ?? 0));
  const errors = stops.map((s) => s.watch.errors?.forecast).filter(Boolean);
  const legs = data.booking?.itinerary.legs ?? [];
  const stopOf = (date: string) => stops.find((s) => s.days.includes(date));
  // Forecast days mentioned in changes since the last visit get a ring.
  const changed = new Set(
    data.changes
      .filter((c) => c.kind === 'forecast' && isNew(c.at))
      .flatMap((c) => days.filter((x) => c.text.includes(dayLabel(x.day.date)) && (!multi || c.text.startsWith(`${x.stop.dest.name}:`))).map((x) => x.day.date)),
  );
  const packing = days.length ? packingFromForecast(days.map((x) => x.day)) : [];
  // Compared with typical: the share of wet days and the highs, weighted by days at each stop.
  const typ = stops.map((s) => ({ s, a: typicalOf(s)?.analysis ?? null }));
  const ready = typ.every((t) => t.a && t.a.wetDays.mean !== null && t.a.tMax.mean !== null);
  const total = stops.reduce((a, s) => a + s.days.length, 0);
  const wetShare = ready ? typ.reduce((a, t) => a + (t.a!.wetDays.mean! / t.a!.tripDays) * t.s.days.length, 0) / total : null;
  const typHigh = ready ? typ.reduce((a, t) => a + t.a!.tMax.mean! * t.s.days.length, 0) / total : null;

  return (
    <section className="card" aria-labelledby="lo-wx-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="lo-wx-h">The weather forecast</h2>
          <p className="small muted">
            {days.length
              ? `Open-Meteo daily forecast, updated ${ago(at)}.${days.length < total ? ' The rest of your days come into range day by day.' : ''}${multi ? ' Each day shows where you’ll be; a travel day shows the place you arrive at.' : ''}`
              : `The forecast covers your trip but hasn’t loaded yet (${errors[0] ? `last try: ${errors[0]}` : 'Puff tries again every few hours'}).`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {fs && <Badge tone={forecastTone[fs.rating]}>{fs.rating}</Badge>}
          <Badge tone="info">Forecast</Badge>
        </div>
      </div>
      {fs && <p>{fs.headline}</p>}
      <div className="tiles lookout-days">
        {datesIn(data.range.start, data.range.end).map((date) => {
          const x = byDate.get(date);
          const s = stopOf(date);
          const i = s ? stops.indexOf(s) : -1;
          const travel = s && s.arrive === date && i >= 0 ? modeIcon(legs[i]?.mode) : date === data.range.end ? modeIcon(legs[stops.length]?.mode) : null;
          const tag = multi && s ? <span className="city-tag">{s.dest.name}</span> : null;
          if (!x) {
            const from = date < todayISO() ? null : addDays(date, -15);
            return (
              <div key={date} className="tile muted-tile">
                {tag}
                <span className="k">
                  {dayLabel(date)} {travel && <span aria-hidden>{travel}</span>}
                </span>
                <span className="v">–</span>
                <span className="s">{from ? (from <= todayISO() ? 'Not loaded yet' : `Forecast from ${formatDate(from)}`) : 'Day has passed'}</span>
              </div>
            );
          }
          const d = x.day;
          const prob = d.precipProb;
          return (
            <div key={date} className={`tile${changed.has(date) ? ' changed' : ''}`}>
              {tag}
              <span className="k">
                {dayLabel(date)} <span aria-hidden>{weatherIcon(d.code)}</span> {travel && <span aria-hidden>· {travel}</span>} {changed.has(date) && <span className="new-pill">New</span>}
              </span>
              <span className="v">
                {d.tMax !== null ? `${Math.round(d.tMax)}°` : '–'} <span className="lo">/ {d.tMin !== null ? `${Math.round(d.tMin)}°` : '–'}</span>
              </span>
              <span className={`s${prob !== null && prob >= 60 ? ' tone-warning' : prob !== null && prob < 30 ? ' tone-good' : ''}`}>
                {prob !== null ? `${prob}% rain` : 'rain n/a'}
                {d.precipMm !== null ? ` · ${Math.round(d.precipMm)} mm` : ''}
              </span>
            </div>
          );
        })}
      </div>
      <div className="two-col">
        <div className="risk">
          <strong>Compared with typical</strong>
          <span className="small secondary">{days.length && wetShare !== null && typHigh !== null ? compareTypical(days.map((x) => x.day), wetShare, typHigh) : 'Loading typical weather…'}</span>
        </div>
        <div className="risk">
          <strong>Pack for it</strong>
          {packing.length ? <ul className="plain small secondary">{packing.map((p) => <li key={p}>{p}</li>)}</ul> : <span className="small secondary">Packing notes arrive with the forecast.</span>}
        </div>
      </div>
      {rainLately}
    </section>
  );
}

function compareTypical(days: ForecastDay[], wetShare: number, typHigh: number): string {
  const wetNow = days.filter((d) => (d.precipProb ?? 0) >= 50).length / days.length;
  const highs = days.map((d) => d.tMax).filter((x): x is number => x !== null);
  const hi = highs.length ? highs.reduce((x, y) => x + y, 0) / highs.length : null;
  const wetWord = wetNow > wetShare + 0.15 ? 'wetter than usual' : wetNow < wetShare - 0.15 ? 'drier than usual' : 'about as wet as usual';
  const hotWord = hi === null ? '' : hi > typHigh + 2 ? ', and warmer' : hi < typHigh - 2 ? ', and cooler' : '';
  return `Typical for these dates: ${Math.round(wetShare * 100)}% of days wet, highs around ${typHigh.toFixed(1)} °C. This forecast looks ${wetWord}${hotWord}.`;
}

function StopTabs({ stops, active, onPick, label }: { stops: StopInfo[]; active: number; onPick: (i: number) => void; label: string }) {
  if (stops.length < 2) return null;
  return (
    <div className="tabs stop-tabs" role="tablist" aria-label={label}>
      {stops.map((s, i) => (
        <button key={s.dest.id} type="button" role="tab" aria-selected={i === active} onClick={() => onPick(i)}>
          {s.dest.name} · {dayLabel(s.days[0]).slice(4)}–{dayLabel(s.days[s.days.length - 1]).slice(4)}
        </button>
      ))}
    </div>
  );
}

/** The trip analysis's weather story, per stop; folded under the forecast once it's in range. */
function WeatherStory({ stops, typical, folded, rainLately }: { stops: StopInfo[]; typical: Record<number, Async<WeatherResult>>; folded: boolean; rainLately: boolean }) {
  const [active, setActive] = useState(0);
  const s = stops[Math.min(active, stops.length - 1)];
  const body = (
    <>
      <StopTabs stops={stops} active={active} onPick={setActive} label="Weather story for" />
      <WeatherSection
        result={typical[s.dest.id] ?? { state: 'loading' }}
        mascot={false}
        rainLately={rainLately ? <RainLately key={s.dest.id} embedded places={[{ key: String(s.dest.id), name: s.dest.name, lat: s.dest.lat, lon: s.dest.lon }]} /> : null}
      />
    </>
  );
  if (!folded) return <div className="lookout-story">{body}</div>;
  return (
    <details className="card lookout-fold">
      <summary>
        <strong>Typical for these dates: the weather story</strong>
        <span className="small muted"> · odds, how it feels, rainfall around the trip, seasonal risks and last year</span>
      </summary>
      <div className="lookout-story">{body}</div>
    </details>
  );
}

function AirCard({ data, stops }: { data: LookoutData; stops: StopInfo[] }) {
  const multi = stops.length > 1;
  const days = allAirDays(stops);
  const worst = days.length ? Math.max(...days.map((x) => x.day.aqi ?? 0)) : null;
  const meanPm = days.length ? days.reduce((a, x) => a + (x.day.pm25 ?? 0), 0) / days.length : null;
  const psi = psiFromPm25(meanPm);
  const at = Math.max(0, ...stops.map((s) => s.watch.air?.at ?? 0));
  const due = todayISO() >= airFrom(data.range.start);
  const err = stops.map((s) => s.watch.errors?.air).find(Boolean);
  const nowStop = stops.find((s) => s.days.includes(todayISO()));
  const now = nowStop?.watch.air?.now;
  return (
    <section className="card" aria-labelledby="lo-air-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="lo-air-h">Air quality</h2>
          <p className="small muted">
            AQI on the US EPA scale from PM2.5 and PM10 (as aqicn.org headlines), CAMS forecast via Open-Meteo{at ? `, updated ${ago(at)}` : ''}
            {psi !== null ? ` · PSI ≈ ${psi}` : ''}.
          </p>
        </div>
        {worst !== null ? <Badge tone={aqiTone(worst)}>{aqiBand(worst)}</Badge> : <Badge tone="neutral">{due ? 'Not loaded yet' : `From ${formatDate(airFrom(data.range.start))}`}</Badge>}
      </div>
      {days.length > 0 ? (
        <>
          {now?.aqi != null && (
            <p>
              Right now{multi && nowStop ? ` in ${nowStop.dest.name}` : ''}: <strong>AQI {Math.round(now.aqi)}</strong> ({aqiBand(now.aqi)})
            </p>
          )}
          <div className="tiles lookout-days">
            {days.map(({ day: d, stop }) => (
              <div key={`${stop.dest.id}-${d.date}`} className="tile">
                {multi && <span className="city-tag">{stop.dest.name}</span>}
                <span className="k">{dayLabel(d.date)}</span>
                <span className={`v tone-${aqiTone(d.aqi)}`}>{d.aqi ?? '–'}</span>
                <span className="s">{aqiBand(d.aqi) ?? 'n/a'}</span>
              </div>
            ))}
          </div>
          <p className="small secondary">{airAdvice(days.map((x) => x.day))}</p>
        </>
      ) : (
        <p className="small secondary">
          {due
            ? `The air-quality forecast covers your trip but hasn’t loaded yet (${err ? `last try: ${err}` : 'Puff tries again every few hours'}).`
            : `The 5-day air-quality forecast starts covering your trip on ${formatDate(airFrom(data.range.start))}.`}{' '}
          Typical air quality for these dates will appear here once the air-quality layer is built.
        </p>
      )}
    </section>
  );
}

/** Crowds & celebrations as in the trip analysis, per stop, with events found on Google Events. */
function Crowds({ stops, data, isNew }: { stops: StopInfo[]; data: LookoutData; isNew: (at: number) => boolean }) {
  const [active, setActive] = useState(0);
  const s = stops[Math.min(active, stops.length - 1)];
  return <StopCrowds key={s.dest.id} stop={s} stops={stops} active={active} onPick={setActive} data={data} isNew={isNew} />;
}

function StopCrowds({ stop, stops, active, onPick, data, isNew }: { stop: StopInfo; stops: StopInfo[]; active: number; onPick: (i: number) => void; data: LookoutData; isNew: (at: number) => boolean }) {
  const start = stop.days[0];
  const end = stop.days[stop.days.length - 1];
  const cal = useTripCalendar(stop.dest.cc, start, end);
  const ev = stop.watch.events;
  const events = ev?.items ?? [];
  const note = !data.eventsConfigured
    ? 'Add a SerpApi key (SERPAPI_KEY) and Puff will look for concerts, festivals and exhibitions on your dates each week.'
    : ev?.error
      ? `Events couldn’t be checked: ${ev.error}`
      : !ev && todayISO() < eventsFrom(start)
        ? `Puff starts looking for events in ${stop.dest.name} on ${formatDate(eventsFrom(start))}, when Google lists them.`
        : `Events from Google Events (via SerpApi), checked weekly${ev?.at ? `, last ${ago(ev.at)}` : ''}.`;
  return (
    <CalendarPanel
      place={stop.place}
      start={start}
      end={end}
      variant="full"
      data={cal}
      headExtra={<StopTabs stops={stops} active={active} onPick={onPick} label="Crowds and celebrations for" />}
      extraRows={
        <>
          {events.length > 0 && (
            <div className="cal-list">
              {events.map((e) => (
                <div key={e.key} className="cal-row">
                  <div className="cal-date">{e.from === e.to ? formatDate(e.from) : `${formatDate(e.from)} – ${formatDate(e.to)}`}</div>
                  <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                    <div className="risk-head">
                      {isNew(e.firstSeen) && <span className="new-pill">New</span>}
                      <strong>{e.title}</strong>
                      <Badge tone="neutral">Event</Badge>
                    </div>
                    <div className="small secondary">
                      {[e.when, e.venue].filter(Boolean).join(' · ')}
                      {e.link && (
                        <>
                          {' · '}
                          <a href={e.link} target="_blank" rel="noreferrer">Details</a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="small muted">{note}</p>
        </>
      }
    />
  );
}

/** Each leg: the way you chose, what's known about it from Singapore, and your times and price. */
function GettingThere({ data, stops, destData }: { data: LookoutData; stops: StopInfo[]; destData: Destination[] | null }) {
  const legs = data.booking?.itinerary.legs ?? [];
  const ends = legEnds(stops.map((s) => s.dest.name));
  const first = stops[0];
  const cal = useTripCalendar(first.dest.cc, data.range.start, data.range.end);
  const roadLegs = [0, stops.length].filter((i) => legs[i]?.mode && legs[i].mode !== 'flight' && legs[i].mode !== 'ferry');
  const causeway = cal?.state === 'done' && roadLegs.length ? causewayAlert(cal.value, { start: data.range.start, end: data.range.end, overland: 'only' }) : null;
  const sgPeriods = cal?.state === 'done' ? cal.value.singapore : [];
  return (
    <section className="card" aria-labelledby="lo-get-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="lo-get-h">Getting there</h2>
          <p className="small muted">How you’re travelling each leg, with what Wandercast knows about the routes from Singapore.</p>
        </div>
      </div>
      {causeway && <p className={`small ${causeway.level === 'high' ? 'tone-critical' : 'tone-warning'}`}>{causeway.text}</p>}
      <div className="cal-list">
        {ends.map(([from, to], i) => {
          const l = legs[i] ?? { mode: null };
          const sgEnd = i === 0 ? stops[0] : i === stops.length ? stops[stops.length - 1] : null;
          const d = sgEnd && destData ? nearestDestination(destData, sgEnd.dest.lat, sgEnd.dest.lon) : null;
          const date = i < stops.length ? stops[i].arrive : data.range.end;
          const known =
            l.mode === 'ferry' && d?.ferry
              ? `${ferryText(d.ferry)} from ${d.ferry.terminal} to ${d.ferry.ports}.${d.ferry.operators.length ? ` Operators: ${d.ferry.operators.join(', ')}.` : ''}${d.ferry.notes ? ` ${d.ferry.notes}` : ''}`
              : l.mode && l.mode !== 'flight' && l.mode !== 'ferry' && d?.land
                ? `${landText(d.land)} from ${d.land.from}, including the checkpoint.${d.land.operators.length ? ` Operators include ${d.land.operators.join(', ')}.` : ''}${d.land.notes ? ` ${d.land.notes}` : ''}`
                : l.mode === 'flight' && i === 0 && new Date(`${date}T00:00:00Z`).getUTCDay() === 5
                  ? 'Friday departures meet Changi’s evening peak: allow extra time for check-in and immigration.'
                  : null;
          return (
            <div key={`g-${i}`} className="cal-row">
              <div className="cal-date">{formatDate(date)}</div>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <div className="risk-head">
                  <strong>
                    {modeIcon(l.mode)} {from} → {to}
                  </strong>
                  {l.mode ? <Badge tone="info">{MODE_LABEL[l.mode]}</Badge> : <Badge tone="warning">Way not chosen</Badge>}
                </div>
                {(l.detail || l.depart || l.arrive || l.price) && (
                  <div className="small">{[l.detail, l.depart || l.arrive ? `${l.depart ?? '?'} → ${l.arrive ?? '?'}` : null, l.price].filter(Boolean).join(' · ')}</div>
                )}
                {known && <div className="small secondary">{known}</div>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="risk">
        <strong>Singapore public holidays (departure side)</strong>
        <span className="small muted">Long weekends in Singapore fill outbound flights, ferries and the causeway.</span>
        {sgPeriods.length === 0 ? (
          <span className="small secondary">{cal?.state === 'done' ? 'No Singapore public holidays around your dates.' : 'Loading…'}</span>
        ) : (
          sgPeriods.map((p) => (
            <span key={p.start} className="small">
              <strong>{p.name}</strong>: {formatDate(p.start)} – {formatDate(p.end)} ({p.days} days)
            </span>
          ))
        )}
      </div>
    </section>
  );
}
