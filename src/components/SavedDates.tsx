import { useEffect, useId, useState } from 'react';
import { formatPrice } from '../lib/currency';
import { addDays, daysBetween, formatDate, formatShortDate, todayISO } from '../lib/dates';
import { WET_DAY_MM } from '../lib/weatherAnalysis';
import { services } from '../services';
import { countdown, modeIcon, tripTotal } from '../lib/lookout';
import { bookRange, deleteSavedRange, listSavedRanges, MAX_SAVED_RANGE_DAYS, retrieveNow, saveRange, updateSavedRange, type SavedDestination, type SavedRange, type TripSnapshot } from '../services/savedRanges';
import { FinaliseForm } from './Finalise';
import { SavedCompare } from './SavedCompare';
import { Badge } from './ui';

/** Upcoming daydream dates shown before "+N more". */
const VISIBLE_UPCOMING = 5;

interface Draft {
  label: string;
  start: string;
  end: string;
  /** Optional booking date ('' when not booked), for insurers' advisory-timing rules. */
  booked_on: string;
}

function draftError(d: Draft): string | null {
  if (!d.start || !d.end) return 'Choose a start and an end date.';
  if (d.end < d.start) return 'The end date must be on or after the start date.';
  const days = daysBetween(d.start, d.end) + 1;
  if (days > MAX_SAVED_RANGE_DAYS) return `Saved ranges can be up to ${MAX_SAVED_RANGE_DAYS} days (this one is ${days}).`;
  return null;
}

/**
 * Travel dates of interest as a compact row of chips. Clicking a chip uses those dates: it fills
 * the search dates, switches the map and Sunny picks to them, and shows the chip's details.
 * Only the next 5 upcoming dates show until "+N more"; trips whose end date has passed move to a
 * collapsed, read-only "Past trips" list. Booked trips sit in their own "On Puff's lookout" card
 * above, and open Puff's Lookout.
 */
