import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { haversineKm } from '../lib/geo';
import { services } from '../services';
import type { CityPoint, CountryPoint } from '../services/currentWeather';
import type { Destination } from '../services/destinations';

/** A place picked in the map finder. The map shows it in whatever form the current view needs. */
export interface FoundPlace {
  name: string;
  cc: string;
  countryName?: string;
  admin1?: string;
  lat: number;
  lon: number;
  /** The destination it is (flight, ferry, overland or via), if any. */
  dest?: Destination;
  /** Its marker on the live map, if it has one. */
  city?: CityPoint;
  /** Set when the country itself was picked (lat/lon are then its capital's). */
  country?: CountryPoint;
}

export interface FinderRow {
  key: string;
  label: string;
  sub: string;
  value: FoundPlace;
}

/** Below this many known matches, place-name search (Open-Meteo geocoding) fills in. */
const GEOCODE_BELOW = 5;

/**
 * "Find a city…" over the map's top-right corner: known places as you type, then place-name
 * search for anything else. Arrow keys move, Enter picks, Esc closes.
 */
export function MapFinder({ search, onPick, onClose }: { search: (q: string) => FinderRow[]; onPick: (p: FoundPlace) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [local, setLocal] = useState<FinderRow[]>([]);
  const [other, setOther] = useState<FinderRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rows = search(text);
    setLocal(rows);
    setOther([]);
    setActive(0);
    const q = text.trim();
    if (q.length < 3 || rows.length >= GEOCODE_BELOW) return setSearching(false);
    const ctrl = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      services.geocoding
        .search(q, ctrl.signal)
        .then((places) =>
          setOther(
            places
              .filter((p) => !rows.some((r) => haversineKm(r.value.lat, r.value.lon, p.latitude, p.longitude) < 25))
              .map((p) => ({
                key: `g:${p.id}`,
                label: p.name,
                sub: [p.admin1, p.country].filter(Boolean).join(', '),
                value: { name: p.name, cc: p.countryCode, countryName: p.country, admin1: p.admin1, lat: p.latitude, lon: p.longitude },
              })),
          ),
        )
        .catch(() => setOther([]))
        .finally(() => !ctrl.signal.aborted && setSearching(false));
    }, 300);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [text, search]);

  // Bring the field into view (the map's top may be scrolled under the top bar).
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // Clicking elsewhere closes the finder.
  useEffect(() => {
    // The 🔍 button toggles the finder itself.
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element;
      if (ref.current && !ref.current.contains(el) && !el.closest?.('[data-finder-toggle]')) onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const rows = [...local, ...other];
  const pick = (i: number) => rows[i] && onPick(rows[i].value);
  const q = text.trim();

  return (
    <div className="map-finder" ref={ref}>
      <div className="map-finder-field">
        <span aria-hidden>🔍</span>
        <input
          type="text"
          role="combobox"
          autoFocus
          aria-expanded={rows.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={rows.length ? `${id}-${active}` : undefined}
          aria-label="Find a city or country on the map"
          placeholder="Find a city…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(rows.length - 1, a + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
            else if (e.key === 'Enter') (e.preventDefault(), pick(active));
            else if (e.key === 'Escape') (e.preventDefault(), onClose()); // the map's own Escape closes the pin
          }}
        />
        <button type="button" className="map-finder-close" aria-label="Close search" onClick={onClose}>✕</button>
      </div>
      {q.length >= 2 && (
        <ul className="cmp-results map-finder-results" id={`${id}-list`} role="listbox">
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              {i === local.length && <li role="presentation" className="map-finder-group small muted">Other places</li>}
              <li id={`${id}-${i}`} role="option" aria-selected={i === active}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
                  <strong>{r.label}</strong> <span className="small muted">{r.sub}</span>
                </button>
              </li>
            </Fragment>
          ))}
          {searching && <li className="small muted map-finder-note">Searching more places…</li>}
          {!searching && rows.length === 0 && <li className="small muted map-finder-note">No places found for “{q}”</li>}
        </ul>
      )}
    </div>
  );
}
