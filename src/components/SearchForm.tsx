import { useEffect, useId, useRef, useState } from 'react';
import { FARE_CURRENCY } from '../lib/currency';
import { addDays, daysBetween, todayISO } from '../lib/dates';
import { nearestAirports } from '../services/airports';
import { services } from '../services';
import type { Airport, Place, TripQuery } from '../types';
import { TripLength, type WhenTarget } from './BestTime';

const MAX_TRIP_DAYS = 60;

function placeLabel(p: Place) {
  return [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(', ');
}

interface CodeOption {
  code: string;
  label: string;
}

/** Group nearby airports by city code: one city option, then individual airports. */
function codeOptions(airports: Airport[]): CodeOption[] {
  const opts: CodeOption[] = [];
  const seen = new Set<string>();
  for (const a of airports) {
    const cityAirports = airports.filter((x) => x.cityCode === a.cityCode);
    if (!seen.has(a.cityCode) && cityAirports.length > 1) {
      seen.add(a.cityCode);
      opts.push({ code: a.cityCode, label: `${a.cityCode}: all airports (${cityAirports.map((x) => x.iata).join(', ')}) · ${Math.round(a.distanceKm)} km` });
    }
    if (!seen.has(a.iata)) {
      seen.add(a.iata);
      opts.push({ code: a.iata, label: `${a.iata}: ${a.name} · ${Math.round(a.distanceKm)} km` });
    }
  }
  return opts;
}

export interface Prefill {
  place: Place;
  code: string;
  nonce: number;
}

export function SearchForm({
  onSubmit,
  onFindDestinations,
  busy,
  start,
  end,
  onDatesChange,
  prefill,
  onPlaceChange,
  datesNote,
  dateMode,
  onDateModeChange,
  tripDays,
  onTripDaysChange,
  onFindBestDates,
  bookedOnDefault,
}: {
  onSubmit: (q: TripQuery) => void;
  /** Called when the user submits dates without a destination. */
  onFindDestinations: () => void;
  busy: boolean;
  start: string;
  end: string;
  onDatesChange: (start: string, end: string) => void;
  prefill?: Prefill | null;
  /** Reports the selected destination (or null) so other panels can react before submit. */
  onPlaceChange?: (place: Place | null) => void;
  /** Where the dates come from, e.g. "★ Yolo Trip with Zee" or "Custom dates". */
  datesNote?: string;
  /** fixed ("My dates"): exact start and end dates. flexible ("Sunny window"): a trip length. */
  dateMode: 'fixed' | 'flexible';
  onDateModeChange: (m: 'fixed' | 'flexible') => void;
  tripDays: number;
  onTripDaysChange: (n: number) => void;
  /** Sunny windows for the chosen destination: the best dates over the next 12 months. */
  onFindBestDates: (t: WhenTarget) => void;
  /** Booking date of the saved dates in use, which fills the "Booked on" field. */
  bookedOnDefault?: string | null;
}) {
  const [text, setText] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [airportOpts, setAirportOpts] = useState<CodeOption[] | null>(null);
  const [airportError, setAirportError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [manualFare, setManualFare] = useState('');
  const [bookedOn, setBookedOn] = useState(bookedOnDefault ?? '');
  // Choosing saved dates brings their booking date along.
  useEffect(() => setBookedOn(bookedOnDefault ?? ''), [bookedOnDefault]);
  const listId = useId();
  const debounce = useRef<number>();
  const pendingCode = useRef<string | null>(null);

  useEffect(() => onPlaceChange?.(place), [place, onPlaceChange]);

  // A destination chosen elsewhere (suggestions, map) fills the form.
  useEffect(() => {
    if (!prefill) return;
    pendingCode.current = prefill.code;
    setPlace(prefill.place);
    setText(placeLabel(prefill.place));
    setOpen(false);
  }, [prefill]);

  // Debounced destination search.
  useEffect(() => {
    if (place && text === placeLabel(place)) return;
    window.clearTimeout(debounce.current);
    if (text.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    debounce.current = window.setTimeout(async () => {
      try {
        const res = await services.geocoding.search(text, ctrl.signal);
        setSuggestions(res);
        setActive(0);
        setOpen(true);
        setGeoError(null);
      } catch (e) {
        if (!ctrl.signal.aborted) setGeoError(`Destination search failed: ${(e as Error).message}`);
      }
    }, 300);
    return () => {
      ctrl.abort();
      window.clearTimeout(debounce.current);
    };
  }, [text, place]);

  // Resolve nearby airports when a place is chosen.
  useEffect(() => {
    if (!place) return;
    setAirportOpts(null);
    setAirportError(null);
    nearestAirports(place.latitude, place.longitude)
      .then((airports) => {
        const opts = codeOptions(airports);
        const want = pendingCode.current;
        pendingCode.current = null;
        if (want && !opts.some((o) => o.code === want)) opts.unshift({ code: want, label: want.startsWith('LAND-') ? '🚌 Overland from Singapore (no flight)' : want.startsWith('FERRY-') ? '⛴ Ferry from Singapore (no flight)' : want });
        setAirportOpts(opts);
        // Default to the nearest airport's city code; it covers every airport in that city.
        setCode(want ?? airports[0]?.cityCode ?? '');
        if (!airports.length) setAirportError('No airport with scheduled flights within 250 km. Airfare comparison will be unavailable.');
      })
      .catch((e: Error) => setAirportError(e.message));
  }, [place]);

  const choose = (p: Place) => {
    setPlace(p);
    setText(placeLabel(p));
    setOpen(false);
  };

  const flexible = dateMode === 'flexible';
  const len = daysBetween(start, end) + 1;
  const dateError =
    flexible ? null
    : !start || !end ? 'Choose both dates.'
    : end < start ? 'The end date must be on or after the start date.'
    : len > MAX_TRIP_DAYS ? `The map shows the whole range; for trip analysis or suggestions, narrow it to ${MAX_TRIP_DAYS} days or fewer.`
    : null;
  const fareNum = manualFare.trim() ? Number(manualFare) : undefined;
  const fareError = fareNum !== undefined && (!Number.isFinite(fareNum) || fareNum <= 0) ? `Enter a positive amount in ${FARE_CURRENCY}.` : null;
  const blank = !place && text.trim() === '';
  const destError =
    !place && !blank ? `Pick a destination from the list${flexible ? '.' : ', or clear the field to get suggestions.'}`
    : flexible && blank ? 'Pick a destination to find its sunny windows.'
    : null;
  const canSubmit = !destError && !dateError && (flexible || (!fareError && !busy));
  // Sunny window mode with no destination yet shows a hint instead of an error.
  const formError = geoError ?? dateError ?? (flexible ? null : fareError) ?? (destError && !blank && text.trim().length > 1 && !open ? destError : null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (flexible) {
      if (!place) return;
      const opt = airportOpts?.find((o) => o.code === code);
      onFindBestDates({ place, destinationCode: code, destinationLabel: opt?.label.split(' · ')[0] ?? code });
      return;
    }
    if (blank) {
      onFindDestinations();
      return;
    }
    if (!place) return;
    const opt = airportOpts?.find((o) => o.code === code);
    onSubmit({
      place,
      destinationCode: code,
      destinationLabel: opt?.label.split(' · ')[0] ?? code,
      startDate: start,
      endDate: end,
      manualFareSgd: fareNum,
      bookedOn: bookedOn || undefined,
    });
  };

  return (
    <form className="card" onSubmit={submit} aria-label="Trip search">
      <div className="form">
        <div className="field">
          <label htmlFor="dest">Destination <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <input
            id="dest"
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            autoComplete="off"
            placeholder="Optional: leave blank for suggestions"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPlace(null);
              setAirportOpts(null);
            }}
            onFocus={() => suggestions.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (!open || !suggestions.length) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, suggestions.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); choose(suggestions[active]); }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          {open && suggestions.length > 0 && (
            <ul className="suggestions" id={listId} role="listbox">
              {suggestions.map((s, i) => (
                <li key={s.id}>
                  <button type="button" role="option" aria-selected={i === active} onMouseDown={() => choose(s)}>
                    {placeLabel(s)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <fieldset className="field date-group">
          <div className="date-group-head">
            <legend>Dates</legend>
            {!flexible && datesNote && <span className={`dates-note${datesNote.startsWith('★') ? ' saved' : ''}`}>{datesNote}</span>}
            <div className="date-mode" role="group" aria-label="Date type">
              <button type="button" aria-pressed={!flexible} onClick={() => onDateModeChange('fixed')}>My dates</button>
              <button type="button" aria-pressed={flexible} onClick={() => onDateModeChange('flexible')} title="Not sure when? Find the sunniest dates over the next 12 months">Sunny window</button>
            </div>
          </div>
          {flexible ? (
            <div className="date-inputs flexible">
              <TripLength id="trip-days" value={tripDays} onChange={onTripDaysChange} />
              <span className="small muted">any time in the next 12 months</span>
            </div>
          ) : (
            <div className="date-inputs">
              <input id="start" aria-label="Start date" type="date" value={start} min={todayISO()} onChange={(e) => onDatesChange(e.target.value, e.target.value > end ? addDays(e.target.value, Math.max(0, daysBetween(start, end))) : end)} />
              <span className="date-arrow" aria-hidden>→</span>
              <input id="end" aria-label="End date" type="date" value={end} min={start} onChange={(e) => onDatesChange(start, e.target.value)} />
            </div>
          )}
        </fieldset>
        <button className="primary" type="submit" disabled={!canSubmit}>
          {busy && !flexible ? 'Checking…' : flexible ? 'Find sunny windows' : blank ? 'Suggest destinations' : 'Evaluate trip'}
        </button>
      </div>

      {formError ? <p className="error-text" role="alert">{formError}</p> : flexible && blank && <p className="small muted">{destError}</p>}

      {place && (
        <div className="form-extra">
          <div className="field">
            <label htmlFor="airport">Destination airport (from SIN)</label>
            {airportOpts === null && !airportError ? (
              <select id="airport" disabled><option>Finding airports…</option></select>
            ) : (
              <select id="airport" value={code} onChange={(e) => setCode(e.target.value)} disabled={!airportOpts?.length}>
                {airportOpts?.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
            )}
          </div>
          {!flexible && (
            <>
              <div className="field">
                <label htmlFor="fare">Optional: a fare you've seen ({FARE_CURRENCY}, return)</label>
                <input id="fare" inputMode="decimal" placeholder="e.g. 450" value={manualFare} onChange={(e) => setManualFare(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="booked" title="Insurers such as FWD don't cover MFA advisories issued before you booked">Optional: booked on</label>
                <input id="booked" type="date" value={bookedOn} max={todayISO()} onChange={(e) => setBookedOn(e.target.value)} />
              </div>
              <p className="small muted" style={{ flex: '1 1 220px' }}>
                Economy return, 1 adult, {FARE_CURRENCY} · {len > 0 && !dateError ? `${len} days / ${len - 1} nights` : '—'}
              </p>
            </>
          )}
        </div>
      )}
      {airportError && <p className="error-text">{airportError}</p>}
    </form>
  );
}