export function SavedDates({
  start,
  end,
  activeId,
  onPick,
  onRemoved,
  onOpenDestination,
  onOpenArchived,
  onOpenLookout,
}: {
  /** The search form's dates (used to prefill a new range). */
  start: string;
  end: string;
  /** The daydream date currently in use, if any. */
  activeId: number | null;
  /** Use these dates. `quiet` keeps the current view (e.g. after editing the range in use). */
  onPick: (r: SavedRange, opts?: { quiet?: boolean }) => void;
  onRemoved?: (id: number) => void;
  /** Open the full analysis for a saved destination on its range's dates. */
  onOpenDestination?: (d: SavedDestination, r: SavedRange) => void;
  /** Open a past trip's analysis from stored data only. */
  onOpenArchived?: (d: SavedDestination, r: SavedRange) => void;
  /** Open Puff's Lookout for a booked trip. */
  onOpenLookout?: (r: SavedRange) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  const [ranges, setRanges] = useState<SavedRange[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-delete' | 'new' | 'book' | null>(null);

  const refresh = () =>
    listSavedRanges()
      .then((r) => (setRanges(r), setLoadError(null)))
      .catch((e: Error) => setLoadError(`Saved dates unavailable: ${e.message}`));

  useEffect(() => {
    void refresh();
  }, []);

  // While any range is still being filled, poll for progress.
  const pending = ranges?.some(
    (r) =>
      (r.weather && r.weather.state !== 'complete' && r.weather.state !== 'past') ||
      r.destinations?.some((d) => d.weather && d.weather.state !== 'complete' && d.weather.state !== 'past'),
  );
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(id);
  }, [pending]);

  // New ranges start from the search dates when they're usable, otherwise a week a month out.
  const searchUsable = Boolean(start && end && end >= start && daysBetween(start, end) < MAX_SAVED_RANGE_DAYS);
  const newDraft: Draft = searchUsable ? { label: '', start, end, booked_on: '' } : { label: '', start: addDays(todayISO(), 30), end: addDays(todayISO(), 36), booked_on: '' };

  // A range chosen elsewhere (the first upcoming one on load) opens its details too.
  useEffect(() => {
    if (activeId !== null) {
      setSelected(activeId);
      setMode((m) => (m === 'new' || m === 'edit' || m === 'book' ? m : 'view'));
    }
  }, [activeId]);

  const today = todayISO();
  const isPast = (r: SavedRange) => r.archived ?? r.end < today;
  // The server lists ranges by start date, so upcoming ones are already chronological.
  const booked = ranges?.filter((r) => !isPast(r) && r.booking) ?? [];
  const upcoming = ranges?.filter((r) => !isPast(r) && !r.booking) ?? [];
  const past = (ranges?.filter(isPast) ?? []).slice().reverse();
  // The dates in use always show, even when they're beyond the first five.
  const visible = showAll ? upcoming : upcoming.filter((r, i) => i < VISIBLE_UPCOMING || r.id === activeId || r.id === selected);
  const hiddenCount = upcoming.length - visible.length;
  const sel = upcoming.find((r) => r.id === selected) ?? null;
  const close = () => (setSelected(null), setMode(null));

  const remove = async (id: number) => {
    try {
      await deleteSavedRange(id);
      close();
      onRemoved?.(id);
      await refresh();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  return (
    <>
    {booked.length > 0 && (
      <section className="card saved-dates lookout-strip" aria-labelledby="lookout-h">
        <div className="saved-bar">
          <h3 id="lookout-h" title="Booked trips: Puff keeps watch over the forecast, air quality, events and travel advice.">On Puff’s lookout</h3>
          <div className="saved-chips">
            {booked.map((r) => {
              const it = r.booking!.itinerary;
              const names = it.stops.map((st) => r.destinations?.find((d) => d.id === st.destId)?.name).filter(Boolean);
              const route = names.length ? names.join(' → ') : r.label || 'Booked trip';
              const unread = r.lookout?.unread ?? 0;
              return (
                <button
                  key={r.id}
                  type="button"
                  className="saved-chip"
                  onClick={() => onOpenLookout?.(r)}
                  title={`${route} · ${formatDate(r.start)} – ${formatDate(r.end)}${unread ? ` · ${unread} new` : ''}`}
                >
                  <span className="chip-label">
                    {it.legs[0]?.mode ? `${modeIcon(it.legs[0].mode)} ` : ''}
                    {route}
                  </span>
                  <span className="chip-dates">{formatShortDate(r.start)} – {formatShortDate(r.end)}</span>
                  <span className="chip-status">{countdown(r.start, r.end, today)}</span>
                  {unread > 0 && <span className="new-dot" aria-label={`${unread} new`} />}
                </button>
              );
            })}
          </div>
        </div>
      </section>
    )}
    <section className="card saved-dates" aria-labelledby="saved-h">
      <div className="saved-bar">
        <h3 id="saved-h" title="Keep the date ranges you're considering; select one to see details and plan with it.">Daydream dates</h3>
        <div className="saved-chips" role="listbox" aria-label="Saved travel dates">
          {visible.map((r) => {
            const active = r.id === activeId;
            const isSel = r.id === selected;
            const w = r.weather;
            const status = !w || w.state === 'past' ? null : w.state === 'complete' ? 'done' : 'pending';
            return (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={isSel}
                className={`saved-chip${active ? ' active' : ''}${isSel ? ' selected' : ''}`}
                onClick={() => (isSel ? close() : (setSelected(r.id), setMode('view'), onPick(r)))}
                title={`${formatDate(r.start)} – ${formatDate(r.end)}${active ? ' · showing on map' : ''}`}
              >
                <span className="chip-label">{r.label || 'Untitled'}</span>
                <span className="chip-dates">{formatShortDate(r.start)} – {formatShortDate(r.end)}</span>
                {status && (
                  <span className={`chip-status ${status}`} aria-label={status === 'done' ? 'Weather saved' : `Weather ${w!.pct ?? 0}% saved`}>
                    {status === 'done' ? '✓' : `${w!.pct ?? Math.round((w!.placesDone / w!.places) * 100)}%`}
                  </span>
                )}
              </button>
            );
          })}
          {(hiddenCount > 0 || (showAll && upcoming.length > VISIBLE_UPCOMING)) && (
            <button type="button" className="saved-chip chip-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `+${hiddenCount} more`}
            </button>
          )}
          {ranges && upcoming.length === 0 && mode !== 'new' && (
            <span className="small muted">{past.length ? 'No upcoming dates: save dates you’re considering.' : 'None yet: save dates you’re considering.'}</span>
          )}
          {mode !== 'new' && (
            <button type="button" className="saved-chip chip-add" onClick={() => (setSelected(null), setMode('new'))}>
              + Add dates
            </button>
          )}
        </div>
      </div>

      {past.length > 0 && (
        <div className="past-trips">
          <button type="button" className="link-button small past-toggle" aria-expanded={pastOpen} onClick={() => setPastOpen((v) => !v)}>
            <span aria-hidden>{pastOpen ? '▾' : '▸'}</span> Past trips ({past.length})
          </button>
          {pastOpen && (
            <ul className="past-list">
              {past.map((r) => (
                <PastTrip key={r.id} r={r} onOpen={onOpenArchived} onDelete={() => void remove(r.id)} />
              ))}
            </ul>
          )}
        </div>
      )}

      {loadError && <p className="small error-text">{loadError}</p>}

      {mode === 'new' && (
        <RangeEditor
          initial={newDraft}
          hint={searchUsable ? 'Prefilled from your search dates.' : undefined}
          submitLabel="Save"
          secondaryLabel="Save & use these dates"
          onCancel={close}
          onSubmit={async (d, view) => {
            const saved = await saveRange({ ...d, booked_on: d.booked_on || null });
            await refresh();
            setSelected(saved.id);
            setMode('view');
            if (view) onPick(saved);
          }}
        />
      )}

      {sel && mode === 'edit' && (
        <RangeEditor
          initial={{ label: sel.label, start: sel.start, end: sel.end, booked_on: sel.booked_on ?? '' }}
          submitLabel="Save changes"
          onCancel={() => setMode('view')}
          onSubmit={async (d) => {
            const wasActive = sel.id === activeId;
            const saved = await updateSavedRange(sel.id, { ...d, booked_on: d.booked_on || null });
            await refresh();
            setMode('view');
            // Keep the search form and map in step if this range was the one in use.
            if (wasActive) onPick(saved, { quiet: true });
          }}
        />
      )}

      {sel && (mode === 'view' || mode === 'confirm-delete') && (
        <div className="saved-detail">
          <div className="saved-info">
            <div className="risk-head">
              <strong>{sel.label || 'Untitled dates'}</strong>
              {sel.id === activeId && <Badge tone="info">Using these dates</Badge>}
              {sel.end < today && <Badge tone="neutral">Past</Badge>}
            </div>
            <span className="small secondary">
              {formatDate(sel.start)} – {formatDate(sel.end)} · {daysBetween(sel.start, sel.end) + 1} days
              {sel.booked_on ? ` · booked ${formatDate(sel.booked_on)}` : ''}
            </span>
            {sel.weather && <WeatherProgress r={sel} onRetrieve={() => void retrieveNow(sel.id).then(refresh)} />}
          </div>
          {mode === 'confirm-delete' ? (
            <div className="saved-actions" role="group" aria-label="Confirm delete">
              <span className="small">Delete this?</span>
              <button type="button" className="small danger" onClick={() => void remove(sel.id)}>Delete</button>
              <button type="button" className="small" onClick={() => setMode('view')}>Keep</button>
            </div>
          ) : (
            <div className="saved-actions">
              {sel.id !== activeId && (
                <button type="button" className="small primary" onClick={() => onPick(sel)}>
                  Use these dates
                </button>
              )}
              <button
                type="button"
                className="small"
                onClick={() => setMode('book')}
                disabled={!sel.destinations?.length}
                title={sel.destinations?.length ? 'Tickets bought? Puff keeps watch from here.' : 'Add the destination you booked under Destinations to compare first'}
              >
                ✈ Mark as booked
              </button>
              <button type="button" className="small" onClick={() => setMode('edit')}>Edit</button>
              <button type="button" className="small" onClick={() => setMode('confirm-delete')}>Delete</button>
              <button type="button" className="small" aria-label="Close details" onClick={close}>✕</button>
            </div>
          )}
        </div>
      )}
      {sel && (mode === 'view' || mode === 'confirm-delete') && (
        <SavedCompare range={sel} onChanged={() => void refresh()} onOpen={onOpenDestination} />
      )}
      {sel && mode === 'book' && (
        <FinaliseForm
          title={`Finalise “${sel.label || 'Untitled dates'}”`}
          subtitle={`${formatDate(sel.start)} – ${formatDate(sel.end)} · ${daysBetween(sel.start, sel.end)} night${daysBetween(sel.start, sel.end) === 1 ? '' : 's'}`}
          places={(sel.destinations ?? []).map((d) => ({ id: d.id, name: d.name, country: d.country, lat: d.lat, lon: d.lon, note: d.snapshot?.weather?.rating }))}
          start={sel.start}
          end={sel.end}
          totalNights={daysBetween(sel.start, sel.end)}
          initialBookedOn={sel.booked_on}
          onCancel={() => setMode('view')}
          onSubmit={async ({ itinerary, bookedOn }) => {
            const baseline = Object.fromEntries(itinerary.stops.map((st) => [st.destId, sel.destinations?.find((d) => d.id === st.destId)?.snapshot ?? null]));
            await bookRange(sel.id, { itinerary, booked_on: bookedOn, baseline, prune: true });
            const fresh = await listSavedRanges();
            setRanges(fresh);
            close();
            onRemoved?.(sel.id);
            const r = fresh.find((x) => x.id === sel.id);
            if (r) onOpenLookout?.(r);
          }}
        />
      )}
    </section>
    </>
  );
}

/** A read-only past trip: its saved destinations with what was seen before, and the actual weather. */
function PastTrip({ r, onOpen, onDelete }: { r: SavedRange; onOpen?: (d: SavedDestination, r: SavedRange) => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const dests = r.destinations ?? [];
  return (
    <li className="past-trip">
      <div className="past-head">
        <div className="saved-info">
          <strong>{r.label || 'Untitled dates'}</strong>
          <span className="small secondary">
            {formatDate(r.start)} – {formatDate(r.end)} · {daysBetween(r.start, r.end) + 1} days{r.booked_on ? ` · booked ${formatDate(r.booked_on)}` : ''}
            {r.booking && tripTotal(r.booking.itinerary) !== null ? ` · trip total ${formatPrice(tripTotal(r.booking.itinerary)!)}` : ''}
          </span>
        </div>
        {confirm ? (
          <div className="saved-actions" role="group" aria-label="Confirm delete">
            <span className="small">Delete this past trip and everything saved for it?</span>
            <button type="button" className="small danger" onClick={onDelete}>Delete</button>
            <button type="button" className="small" onClick={() => setConfirm(false)}>Keep</button>
          </div>
        ) : (
          <div className="saved-actions">
            <button type="button" className="small" onClick={() => setConfirm(true)}>Delete</button>
          </div>
        )}
      </div>
      {dests.length === 0 ? (
        <p className="small muted">No destinations were saved for this trip.</p>
      ) : (
        <ul className="past-dests">
          {dests.map((d) => (
            <li key={d.id}>
              <div className="past-dest-head">
                <strong>{d.name}</strong>
                <span className="small muted">
                  {d.country}
                  {r.booking?.itinerary.stops.some((st) => st.destId === d.id) ? ` · visited (${r.booking.itinerary.stops.find((st) => st.destId === d.id)!.nights} nights)` : ''}
                </span>
                {onOpen && (
                  <button type="button" className="link-button small" onClick={() => onOpen(d, r)}>
                    Open analysis
                  </button>
                )}
              </div>
              <SnapshotLine snap={d.snapshot} />
              <ActualWeather d={d} r={r} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const savedOn = (ms: number) => formatDate(new Date(ms).toLocaleDateString('sv'));

function SnapshotLine({ snap }: { snap?: TripSnapshot }) {
  if (!snap) return <p className="small muted">Predicted: not saved (the analysis wasn’t opened before the trip).</p>;
  const parts: string[] = [];
  if (snap.weather) parts.push(`${snap.weather.rating}${snap.weather.pMostlyDry !== undefined ? ` · ${Math.round(snap.weather.pMostlyDry * 100)}% chance of a mostly dry trip` : ''}`);
  if (snap.fares?.cheapest != null) parts.push(`fares from ${formatPrice(snap.fares.cheapest)}${snap.fares.savedAt ? ` (seen ${savedOn(snap.fares.savedAt)})` : ''}`);
  if (snap.crowds.level) parts.push(snap.crowds.level === 'high' ? 'busy: higher prices likely' : 'some crowding');
  if (snap.advisory) parts.push(`MFA: ${snap.advisory.level}`);
  return (
    <p className="small">
      <span className="secondary">Predicted{snap.at ? ` (as of ${savedOn(snap.at)})` : ''}:</span> {parts.join(' · ') || 'nothing saved'}
    </p>
  );
}

/** What the weather actually did on the trip dates, from stored ERA5 days (fetched after the trip). */
function ActualWeather({ d, r }: { d: SavedDestination; r: SavedRange }) {
  const [state, setState] = useState<{ wet: number; days: number; tMax: number | null; rain: number } | 'none' | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    services.weather
      .getDaily(d.lat, d.lon, r.start, r.end, ctrl.signal, { storedOnly: true })
      .then((h) => {
        const days = h.daily.filter((x) => x.precipMm !== null);
        if (!days.length) return setState('none');
        const highs = days.map((x) => x.tMaxC).filter((x): x is number => x !== null);
        setState({
          days: days.length,
          wet: days.filter((x) => x.precipMm! >= WET_DAY_MM).length,
          rain: days.reduce((a, x) => a + x.precipMm!, 0),
          tMax: highs.length ? highs.reduce((a, x) => a + x, 0) / highs.length : null,
        });
      })
      .catch(() => !ctrl.signal.aborted && setState('none'));
    return () => ctrl.abort();
  }, [d.lat, d.lon, r.start, r.end]);
  if (state === null) return null;
  const total = daysBetween(r.start, r.end) + 1;
  if (state === 'none') {
    return <p className="small muted">Actual weather: not available yet (published about 5 days after the trip, then saved automatically).</p>;
  }
  return (
    <p className="small">
      <span className="secondary">Actual:</span> {state.wet} of {state.days} day{state.days === 1 ? '' : 's'} wet (≥{WET_DAY_MM} mm), {Math.round(state.rain)} mm rain
      {state.tMax !== null ? `, average high ${Math.round(state.tMax)} °C` : ''}
      {state.days < total ? ` (${total - state.days} day${total - state.days === 1 ? '' : 's'} not published yet)` : ''}
    </p>
  );
}

function RangeEditor({
  initial,
  hint,
  submitLabel,
  secondaryLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  hint?: string;
  submitLabel: string;
  secondaryLabel?: string;
  onSubmit: (d: Draft, viewOnMap: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const err = draftError(d);
  const days = d.start && d.end && d.end >= d.start ? daysBetween(d.start, d.end) + 1 : null;

  const submit = async (view: boolean) => {
    if (err || busy) return;
    setBusy(true);
    setServerError(null);
    try {
      await onSubmit({ ...d, label: d.label.trim() }, view);
    } catch (e) {
      setServerError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="range-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="range-fields">
        <div className="field">
          <label htmlFor={`${id}-label`}>Label <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <input id={`${id}-label`} autoFocus placeholder="e.g. Year-end break" maxLength={60} value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-start`}>From</label>
          <input
            id={`${id}-start`}
            type="date"
            value={d.start}
            onChange={(e) => {
              const s = e.target.value;
              // Keep the same length when the start moves past the end.
              setD({ ...d, start: s, end: s && d.end && s > d.end ? addDays(s, Math.max(0, daysBetween(d.start, d.end))) : d.end });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-end`}>To</label>
          <input id={`${id}-end`} type="date" value={d.end} min={d.start} onChange={(e) => setD({ ...d, end: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-booked`} title="Insurers such as FWD don't cover MFA advisories issued before you booked">
            Booked on <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <input id={`${id}-booked`} type="date" value={d.booked_on} max={todayISO()} onChange={(e) => setD({ ...d, booked_on: e.target.value })} />
        </div>
      </div>
      <div className="range-footer">
        <span className={`small ${err || serverError ? 'error-text' : 'muted'}`} role={err || serverError ? 'alert' : undefined}>
          {serverError ?? err ?? `${days} day${days === 1 ? '' : 's'}${hint ? ` · ${hint}` : ''}`}
        </span>
        <div className="saved-actions">
          <button type="button" className="small" onClick={onCancel}>Cancel</button>
          {secondaryLabel && (
            <button type="button" className="small" disabled={Boolean(err) || busy} onClick={() => void submit(true)}>
              {secondaryLabel}
            </button>
          )}
          <button type="submit" className="small primary" disabled={Boolean(err) || busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function WeatherProgress({ r, onRetrieve }: { r: SavedRange; onRetrieve: () => void }) {
  const w = r.weather!;
  if (w.state === 'past') return null;
  const pct = w.pct ?? (w.places ? Math.round((w.placesDone / w.places) * 100) : 0);
  const what = `${w.years} years of same-date history${w.forecast ? ' + forecast' : ''}`;
  if (w.state === 'complete') {
    return (
      <span className="small tone-good" title={what}>
        ✓ Weather saved for all {w.places} map places ({what})
      </span>
    );
  }
  return (
    <div className="range-progress">
      <div className="bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={w.places} aria-valuenow={w.placesDone} aria-label="Weather data saved">
        <div className="bar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="small muted">
        Weather data {pct}% saved ({w.placesDone} of {w.places} places complete, {w.years} years each) · {w.detail}
      </span>
      {w.state === 'queued' && (
        <button type="button" className="link-button small" onClick={onRetrieve}>
          Retrieve these first
        </button>
      )}
    </div>
  );
}
