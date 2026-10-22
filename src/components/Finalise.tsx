import { useId, useState } from 'react';
import { dayLabel, legEnds, MODE_ICON, MODE_LABEL, stopDates, type Itinerary, type Leg, type Stop, type TravelMode } from '../lib/lookout';
import { formatDate, todayISO } from '../lib/dates';
import { ANY_MODE, travelOptions, useDestinationData, type TravelOption } from '../services/travelOptions';
import type { Destination } from '../services/destinations';

export interface PlaceChoice {
  id: number;
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** A short note shown in step 1, e.g. the weather rating. */
  note?: string;
}

/** Ways for each leg: from and back to Singapore only what the data knows; between stops, any. */
function legOptions(dests: Destination[] | null, stops: PlaceChoice[]): TravelOption[][] {
  return legEnds(stops.map((s) => s.name)).map((_, i) => {
    if (i === 0) return travelOptions(dests ?? [], stops[0].lat, stops[0].lon);
    if (i === stops.length) return travelOptions(dests ?? [], stops[stops.length - 1].lat, stops[stops.length - 1].lon);
    return ANY_MODE.map((mode) => ({ mode, label: '' }));
  });
}

function ModeChips({ options, value, onChange, name }: { options: TravelOption[]; value: TravelMode | null; onChange: (m: TravelMode) => void; name: string }) {
  return (
    <div className="mode-chips" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label key={o.mode} className={`saved-chip${o.mode === value ? ' selected' : ''}`}>
          <input type="radio" name={name} checked={o.mode === value} onChange={() => onChange(o.mode)} />
          <span className="chip-label">
            {MODE_ICON[o.mode]} {MODE_LABEL[o.mode]}
          </span>
          {o.label && <span className="chip-dates">{o.label}</span>}
        </label>
      ))}
    </div>
  );
}

/**
 * Finalise a Daydream date: (1) which places you're visiting, in order, with nights; (2) how you
 * travel each leg. Places left out are removed when it's saved. With one place, it opens on step 2.
 */
