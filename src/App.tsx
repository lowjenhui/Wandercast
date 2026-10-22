import { FlightSection, valueTone } from './components/FlightSection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SearchForm, type Prefill } from './components/SearchForm';
import { Suggestions } from './components/Suggestions';
import { Logo, Mascot } from './components/Brand';
import { SavedDates } from './components/SavedDates';
import { savedPlace } from './components/SavedCompare';
import { addSavedDestination, bookRange, listSavedRanges, putSnapshot, saveRange, type SavedRange, type TripSnapshot } from './services/savedRanges';
import { FinaliseForm } from './components/Finalise';
import { useFxLines } from './services/fx';
import type { Itinerary } from './lib/lookout';
import { Lookout } from './components/Lookout';
import { setArchiveRange } from './services/http';
import { LEVEL_LABEL } from './lib/advisory';
import { CalendarPanel, ChinaHolidayBanner, useTripCalendar } from './components/CalendarPanel';
import { buildCalendarItems, crowdAlerts } from './lib/calendarAnalysis';
import type { Place } from './types';
import { WorldWeatherMap } from './components/WorldWeatherMap';
import { BestTime, type WhenTarget } from './components/BestTime';
import { WeatherLibrary } from './components/WeatherLibrary';
import { nearestAirports } from './services/airports';
import type { LibraryPlace } from './services/library';
import { MAX_TRIP_DAYS, MIN_TRIP_DAYS } from './lib/bestTime';
import { Badge, Notice, type Tone } from './components/ui';
import { RainLately, rainLatelyDue } from './components/RainLately';
import { ratingTone, WeatherSection } from './components/WeatherSection';
import { concludeTrip } from './lib/conclusion';
import { AlertStrip, SafetyCard } from './components/SafetyCard';
import { safetyAt, useAdvisories } from './services/advisories';
import { addDays, daysBetween, formatDate, todayISO } from './lib/dates';
import { destinationId, destinationPlace, landOnly, loadDestinations, loadFerryDestinations, type Destination, type FerryData } from './services/destinations';
import { haversineKm } from './lib/geo';
import { useTripEvaluation, type Async, type FareResult, type WeatherResult } from './useTripEvaluation';
import type { TripQuery } from './types';