export function FinaliseForm({
  title,
  subtitle,
  places,
  start,
  end,
  totalNights,
  initialBookedOn,
  onSubmit,
  onCancel,
}: {
  title: string;
  subtitle: string;
  places: PlaceChoice[];
  start: string;
  end: string;
  totalNights: number;
  initialBookedOn?: string | null;
  onSubmit: (b: { itinerary: Itinerary; bookedOn: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const dests = useDestinationData();
  const single = places.length === 1;
  const [step, setStep] = useState<1 | 2>(single ? 2 : 1);
  const [chosen, setChosen] = useState<{ id: number; nights: number }[]>(single ? [{ id: places[0].id, nights: totalNights }] : []);
  const [modes, setModes] = useState<(TravelMode | null)[]>([]);
  const [bookedOn, setBookedOn] = useState(initialBookedOn ?? todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const byId = new Map(places.map((p) => [p.id, p]));
  const stops = chosen.map((c) => byId.get(c.id)!).filter(Boolean);
  const sum = chosen.reduce((a, c) => a + c.nights, 0);
  const step1Error = !chosen.length ? 'Tick the places you’re visiting.' : chosen.length > 1 && sum !== totalNights ? `The nights add up to ${sum}; these dates have ${totalNights}.` : null;
  const options = stops.length ? legOptions(dests, stops) : [];
  const legModes = options.map((o, i) => modes[i] ?? o[0]?.mode ?? null);
  const removed = places.length - chosen.length;

  const toggle = (pid: number) =>
    setChosen((c) => (c.some((x) => x.id === pid) ? c.filter((x) => x.id !== pid) : [...c, { id: pid, nights: Math.max(0, totalNights - c.reduce((a, x) => a + x.nights, 0)) }]));
  const move = (i: number, by: -1 | 1) =>
    setChosen((c) => {
      const out = [...c];
      const j = i + by;
      if (j < 0 || j >= out.length) return c;
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const submit = async () => {
    if (busy || step1Error || !bookedOn) return;
    setBusy(true);
    setError(null);
    try {
      const itinerary: Itinerary = {
        stops: chosen.map((c): Stop => ({ destId: c.id, nights: single ? totalNights : c.nights })),
        legs: legModes.map((mode): Leg => ({ mode })),
      };
      await onSubmit({ itinerary, bookedOn });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const dates = stops.length ? stopDates({ stops: chosen.map((c) => ({ destId: c.id, nights: c.nights })), legs: [] }, start, end) : [];
  const ends = legEnds(stops.map((s) => s.name));

  return (
    <form
      className="book-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (step === 1) {
          if (!step1Error) setStep(2);
        } else void submit();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="card-head">
        <div style={{ display: 'grid', gap: 2 }}>
          <h3>{title}</h3>
          <p className="small muted">{subtitle}</p>
        </div>
      </div>
      {!single && (
        <div className="finalise-steps small">
          <span className={`step${step === 1 ? ' on' : ''}`}>1</span> {step === 1 ? <strong>Which places are you visiting?</strong> : <span className="muted">{stops.map((s) => s.name).join(' → ')}</span>}
          <span className={`step${step === 2 ? ' on' : ''}`}>2</span> {step === 2 ? <strong>How are you getting around?</strong> : <span className="muted">How you travel</span>}
        </div>
      )}

      {step === 1 ? (
        <>
          <ul className="finalise-places">
            {places.map((p) => {
              const i = chosen.findIndex((c) => c.id === p.id);
              const on = i >= 0;
              return (
                <li key={p.id} className={on ? 'on' : undefined}>
                  <label className="finalise-place">
                    <input type="checkbox" checked={on} onChange={() => toggle(p.id)} />
                    <strong>{on ? `${i + 1}. ` : ''}{p.name}</strong>
                    <span className="small muted">{on && dates[i] ? `${formatDate(dates[i].arrive)} – ${formatDate(dates[i].leave)}` : p.country}</span>
                    {p.note && <span className="small secondary">{p.note}</span>}
                  </label>
                  {on && (
                    <span className="saved-actions">
                      {chosen.length > 1 && (
                        <select aria-label={`Nights in ${p.name}`} value={chosen[i].nights} onChange={(e) => setChosen((c) => c.map((x) => (x.id === p.id ? { ...x, nights: Number(e.target.value) } : x)))}>
                          {Array.from({ length: totalNights + 1 }, (_, n) => (
                            <option key={n} value={n}>
                              {n} night{n === 1 ? '' : 's'}
                            </option>
                          ))}
                        </select>
                      )}
                      <button type="button" className="small" aria-label={`Move ${p.name} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button type="button" className="small" aria-label={`Move ${p.name} later`} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}>↓</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="small muted">
            {removed > 0 && chosen.length > 0
              ? `${removed} place${removed === 1 ? '' : 's'} you’re not visiting will be removed. Their weather history and saved fares stay in the database.`
              : 'Tick each place in the order you’ll visit; the nights must add up to these dates.'}
          </p>
        </>
      ) : (
        <>
          <div className="finalise-legs">
            {ends.map(([from, to], i) => (
              <div key={`${from}-${to}-${i}`} className="finalise-leg">
                <span className="small secondary">
                  <strong>
                    {from} → {to}
                  </strong>{' '}
                  · {dayLabel(i < dates.length ? dates[i].arrive : end)}
                </span>
                <ModeChips options={options[i] ?? []} value={legModes[i]} onChange={(m) => setModes(legModes.map((x, j) => (j === i ? m : x)))} name={`${id}-leg-${i}`} />
              </div>
            ))}
          </div>
          <div className="range-fields">
            <div className="field">
              <label htmlFor={`${id}-on`} title="Insurers such as FWD don't cover MFA advisories issued before you booked">Booked on</label>
              <input id={`${id}-on`} type="date" value={bookedOn} max={todayISO()} onChange={(e) => setBookedOn(e.target.value)} />
            </div>
          </div>
          <p className="small muted">Times, prices and where you’re staying can be added now or later on Puff’s Lookout, under Your booking.</p>
        </>
      )}

      <div className="range-footer">
        <span className={`small ${error || (step === 1 && step1Error && chosen.length) ? 'error-text' : 'muted'}`} role={error ? 'alert' : undefined}>
          {error ?? (step === 1 ? (chosen.length ? step1Error ?? '' : '') : 'Fare tracking and destination ideas stop for these dates.')}
        </span>
        <div className="saved-actions">
          {step === 2 && !single ? (
            <button type="button" className="small" onClick={() => setStep(1)}>← Back</button>
          ) : (
            <button type="button" className="small" onClick={onCancel}>Cancel</button>
          )}
          <button type="submit" className="small primary" disabled={busy || (step === 1 && Boolean(step1Error)) || (step === 2 && !bookedOn)}>
            {step === 1 ? 'Next: getting around →' : busy ? 'Saving…' : 'Pop it on Puff’s lookout'}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Your booking, editable: each leg's way, times, price and details, each stay, and the booking date. */
export function ItineraryEditor({
  itinerary,
  places,
  start,
  end,
  bookedOn,
  onSave,
  onCancel,
}: {
  itinerary: Itinerary;
  places: PlaceChoice[];
  start: string;
  end: string;
  bookedOn: string | null;
  onSave: (b: { itinerary: Itinerary; bookedOn: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const dests = useDestinationData();
  const [it, setIt] = useState<Itinerary>(itinerary);
  const [on, setOn] = useState(bookedOn ?? todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const byId = new Map(places.map((p) => [p.id, p]));
  const stops = it.stops.map((s) => byId.get(s.destId)).filter((p): p is PlaceChoice => Boolean(p));
  const options = legOptions(dests, stops);
  const ends = legEnds(stops.map((s) => s.name));
  const dates = stopDates(it, start, end);
  const setLeg = (i: number, patch: Partial<Leg>) => setIt((x) => ({ ...x, legs: x.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const setStay = (i: number, patch: { name?: string; price?: string }) => setIt((x) => ({ ...x, stops: x.stops.map((s, j) => (j === i ? { ...s, stay: { ...s.stay, ...patch } } : s)) }));
  // Every leg can be changed here, including ways the data doesn't list (e.g. a car).
  const withCurrent = (o: TravelOption[], m: TravelMode | null) => (m && !o.some((x) => x.mode === m) ? [...o, { mode: m, label: '' }] : o);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ itinerary: it, bookedOn: on });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      className="booking-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      {ends.map(([from, to], i) => (
        <fieldset key={`leg-${i}`} className="booking-block">
          <legend>
            {from} → {to} · {dayLabel(i < dates.length ? dates[i].arrive : end)}
          </legend>
          <ModeChips options={withCurrent(options[i] ?? [], it.legs[i]?.mode ?? null)} value={it.legs[i]?.mode ?? null} onChange={(mode) => setLeg(i, { mode })} name={`${id}-m-${i}`} />
          <div className="range-fields booking-fields">
            <div className="field">
              <label htmlFor={`${id}-d-${i}`}>{it.legs[i]?.mode === 'flight' ? 'Flights' : 'Operator'}</label>
              <input id={`${id}-d-${i}`} maxLength={80} placeholder={it.legs[i]?.mode === 'flight' ? 'SQ618' : 'KKKL'} value={it.legs[i]?.detail ?? ''} onChange={(e) => setLeg(i, { detail: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-t1-${i}`}>Departs</label>
              <input id={`${id}-t1-${i}`} type="time" value={it.legs[i]?.depart ?? ''} onChange={(e) => setLeg(i, { depart: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-t2-${i}`}>Arrives</label>
              <input id={`${id}-t2-${i}`} type="time" value={it.legs[i]?.arrive ?? ''} onChange={(e) => setLeg(i, { arrive: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-p-${i}`}>Price</label>
              <input id={`${id}-p-${i}`} maxLength={30} placeholder="S$45" value={it.legs[i]?.price ?? ''} onChange={(e) => setLeg(i, { price: e.target.value })} />
            </div>
          </div>
          {i < stops.length && (
            <div className="range-fields booking-fields">
              <div className="field">
                <label htmlFor={`${id}-s-${i}`}>
                  Stay in {stops[i].name} · {it.stops[i].nights} night{it.stops[i].nights === 1 ? '' : 's'}
                </label>
                <input id={`${id}-s-${i}`} maxLength={80} placeholder="Hotel name" value={it.stops[i].stay?.name ?? ''} onChange={(e) => setStay(i, { name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`${id}-sp-${i}`}>Stay price</label>
                <input id={`${id}-sp-${i}`} maxLength={30} placeholder="S$180" value={it.stops[i].stay?.price ?? ''} onChange={(e) => setStay(i, { price: e.target.value })} />
              </div>
            </div>
          )}
        </fieldset>
      ))}
      <div className="range-fields booking-fields">
        <div className="field">
          <label htmlFor={`${id}-on`} title="Insurers such as FWD don't cover MFA advisories issued before you booked">Booked on</label>
          <input id={`${id}-on`} type="date" value={on} max={todayISO()} onChange={(e) => setOn(e.target.value)} />
        </div>
      </div>
      <div className="range-footer">
        <span className={`small ${error ? 'error-text' : 'muted'}`} role={error ? 'alert' : undefined}>
          {error ?? 'Everything here is optional.'}
        </span>
        <div className="saved-actions">
          <button type="button" className="small" onClick={onCancel}>Cancel</button>
          <button type="submit" className="small primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </form>
  );
}