export default function App() {
  const { query, weather, fares, run } = useTripEvaluation();
  const busy = weather.state === 'loading' || fares.state === 'loading';
  const [start, setStart] = useState(() => addDays(todayISO(), 30));
  const [end, setEnd] = useState(() => addDays(todayISO(), 36));
  // The range the map and suggestions use. It's separate from the form's (prefilled) dates, so
  // nothing is loaded until you search or pick a daydream date. Until then it shows your first
  // upcoming daydream date, if any; nothing is remembered across reloads.
  const [mapRange, setMapRange] = useState<{ start: string; end: string; label?: string; auto?: boolean } | null>(null);
  // The daydream date in use: its dates fill the search form, the map and Sunny picks.
  const [activeRange, setActiveRange] = useState<SavedRange | null>(null);
  // Set once you search or pick dates, so the on-load default never overrides you.
  const userActed = useRef(false);
  const applyRange = (r: SavedRange, opts: { auto?: boolean; quiet?: boolean } = {}) => {
    if (!opts.auto) userActed.current = true;
    setStart(r.start);
    setEnd(r.end);
    setActiveRange(r);
    if (!opts.auto) setDateMode('fixed');
    setMapRange({ start: r.start, end: r.end, label: r.label || 'Daydream dates', auto: opts.auto });
    if (!opts.auto && !opts.quiet) setMode((m) => (m === 'trip' ? m : 'suggest'));
  };
  // On load, use the first upcoming daydream date (if any) instead of the autofilled week.
  useEffect(() => {
    const today = todayISO();
    listSavedRanges()
      .then((rs) => {
        // Booked trips live on Puff's Lookout, not the planner's map.
        const next = rs.filter((r) => r.end >= today && !r.booking).sort((a, b) => a.start.localeCompare(b.start))[0];
        if (next && !userActed.current) applyRange(next, { auto: true });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [mode, setMode] = useState<'home' | 'suggest' | 'trip' | 'when' | 'library' | 'lookout'>('home');
  // Puff's Lookout: the booked range on show.
  const [lookoutId, setLookoutId] = useState<number | null>(null);
  // A booked trip that the analysis on screen belongs to (its Lookout replaces the analysis).
  const [bookedMatch, setBookedMatch] = useState<SavedRange | null>(null);
  useEffect(() => {
    setBookedMatch(null);
    if (mode !== 'trip' || !query || query.archive) return;
    let live = true;
    listSavedRanges()
      .then((rs) => {
        const hit = rs.find(
          (r) =>
            r.booking &&
            !r.archived &&
            query.startDate >= r.start &&
            query.endDate <= r.end &&
            r.booking.itinerary.stops.some((st) => {
              const d = r.destinations?.find((x) => x.id === st.destId);
              return d && haversineKm(d.lat, d.lon, query.place.latitude, query.place.longitude) < 25;
            }),
        );
        if (live) setBookedMatch(hit ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mode, query]);
  const openLookout = (id: number) => {
    setLookoutId(id);
    setMode('lookout');
    window.scrollTo({ top: 0 });
  };
  // Sunny windows ("When to go"): the place being searched, its trip length, and whether the analysis came from it.
  const [whenTarget, setWhenTarget] = useState<WhenTarget | null>(null);
  const [whenDays, setWhenDays] = useState(7);
  const [tripFromWhen, setTripFromWhen] = useState(false);
  // The search bar's dates: exact (My dates) or a trip length for Sunny windows.
  const [dateMode, setDateMode] = useState<'fixed' | 'flexible'>('fixed');
  const clampDays = (n: number) => (n >= MIN_TRIP_DAYS && n <= MAX_TRIP_DAYS ? n : 7);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [formPlace, setFormPlace] = useState<Place | null>(null);
  // Holidays & events: one for the destination chosen in the form, one for the analysed trip.
  const formCal = useTripCalendar(formPlace?.countryCode, start, end);
  const tripCal = useTripCalendar(query?.place.countryCode, query?.startDate ?? '', query?.endDate ?? '');

  const [ferries, setFerries] = useState<FerryData | null>(null);
  // "Via places" (Hoi An via Da Nang…) on the map and in suggestions; off on every page load.
  const [showVia, setShowVia] = useState(false);
  const [showAdvisories, setShowAdvisories] = useState(true);
  const [landDests, setLandDests] = useState<Destination[]>([]);
  useEffect(() => {
    loadFerryDestinations().then(setFerries).catch(() => setFerries(null));
    loadDestinations()
      .then((ds) => setLandDests(ds.filter((d) => d.land)))
      .catch(() => setLandDests([]));
  }, []);

  const evaluate = (q0: TripQuery) => {
    userActed.current = true;
    // A past trip leaves the planner's map on its current dates.
    if (!q0.archive) setMapRange({ start: q0.startDate, end: q0.endDate, label: activeRange && activeRange.start === q0.startDate && activeRange.end === q0.endDate ? activeRange.label || undefined : undefined });
    // A destination within 25 km of a ferry port (typed or suggested) is treated as a ferry trip.
    const f = ferries?.destinations.find((x) => haversineKm(x.lat, x.lon, q0.place.latitude, q0.place.longitude) < 25);
    const q1: TripQuery = f
      ? { ...q0, ferry: { name: f.name, terminal: f.terminal, ports: f.ports, minutes: f.minutes, operators: f.operators, notes: f.notes, sources: ferries!.sources } }
      : q0;
    // Likewise within 25 km of an overland place: add the coach / bus / train option.
    const l = landDests.find((x) => haversineKm(x.lat, x.lon, q0.place.latitude, q0.place.longitude) < 25);
    const q: TripQuery = l?.land
      ? { ...q1, land: { name: l.name, ...l.land, only: landOnly(l) } }
      : q1;
    run(q);
    setTripFromWhen(false);
    setDateMode('fixed');
    setMode('trip');
  };

  /** Opens Sunny windows for a place and switches the search bar to match. */
  const openWhen = (t: WhenTarget, days: number) => {
    setWhenTarget(t);
    setWhenDays(clampDays(days));
    setDateMode('flexible');
    setPrefill({ place: t.place, code: t.destinationCode, nonce: Date.now() });
    setMode('when');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const analyseWhen = (s: string, e: string) => {
    if (!whenTarget) return;
    userActed.current = true;
    setStart(s);
    setEnd(e);
    setActiveRange(null);
    setPrefill({ place: whenTarget.place, code: whenTarget.destinationCode, nonce: Date.now() });
    evaluate({ ...whenTarget, startDate: s, endDate: e });
    setTripFromWhen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Opens Sunny windows for a ready library place; its fare code comes from the nearest airport if unknown. */
  const whenFromLibrary = async (p: LibraryPlace) => {
    const code = p.code ?? (await nearestAirports(p.lat, p.lon).catch(() => []))[0]?.cityCode ?? '';
    const place: Place = { id: `lib:${p.lat},${p.lon}`, name: p.name, country: p.country, countryCode: p.cc, latitude: p.lat, longitude: p.lon };
    openWhen({ place, destinationCode: code, destinationLabel: code ? `${code}: ${p.name}` : p.name }, whenDays);
  };

  const whenFromDestination = (d: Destination) => {
    const place = destinationPlace(d);
    const days = dateMode === 'flexible' || mode === 'when' ? whenDays : daysBetween(start, end) + 1;
    openWhen({ place, destinationCode: d.code, destinationLabel: `${d.code}: ${d.name}`, via: d.via ? { code: d.via.code, name: d.via.name, minutes: d.via.minutes, mode: d.via.mode } : undefined }, days);
  };

  /** Analyses a destination for the given dates (the map's), or the dates the map and picks show. */
  const analyseDestination = (d: Destination, dates?: { start: string; end: string }) => {
    const place = destinationPlace(d);
    const r = dates ?? mapRange ?? { start, end };
    setStart(r.start);
    setEnd(r.end);
    setPrefill({ place, code: d.code, nonce: Date.now() });
    evaluate({
      place,
      destinationCode: d.code,
      destinationLabel: `${d.code}: ${d.name}`,
      startDate: r.start,
      endDate: r.end,
      via: d.via ? { code: d.via.code, name: d.via.name, minutes: d.via.minutes, mode: d.via.mode } : undefined,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const datesValid = Boolean(start && end && start <= end);
  const plannable = datesValid && daysBetween(start, end) < 60;
  const mapPlannable = Boolean(mapRange && daysBetween(mapRange.start, mapRange.end) < 60);
  // Planner linking: hovering a suggestion highlights it on the map; clicking zooms there.
  const [hovered, setHovered] = useState<Destination | null>(null);
  const [focusReq, setFocusReq] = useState<{ dest: Destination; nonce: number } | null>(null);
  // The destination selected in Sunny picks or pinned on the map (its card expands).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onMapSelect = useCallback((d: Destination | null) => setSelectedId(d ? destinationId(d) : null), []);
  const [plannerMode, setPlannerMode] = useState<'home' | 'suggest'>('home');
  // The search bar's real height, so sticky bars and the map sit just below it.
  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Desktop planner: the side and map columns scroll on their own; a fade marks more below.
  const planner = !(mode === 'library' || (mode === 'when' && whenTarget) || (mode === 'trip' && query) || (mode === 'lookout' && lookoutId !== null));
  const sideRef = useRef<HTMLElement>(null);
  const mapColRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const panes = [sideRef.current, mapColRef.current].filter((el): el is HTMLElement => el !== null);
    const update = () => panes.forEach((el) => el.toggleAttribute('data-more', el.scrollHeight - el.scrollTop - el.clientHeight > 4));
    update();
    panes.forEach((el) => el.addEventListener('scroll', update, { passive: true }));
    const ro = new ResizeObserver(update);
    panes.forEach((el) => {
      ro.observe(el);
      [...el.children].forEach((c) => ro.observe(c));
    });
    return () => {
      panes.forEach((el) => el.removeEventListener('scroll', update));
      ro.disconnect();
    };
  }, [planner, mode]);

  const goHome = () => {
    setMode('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goBack = (to: typeof mode) => {
    setMode(to);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (mode === 'home' || mode === 'suggest') setPlannerMode(mode);
  }, [mode]);
  // Stored-data-only requests apply just while a past trip's analysis is on screen.
  useEffect(() => {
    setArchiveRange(mode === 'trip' && query?.archive ? query.archive.rangeId : null);
  }, [mode, query]);

  return (
    <div className={`shell${planner ? ' planner-mode' : ''}`}>
      <header className="topbar" ref={topbarRef}>
        <div className="brand">
          {/* Logo and name both go to the home map (keeping the form, dates and suggestions); the name is the focusable link. */}
          <button type="button" className="brand-home brand-home-logo" tabIndex={-1} aria-hidden onClick={goHome} title="Wandercast home">
            <Logo />
          </button>
          <div>
            <button type="button" className="brand-home brand-name" onClick={goHome} title="Wandercast home" aria-label="Wandercast home">
              Wandercast
            </button>
            <div className="brand-tag">your wanderlust forecast</div>
            <button type="button" className="link-button small library-link" onClick={() => (setMode('library'), window.scrollTo({ top: 0 }))}>
              📚 Weather library
            </button>
          </div>
        </div>
        <SearchForm
          onSubmit={evaluate}
          onFindDestinations={() => {
            userActed.current = true;
            setMapRange({ start, end, label: activeRange ? activeRange.label || 'Daydream dates' : undefined });
            setMode('suggest');
          }}
          busy={busy}
          start={start}
          end={end}
          onDatesChange={(s, e) => {
            setStart(s);
            setEnd(e);
            // Typing other dates leaves the daydream date ("Custom dates").
            if (activeRange && (s !== activeRange.start || e !== activeRange.end)) setActiveRange(null);
          }}
          datesNote={activeRange ? `★ ${activeRange.label || 'Daydream dates'}` : 'Custom dates'}
          bookedOnDefault={activeRange?.booked_on ?? null}
          prefill={prefill}
          onPlaceChange={setFormPlace}
          dateMode={dateMode}
          onDateModeChange={(m) => {
            if (m === 'flexible' && mode !== 'when') setWhenDays(clampDays(daysBetween(start, end) + 1));
            setDateMode(m);
          }}
          tripDays={whenDays}
          onTripDaysChange={setWhenDays}
          onFindBestDates={(t) => openWhen(t, whenDays)}
        />
      </header>

      {mode === 'library' ? (
        <main className="page">
          <BackBar label="← Back to planner" onBack={() => goBack(plannerMode)} context="📚 Weather library" />
          <WeatherLibrary onOpen={(p) => void whenFromLibrary(p)} />
        </main>
      ) : mode === 'when' && whenTarget ? (
        <main className="page">
          <BackBar
            label="← Back to planner"
            onBack={() => goBack(plannerMode)}
            context={`☀ Sunny windows · ${whenTarget.place.name}${whenTarget.place.country ? `, ${whenTarget.place.country}` : ''} · ${whenDays}-day trips`}
          />
          <BestTime target={whenTarget} tripDays={whenDays} onTripDaysChange={setWhenDays} onAnalyse={analyseWhen} />
        </main>
      ) : mode === 'lookout' && lookoutId !== null ? (
        <main className="page">
          <BackBar label="← Back to planner" onBack={() => goBack(plannerMode)} context="🔭 Puff’s Lookout" />
          <Lookout key={lookoutId} rangeId={lookoutId} onChangedPlans={() => goBack(plannerMode)} />
        </main>
      ) : mode === 'trip' && query ? (
        <main className="page">
          <BackBar
            label={tripFromWhen && whenTarget ? `← Back to Sunny windows: ${whenTarget.place.name}` : '← Back to planner'}
            onBack={() => goBack(tripFromWhen && whenTarget ? 'when' : plannerMode)}
            context={`${query.archive ? '🗄 Past trip · ' : ''}${query.place.name}${query.place.country ? `, ${query.place.country}` : ''} · ${formatDate(query.startDate)} – ${formatDate(query.endDate)}`}
          />
          {bookedMatch && (
            <Notice kind="info" title="You’ve booked this trip">
              <p>
                Puff’s Lookout keeps the forecast, air quality, events and this analysis together for it.{' '}
                <button type="button" className="small primary" onClick={() => openLookout(bookedMatch.id)}>
                  Open Puff’s Lookout
                </button>
              </p>
            </Notice>
          )}
          {query.archive && (
            <Notice kind="info" title={`Past trip${query.archive.label ? `: ${query.archive.label}` : ''}`}>
              <p>Shown from data saved before the trip: fares as last seen while it was upcoming, and stored weather history. Nothing is fetched again, so sections with nothing saved say so.</p>
            </Notice>
          )}
          <Summary
            query={query}
            weather={weather}
            fares={fares}
            calendar={tripCal}
            onSnapshot={query.savedRef && !query.archive ? (snap) => void putSnapshot(query.savedRef!.rangeId, query.savedRef!.destId, snap).catch(() => undefined) : undefined}
            onWhenToGo={() => openWhen({ place: query.place, destinationCode: query.destinationCode, destinationLabel: query.destinationLabel, via: query.via }, daysBetween(query.startDate, query.endDate) + 1)}
            onBook={query.archive || bookedMatch ? undefined : async (b, snap) => openLookout(await bookFromAnalysis(query, b, snap))}
          />
          <WeatherSection
            result={weather}
            rainLately={
              !query.archive && rainLatelyDue(query.startDate, query.endDate) ? (
                <RainLately embedded places={[{ key: 'trip', name: query.place.name, lat: query.place.latitude, lon: query.place.longitude }]} />
              ) : null
            }
          />
          <CalendarPanel place={query.place} start={query.startDate} end={query.endDate} variant="full" data={tripCal} overland={query.land ? (query.land.only ? 'only' : 'also') : undefined} />
          <FlightSection result={fares} query={query} onDates={query.archive ? undefined : (startDate, endDate) => evaluate({ ...query, startDate, endDate, savedRef: undefined })} />
          {!query.archive && <WorldWeatherMap
            start={query.startDate}
            end={query.endDate}
            initialView="dates"
            focus={{ lat: query.place.latitude, lon: query.place.longitude, name: query.place.name }}
            onAnalyse={analyseDestination}
            onWhenToGo={whenFromDestination}
            showVia={showVia}
            onShowViaChange={setShowVia}
            showAdvisories={showAdvisories}
            onShowAdvisoriesChange={setShowAdvisories}
          />}
        </main>
      ) : (
        <main className="planner">
          <aside className="planner-side pane" aria-label="Planning" ref={sideRef}>
            <SavedDates
              start={start}
              end={end}
              activeId={activeRange?.id ?? null}
              onPick={(r, opts) => applyRange(r, { quiet: opts?.quiet })}
              onRemoved={(id) => activeRange?.id === id && setActiveRange(null)}
              onOpenDestination={(d, r) => {
                const place = savedPlace(d);
                setStart(r.start);
                setEnd(r.end);
                setActiveRange(r);
                setPrefill({ place, code: d.code, nonce: Date.now() });
                evaluate({ place, destinationCode: d.code, destinationLabel: `${d.code}: ${d.name}`, startDate: r.start, endDate: r.end, savedRef: { rangeId: r.id, destId: d.id } });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onOpenLookout={(r) => openLookout(r.id)}
              onOpenArchived={(d, r) => {
                evaluate({
                  place: savedPlace(d),
                  destinationCode: d.code,
                  destinationLabel: `${d.code}: ${d.name}`,
                  startDate: r.start,
                  endDate: r.end,
                  bookedOn: r.booked_on ?? undefined,
                  archive: { rangeId: r.id, label: r.label, asOf: r.start },
                });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
            {datesValid && <ChinaHolidayBanner start={start} end={end} />}
            {formPlace && <CalendarPanel place={formPlace} start={start} end={end} variant="preview" data={formCal} />}
            {mode === 'suggest' && mapRange && mapPlannable ? (
              <Suggestions
                start={mapRange.start}
                end={mapRange.end}
                onAnalyse={analyseDestination}
                onHover={setHovered}
                onSelect={(d) => (setFocusReq({ dest: d, nonce: Date.now() }), setSelectedId(destinationId(d)))}
                selectedCode={selectedId}
                onWhenToGo={whenFromDestination}
                showVia={showVia}
              />
            ) : (
              <StartCard
                canSuggest={plannable}
                onSuggest={() => {
                  userActed.current = true;
                  setMapRange({ start, end, label: activeRange ? activeRange.label || 'Daydream dates' : undefined });
                  setMode('suggest');
                }}
              />
            )}
          </aside>
          <section className="planner-map pane" aria-label="Map" ref={mapColRef}>
            <WorldWeatherMap
              start={mapRange?.start}
              end={mapRange?.end}
              datesLabel={mapRange?.label}
              initialView={mapRange && !mapRange.auto ? 'dates' : 'now'}
              onAnalyse={analyseDestination}
              onWhenToGo={whenFromDestination}
              onSelectDest={onMapSelect}
              highlight={hovered}
              focusRequest={focusReq}
              showVia={showVia}
              onShowViaChange={setShowVia}
              showAdvisories={showAdvisories}
              onShowAdvisoriesChange={setShowAdvisories}
            />
            <Footer />
          </section>
        </main>
      )}

      {!planner && <Footer />}
    </div>
  );
}

/**
 * Books the analysed trip: finds (or saves) its dates under Daydream dates and its destination
 * on them, then marks it as booked. Returns the range id for Puff's Lookout.
 */
async function bookFromAnalysis(q: TripQuery, b: { itinerary: Itinerary; bookedOn: string }, snap: TripSnapshot | null): Promise<number> {
  const ranges = await listSavedRanges();
  let r = ranges.find((x) => x.start === q.startDate && x.end === q.endDate && !x.archived);
  r ??= await saveRange({ label: q.place.name, start: q.startDate, end: q.endDate, booked_on: b.bookedOn });
  const near = (r.destinations ?? []).find((d) => Math.hypot(d.lat - q.place.latitude, (d.lon - q.place.longitude) * Math.cos((q.place.latitude * Math.PI) / 180)) < 0.15);
  const dest =
    near ??
    (await addSavedDestination(r.id, {
      name: q.place.name,
      admin1: q.place.admin1,
      country: q.place.country,
      cc: q.place.countryCode,
      lat: q.place.latitude,
      lon: q.place.longitude,
      code: q.destinationCode,
    }));
  // One place: the form's stop stands in for the destination saved here.
  const itinerary: Itinerary = { stops: [{ destId: dest.id, nights: daysBetween(q.startDate, q.endDate) }], legs: b.itinerary.legs };
  await bookRange(r.id, { itinerary, booked_on: b.bookedOn, baseline: { [dest.id]: snap } });
  return r.id;
}

function Footer() {
  return (
    <footer className="footer small muted">
      Wandercast is an information tool. Historical averages are not forecasts, and cached fares are not quotes. Weather data:{' '}
      <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> (ERA5, CC BY 4.0). Fares:{' '}
      <a href="https://www.travelpayouts.com/" target="_blank" rel="noreferrer">Travelpayouts</a>. Exchange rates:{' '}
      <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">Rates by ExchangeRate-API</a>.
    </footer>
  );
}

/** Back control that stays under the search bar while the page scrolls, with what's being viewed. */
function BackBar({ label, onBack, context }: { label: string; onBack: () => void; context: string }) {
  return (
    <nav className="back-bar" aria-label="Page">
      <button type="button" className="link-button back-link" onClick={onBack}>{label}</button>
      <span className="small muted back-context">{context}</span>
    </nav>
  );
}

/** Shown in the side panel before suggestions are requested. */
function StartCard({ canSuggest, onSuggest }: { canSuggest: boolean; onSuggest: () => void }) {
  return (
    <section className="panel-section start-card">
      <div className="mascot-row">
        <Mascot mood="happy" size={84} />
        <div>
          <h2>Where shall we wander?</h2>
          <p className="small muted">Find somewhere sunny for your dates, from Singapore.</p>
        </div>
      </div>
      <ol className="steps">
        <li><strong>Pick your dates</strong> in the bar above, or choose saved dates.</li>
        <li><strong>Compare places</strong>: the map shows the weather for your dates; get a ranked list of destinations.</li>
        <li><strong>Analyse one</strong> for 10-year weather history, holidays and fares.</li>
      </ol>
      <button type="button" className="primary" onClick={onSuggest} disabled={!canSuggest} title={canSuggest ? undefined : 'Choose dates of 60 days or fewer'}>
        Suggest destinations for these dates
      </button>
      <p className="small muted">Or type a destination above to analyse it directly.</p>
    </section>
  );
}

function Summary({
  query,
  weather,
  fares,
  calendar,
  onWhenToGo,
  onSnapshot,
  onBook,
}: {
  query: TripQuery;
  weather: Async<WeatherResult>;
  fares: Async<FareResult>;
  calendar: ReturnType<typeof useTripCalendar>;
  onWhenToGo: () => void;
  /** Called once per query when everything has loaded, with a summary to keep for past trips. */
  onSnapshot?: (s: TripSnapshot) => void;
  /** "I've booked this": marks the trip as booked (with the summary seen now as its baseline). */
  onBook?: (b: { itinerary: Itinerary; bookedOn: string }, snap: TripSnapshot | null) => Promise<void>;
}) {
  const [booking, setBooking] = useState(false);
  const fx = useFxLines(query.place.countryCode ? [query.place.countryCode] : []);
  const alerts =
    calendar?.state === 'done'
      ? crowdAlerts(
          calendar.value,
          buildCalendarItems(calendar.value, query.startDate, query.endDate, { lat: query.place.latitude, lon: query.place.longitude }),
          query.place.name,
          query.land ? { start: query.startDate, end: query.endDate, overland: query.land.only ? 'only' : 'also' } : undefined,
        )
      : [];
  const wa = weather.state === 'done' ? weather.value.analysis : null;
  const fa = fares.state === 'done' ? fares.value.assessment : null;
  const loading = weather.state === 'loading' || fares.state === 'loading';
  const { ctx: advisories, error: advisoryError } = useAdvisories();
  const safety = advisories ? safetyAt(advisories, { cc: query.place.countryCode, lat: query.place.latitude, lon: query.place.longitude }, query.bookedOn ?? null) : null;
  const conclusion = loading
    ? null
    : concludeTrip(wa, fa, safety, fares.state === 'done' && (fares.value.data.status === 'ferry' || fares.value.data.status === 'land') ? fares.value.data.status : null);

  // Once weather, fares, crowds and advisories have all settled, hand over a summary (once per query).
  const sentFor = useRef<TripQuery | null>(null);
  const settled = !loading && calendar?.state !== 'loading' && (advisories !== null || advisoryError !== null);
  const makeSnapshot = (): TripSnapshot => {
    const odds = wa?.odds;
    const fareData = fares.state === 'done' ? fares.value.data : null;
    return {
      weather: wa?.suitability
        ? { rating: wa.suitability.rating, headline: wa.suitability.headline, confidence: wa.confidence, pMostlyDry: odds?.pMostlyDry, pRainMostDays: odds?.pRainMostDays, meanTMax: odds?.meanTMax ?? null }
        : null,
      fares: fareData
        ? { cheapest: fareData.live?.cheapestTotal ?? fa?.reference?.priceSgd ?? null, verdict: fa?.value ?? null, savedAt: fareData.saved?.at ?? fareData.live?.saved?.at }
        : null,
      crowds: { level: alerts.some((a) => a.level === 'high') ? 'high' : alerts.length ? 'medium' : null, notes: alerts.slice(0, 3).map((a) => a.text) },
      advisory: safety ? { level: LEVEL_LABEL[safety.advisory.level], coverage: safety.coverage.short } : null,
      conclusion: conclusion?.text ?? null,
    };
  };
  useEffect(() => {
    if (!onSnapshot || !settled || sentFor.current === query) return;
    if (weather.state !== 'done' && fares.state !== 'done') return;
    sentFor.current = query;
    onSnapshot(makeSnapshot());
  });

  let weatherBadge: { tone: Tone; text: string } = { tone: 'neutral', text: weather.state === 'loading' ? 'Loading…' : 'Unavailable' };
  if (wa?.suitability) weatherBadge = { tone: ratingTone[wa.suitability.rating], text: wa.suitability.rating };

  const fareSignal = fa?.value ?? fa?.seasonal?.position ?? null;
  let fareBadge: { tone: Tone; text: string } = { tone: 'neutral', text: fares.state === 'loading' ? 'Loading…' : 'Insufficient data' };
  const noFlight = fares.state === 'done' && (fares.value.data.status === 'ferry' || fares.value.data.status === 'land');
  if (noFlight) fareBadge = { tone: 'neutral', text: 'No flight needed' };
  else if (fa?.value) fareBadge = { tone: valueTone[fa.value], text: fa.value };
  else if (fareSignal) fareBadge = { tone: fareSignal === 'Cheaper than usual' ? 'good' : fareSignal === 'Pricier than usual' ? 'critical' : 'warning', text: fareSignal };

  const fareText =
    fares.state === 'done'
      ? fa?.headline ?? fares.value.data.message ?? ''
      : fares.state === 'error'
        ? fares.message
        : '';

  return (
    <section aria-label="Summary" style={{ display: 'grid', gap: 16 }}>
      <div className="card-head">
        <div style={{ display: 'grid', gap: 2 }}>
          <h2>
            {query.place.name}, {query.place.country} · {formatDate(query.startDate)} – {formatDate(query.endDate)}
          </h2>
          {fx.map((line) => (
            <span key={line} className="small secondary fx-line">{line}</span>
          ))}
        </div>
        <div className="saved-actions">
          {onBook && !booking && (
            <button type="button" className="small" onClick={() => setBooking(true)} title="Tickets bought? Puff keeps watch over this trip from here.">
              ✈ I’ve booked this
            </button>
          )}
          <button type="button" className="small" onClick={onWhenToGo} title="The best dates to visit over the next 12 months">
            ☀ Sunny windows
          </button>
        </div>
      </div>
      {onBook && booking && (
        <div className="card">
          <FinaliseForm
            title="Pop it on Puff’s lookout"
            subtitle={`${query.place.name} · ${formatDate(query.startDate)} – ${formatDate(query.endDate)}. These dates are saved under Daydream dates if they aren’t already.`}
            places={[{ id: 1, name: query.place.name, country: query.place.country, lat: query.place.latitude, lon: query.place.longitude }]}
            start={query.startDate}
            end={query.endDate}
            totalNights={daysBetween(query.startDate, query.endDate)}
            initialBookedOn={query.bookedOn}
            onCancel={() => setBooking(false)}
            onSubmit={(b) => onBook(b, weather.state === 'done' ? makeSnapshot() : null)}
          />
        </div>
      )}
      <div className="summary">
        <div className="card verdict">
          <span className="label">Weather suitability</span>
          <span className="value"><Badge tone={weatherBadge.tone}>{weatherBadge.text}</Badge></span>
          <p className="small secondary">
            {wa?.suitability?.headline ?? (weather.state === 'error' ? weather.message : '')}
          </p>
        </div>
        <div className="card verdict">
          <span className="label">Airfare value</span>
          <span className="value"><Badge tone={fareBadge.tone}>{fareBadge.text}</Badge></span>
          <p className="small secondary">{fareText}</p>
        </div>
        <SafetyCard ctx={advisories} safety={safety} error={advisoryError} bookedOn={query.bookedOn} places={[{ cc: query.place.countryCode, lat: query.place.latitude, lon: query.place.longitude }]} />
      </div>
      <AlertStrip places={[{ cc: query.place.countryCode, lat: query.place.latitude, lon: query.place.longitude }]} />
      {conclusion && (
        <div className="card conclusion">
          <span className="small muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Overall</span>
          <p>{conclusion.text}</p>
          {alerts.length > 0 && (
            <p className="small">
              <Badge tone={alerts.some((a) => a.level === 'high') ? 'critical' : 'warning'}>Crowds & prices</Badge>{' '}
              {alerts.slice(0, 2).map((a) => a.text).join(' ')}
              {alerts.length > 2 ? ` (+${alerts.length - 2} more under Crowds & celebrations)` : ''}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
