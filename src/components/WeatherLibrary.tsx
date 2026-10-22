import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LEVEL_LABEL, type PageLevel } from '../lib/advisory';
import { alertsAt } from '../lib/alerts';
import { bestMonthsLabel, nextGoodMonth, type MonthRating } from '../lib/monthRatings';
import { flagOf, REGIONS, regionOf, type Region } from '../lib/regions';
import { safetyAt, useAdvisories } from '../services/advisories';
import { useAlerts } from '../services/alerts';
import { getLibrary, requestDownload, type Library, type LibraryPlace } from '../services/library';
import { gettingThere, useDestinationData, type GettingThereKind } from '../services/travelOptions';
import { onWanderList, toggleWander, useWanderList } from '../services/wander';
import { Mascot } from './Brand';
import { Notice } from './ui';

type Show = 'all' | 'ready' | 'partial' | 'saved' | 'wander';
type Group = 'region' | 'country' | 'getting' | 'flight' | 'none';
type Sort = 'nearest' | 'wander' | 'driest' | 'priority' | 'years' | 'name';
type MfaLevel = 'all' | 'nonEssential' | 'caution';
type Band = 'b2' | 'b4' | 'b7' | 'b7p';
type AlertFilter = 'any' | 'hide' | 'only';

const PAGE = 50;
const POLL_MS = 30_000;
const PREFS_KEY = 'wandercast.library.v2';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LETTERS = 'JFMAMJJASOND';

const KIND: Record<GettingThereKind, { label: string; icon: string }> = {
  direct: { label: 'Direct flight', icon: '✈' },
  connection: { label: 'Connecting flight', icon: '✈' },
  via: { label: 'Via a direct-flight city', icon: '↪' },
  ferry: { label: 'Ferry', icon: '⛴' },
  overland: { label: 'Overland', icon: '🚌' },
};
const BANDS: { key: Band; label: string; max: number }[] = [
  { key: 'b2', label: 'Up to 2 h', max: 2 },
  { key: 'b4', label: '2–4 h', max: 4 },
  { key: 'b7', label: '4–7 h', max: 7 },
  { key: 'b7p', label: '7 h+', max: Infinity },
];
const bandOf = (h: number): Band => BANDS.find((b) => h <= b.max)!.key;
const MFA: { key: MfaLevel; icon: string }[] = [
  { key: 'all', icon: '🚫' },
  { key: 'nonEssential', icon: '⚠' },
  { key: 'caution', icon: 'ℹ' },
];
const RATING_CLASS: Record<string, string> = { Pleasant: 'pleasant', 'Generally pleasant': 'generally-pleasant', Mixed: 'mixed', Challenging: 'challenging' };

interface Prefs {
  show: Show;
  group: Group;
  sort: Sort;
  sortMonth: number;
  region: Region | null;
  kinds: GettingThereKind[];
  bands: Band[];
  goodIn: number | null;
  mfaHidden: MfaLevel[];
  alerts: AlertFilter;
  collapsed: string[];
  filtersOpen: boolean;
}
const thisMonth = () => new Date().getMonth() + 1;
const DEFAULTS: Prefs = {
  show: 'all',
  group: 'region',
  sort: 'nearest',
  sortMonth: thisMonth(),
  region: null,
  kinds: [],
  bands: [],
  goodIn: null,
  mfaHidden: ['all'],
  alerts: 'any',
  collapsed: [],
  filtersOpen: false,
};

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

const placeKey = (p: LibraryPlace) => `${p.lat},${p.lon}`;
const toggleIn = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

/** A library place with what the table and filters need, worked out once per load. */
interface Row {
  p: LibraryPlace;
  region: Region | null;
  kind: GettingThereKind;
  hours: number;
  travel: string;
  mfa: PageLevel;
  alerts: { near: number; country: number };
  wander: boolean;
}

/**
 * The weather library as a bucket list: every place with stored history, how you'd get there,
 * its best months (Sunny windows' scoring, per calendar month) and when it's next good. Filters
 * fold away behind one button; groups (region by default) fold too. 🎈 marks your wander list.
 */
export function WeatherLibrary({ onOpen }: { onOpen: (p: LibraryPlace) => void }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [shown, setShown] = useState(PAGE);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [requestError, setRequestError] = useState<string | null>(null);
  const dests = useDestinationData();
  const { ctx: advisories } = useAdvisories();
  const allAlerts = useAlerts();
  const wander = useWanderList();

  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the choice lasts this visit */
      }
      return next;
    });

  const load = () =>
    getLibrary()
      .then((l) => (setLib(l), setError(null)))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  // Refresh while anything is queued or downloading.
  const busy = Boolean(lib?.places.some((p) => p.queue) || requested.size);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [busy]);

  const all: Row[] = useMemo(() => {
    if (!lib) return [];
    return lib.places.map((p) => {
      const g = dests ? gettingThere(dests, p.lat, p.lon) : { kind: 'connection' as const, hours: Infinity, label: '' };
      const kind = p.overland && g.kind !== 'ferry' && g.kind !== 'direct' ? 'overland' : g.kind;
      const at = p.cc ? alertsAt(allAlerts, { cc: p.cc, lat: p.lat, lon: p.lon }) : { near: [], country: [] };
      return {
        p,
        region: p.cc ? regionOf(p.cc) : null,
        kind,
        hours: g.hours,
        travel: g.label,
        mfa: advisories && p.cc ? safetyAt(advisories, { cc: p.cc, lat: p.lat, lon: p.lon }).advisory.level : 'none',
        alerts: { near: at.near.length, country: at.country.length },
        wander: onWanderList(wander, p.lat, p.lon),
      };
    });
  }, [lib, dests, advisories, allAlerts, wander]);

  const q = query.trim().toLowerCase();
  const passes = (r: Row, skip?: 'region') => {
    const { p } = r;
    if (q && !`${p.name} ${p.country}`.toLowerCase().includes(q)) return false;
    if (prefs.show === 'ready' && p.status !== 'ready') return false;
    if (prefs.show === 'partial' && p.status !== 'partial') return false;
    if (prefs.show === 'saved' && !(p.saved || p.queue !== null)) return false;
    if (prefs.show === 'wander' && !r.wander) return false;
    if (skip !== 'region' && prefs.region && r.region !== prefs.region) return false;
    if (prefs.kinds.length && !prefs.kinds.includes(r.kind)) return false;
    if (prefs.bands.length && !prefs.bands.includes(bandOf(r.hours))) return false;
    if (prefs.goodIn && !goodInMonth(p.months, prefs.goodIn)) return false;
    if (r.mfa !== 'none' && r.mfa !== 'unknown' && prefs.mfaHidden.includes(r.mfa)) return false;
    const alerted = r.alerts.near + r.alerts.country > 0;
    if (prefs.alerts === 'hide' && alerted) return false;
    if (prefs.alerts === 'only' && !alerted) return false;
    return true;
  };

  const rows = useMemo(() => {
    const cmp = (a: Row, b: Row) => {
      const byName = a.p.name.localeCompare(b.p.name);
      switch (prefs.sort) {
        case 'name':
          return byName;
        case 'nearest':
          return a.hours - b.hours || byName;
        case 'wander':
          return Number(b.wander) - Number(a.wander) || a.hours - b.hours || byName;
        case 'driest': {
          const wa = a.p.months?.[prefs.sortMonth - 1]?.wetShare ?? Infinity;
          const wb = b.p.months?.[prefs.sortMonth - 1]?.wetShare ?? Infinity;
          return wa - wb || byName;
        }
        case 'years':
          return b.p.years - a.p.years || byName;
        default:
          return (a.p.priority ?? Infinity) - (b.p.priority ?? Infinity) || b.p.years - a.p.years || byName;
      }
    };
    return all.filter((r) => passes(r)).sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, q, prefs]);

  // Groups in a fixed order (regions as listed, others by name; nearest band first).
  const groups = useMemo(() => {
    const keyOf = (r: Row): { key: string; label: string; icon: string; order: number } => {
      switch (prefs.group) {
        case 'region': {
          const i = REGIONS.findIndex((x) => x.name === r.region);
          return i < 0 ? { key: 'other', label: 'Other places', icon: '🧭', order: 99 } : { key: REGIONS[i].name, label: REGIONS[i].name, icon: REGIONS[i].icon, order: i };
        }
        case 'country':
          return r.p.country ? { key: r.p.cc, label: r.p.country, icon: flagOf(r.p.cc), order: 0 } : { key: 'other', label: 'Other places', icon: '🧭', order: 1 };
        case 'getting': {
          const order: GettingThereKind[] = ['direct', 'ferry', 'overland', 'via', 'connection'];
          return { key: r.kind, label: KIND[r.kind].label, icon: KIND[r.kind].icon, order: order.indexOf(r.kind) };
        }
        case 'flight': {
          const b = bandOf(r.hours);
          const i = BANDS.findIndex((x) => x.key === b);
          return { key: b, label: BANDS[i].label, icon: '✈', order: i };
        }
        default:
          return { key: 'all', label: '', icon: '', order: 0 };
      }
    };
    const map = new Map<string, { key: string; label: string; icon: string; order: number; rows: Row[] }>();
    for (const r of rows) {
      const k = keyOf(r);
      if (!map.has(k.key)) map.set(k.key, { ...k, rows: [] });
      map.get(k.key)!.rows.push(r);
    }
    return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [rows, prefs.group]);

  const download = async (p: LibraryPlace) => {
    setRequestError(null);
    setRequested((s) => new Set(s).add(placeKey(p)));
    try {
      await requestDownload(p);
      await load();
    } catch (e) {
      setRequestError(`${p.name} could not be queued: ${(e as Error).message}`);
    } finally {
      setRequested((s) => {
        const n = new Set(s);
        n.delete(placeKey(p));
        return n;
      });
    }
  };

  const wanderToggle = (p: LibraryPlace) =>
    void toggleWander({ name: p.name, country: p.country, cc: p.cc, lat: p.lat, lon: p.lon }).catch((e: Error) => setRequestError(`Your wander list couldn't be saved: ${e.message}`));

  const ready = lib?.places.filter((p) => p.status === 'ready').length ?? 0;
  const regionCounts = useMemo(() => {
    const c = new Map<Region, number>();
    for (const r of all) if (r.region && passes(r, 'region')) c.set(r.region, (c.get(r.region) ?? 0) + 1);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, q, prefs]);
  const mfaCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of all) c[r.mfa] = (c[r.mfa] ?? 0) + 1;
    return c;
  }, [all]);

  // Active filters, as removable chips (the default "defer all travel hidden" is a quiet note instead).
  const active: { label: string; clear: () => void }[] = [];
  if (prefs.region) active.push({ label: `${REGIONS.find((r) => r.name === prefs.region)?.icon ?? ''} ${prefs.region}`, clear: () => setPrefs({ region: null }) });
  for (const k of prefs.kinds) active.push({ label: `${KIND[k].icon} ${KIND[k].label}`, clear: () => setPrefs({ kinds: prefs.kinds.filter((x) => x !== k) }) });
  for (const b of prefs.bands) active.push({ label: `✈ ${BANDS.find((x) => x.key === b)!.label}`, clear: () => setPrefs({ bands: prefs.bands.filter((x) => x !== b) }) });
  if (prefs.goodIn) active.push({ label: `☀ Good in ${MON[prefs.goodIn - 1]}`, clear: () => setPrefs({ goodIn: null }) });
  const mfaDefault = prefs.mfaHidden.length === 1 && prefs.mfaHidden[0] === 'all';
  if (!mfaDefault) {
    for (const m of prefs.mfaHidden) active.push({ label: `Hiding ${MFA.find((x) => x.key === m)!.icon} ${LEVEL_LABEL[m]}`, clear: () => setPrefs({ mfaHidden: prefs.mfaHidden.filter((x) => x !== m) }) });
    if (!prefs.mfaHidden.includes('all')) active.push({ label: `Showing 🚫 ${LEVEL_LABEL.all}`, clear: () => setPrefs({ mfaHidden: [...prefs.mfaHidden, 'all'] }) });
  }
  if (prefs.alerts !== 'any') active.push({ label: prefs.alerts === 'hide' ? 'Hiding places with alerts' : 'Only places with alerts', clear: () => setPrefs({ alerts: 'any' }) });
  const deferAllHidden = mfaDefault ? (mfaCounts.all ?? 0) : 0;
  const unrated = prefs.goodIn || prefs.sort === 'driest' ? all.filter((r) => !r.p.months?.some(Boolean)).length : 0;

  const groupKey = (k: string) => `${prefs.group}:${k}`;
  const collapsed = new Set(prefs.collapsed);
  const now = thisMonth();
  let budget = shown;
  const total = rows.length;

  return (
    <section className="card library" aria-labelledby="lib-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="lib-h">📚 Weather library</h2>
          <p className="small muted">
            {lib
              ? `${lib.places.length} places with weather history · ${ready} ready for Sunny windows · 🎈 ${wander.length} on your wander list`
              : 'Places with weather history saved in the local database.'}
          </p>
        </div>
      </div>

      {error && (
        <Notice kind="err" title="The library could not be loaded">
          <p>{error}</p>
        </Notice>
      )}
      {!lib && !error && (
        <div className="mascot-row">
          <Mascot mood="searching" size={56} />
          <p className="small muted">Counting the years saved for each place…</p>
        </div>
      )}

      {lib && (
        <>
          <div className="lib-controls">
            <input type="search" placeholder="Search places" aria-label="Search places" value={query} onChange={(e) => (setQuery(e.target.value), setShown(PAGE))} />
            <select aria-label="Show" value={prefs.show} onChange={(e) => (setPrefs({ show: e.target.value as Show }), setShown(PAGE))}>
              <option value="all">All places</option>
              <option value="wander">🎈 Wander list</option>
              <option value="ready">Ready</option>
              <option value="partial">Partial</option>
              <option value="saved">Saved and queued</option>
            </select>
            <select aria-label="Group by" value={prefs.group} onChange={(e) => setPrefs({ group: e.target.value as Group })}>
              <option value="region">Group: Region</option>
              <option value="country">Group: Country</option>
              <option value="getting">Group: Getting there</option>
              <option value="flight">Group: Flight time</option>
              <option value="none">No grouping</option>
            </select>
            <select aria-label="Sort by" value={prefs.sort} onChange={(e) => setPrefs({ sort: e.target.value as Sort })}>
              <option value="nearest">Sort: Nearest first</option>
              <option value="wander">Sort: 🎈 Wander list first</option>
              <option value="driest">Sort: Driest in a month</option>
              <option value="priority">Sort: Download order</option>
              <option value="years">Sort: Most years</option>
              <option value="name">Sort: Name</option>
            </select>
            {prefs.sort === 'driest' && (
              <select aria-label="Driest in" value={prefs.sortMonth} onChange={(e) => setPrefs({ sortMonth: Number(e.target.value) })}>
                {MON.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            )}
          </div>

          <div className="lib-filterbar">
            <button type="button" className="lib-filter-btn" aria-expanded={prefs.filtersOpen} aria-controls="lib-filters" onClick={() => setPrefs({ filtersOpen: !prefs.filtersOpen })}>
              ⚙ Filters {active.length > 0 && <span className="lib-count">{active.length}</span>} <span aria-hidden>{prefs.filtersOpen ? '▴' : '▾'}</span>
            </button>
            {active.map((a) => (
              <span key={a.label} className="lib-active">
                {a.label}
                <button type="button" aria-label={`Remove filter: ${a.label}`} onClick={a.clear}>
                  ✕
                </button>
              </span>
            ))}
            {deferAllHidden > 0 && (
              <span className="small muted">
                {active.length ? '· ' : ''}Places with MFA “defer all travel” advice are hidden ({deferAllHidden}) ·{' '}
                <button type="button" className="link-button small" onClick={() => setPrefs({ mfaHidden: [] })}>
                  Show
                </button>
              </span>
            )}
            {prefs.group !== 'none' && (
              <span className="lib-fold-all small">
                <button type="button" className="link-button small" onClick={() => setPrefs({ collapsed: groups.map((g) => groupKey(g.key)) })}>
                  Collapse all
                </button>
                {' · '}
                <button type="button" className="link-button small" onClick={() => setPrefs({ collapsed: [] })}>
                  Expand all
                </button>
              </span>
            )}
          </div>

          {prefs.filtersOpen && (
            <div className="lib-filters" id="lib-filters">
              <FilterRow label="Region">
                <Chip on={!prefs.region} onClick={() => setPrefs({ region: null })}>All</Chip>
                {REGIONS.filter((r) => regionCounts.get(r.name)).map((r) => (
                  <Chip key={r.name} on={prefs.region === r.name} onClick={() => setPrefs({ region: prefs.region === r.name ? null : r.name })}>
                    {r.name} <span className="muted">{regionCounts.get(r.name)}</span>
                  </Chip>
                ))}
              </FilterRow>
              <FilterRow label="Getting there">
                {(['direct', 'connection', 'ferry', 'overland', 'via'] as const).map((k) => (
                  <Chip key={k} on={prefs.kinds.includes(k)} onClick={() => setPrefs({ kinds: toggleIn(prefs.kinds, k) })}>
                    {KIND[k].icon} {KIND[k].label}
                  </Chip>
                ))}
              </FilterRow>
              <FilterRow label="Travel time">
                {BANDS.map((b) => (
                  <Chip key={b.key} on={prefs.bands.includes(b.key)} onClick={() => setPrefs({ bands: toggleIn(prefs.bands, b.key) })}>
                    {b.label}
                  </Chip>
                ))}
              </FilterRow>
              <FilterRow label="Good in">
                <select aria-label="Good in" value={prefs.goodIn ?? ''} onChange={(e) => setPrefs({ goodIn: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Any month</option>
                  {MON.map((m, i) => (
                    <option key={m} value={i + 1}>{m}</option>
                  ))}
                </select>
                <span className="small muted">Typical weather rated Pleasant or Generally pleasant that month</span>
              </FilterRow>
              <FilterRow label="MFA advice">
                {MFA.map((m) => {
                  const hidden = prefs.mfaHidden.includes(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      className={`legend-chip lib-chip${hidden ? ' hid' : ''}`}
                      aria-pressed={!hidden}
                      title={hidden ? 'Hidden: click to show' : 'Shown: click to hide'}
                      onClick={() => setPrefs({ mfaHidden: toggleIn(prefs.mfaHidden, m.key) })}
                    >
                      {m.icon} {LEVEL_LABEL[m.key]} <span className="muted">{mfaCounts[m.key] ?? 0}</span>
                    </button>
                  );
                })}
                <span className="small muted">Click to hide or show · by each place’s own MFA area</span>
              </FilterRow>
              <FilterRow label="Recent alerts">
                {(['any', 'hide', 'only'] as const).map((a) => (
                  <Chip key={a} on={prefs.alerts === a} onClick={() => setPrefs({ alerts: a })}>
                    {a === 'any' ? 'Any' : a === 'hide' ? 'Hide places with alerts' : 'Only places with alerts'}
                  </Chip>
                ))}
              </FilterRow>
            </div>
          )}
          {unrated > 0 && <p className="small muted">{unrated} places don’t have enough history yet for monthly ratings, so they’re left out of “Good in” and sort last by dryness.</p>}
          {requestError && <p className="small error-text" role="alert">{requestError}</p>}

          <div className="table-wrap">
            <table className="lib-table">
              <thead>
                <tr>
                  <th className="lib-w">
                    <span title="Wander list: places you'd like to visit someday">🎈</span>
                  </th>
                  <th>Place</th>
                  <th>Getting there</th>
                  <th>
                    <span className="lib-months-head">
                      <span className="month-letters" aria-hidden>
                        {[...MONTH_LETTERS].map((c, i) => (
                          <span key={i}>{c}</span>
                        ))}
                      </span>
                      <MonthKey />
                    </span>
                    <span className="sr-only">Best months</span>
                  </th>
                  <th>Next good spell</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const folded = prefs.group !== 'none' && collapsed.has(groupKey(g.key));
                  const take = folded ? [] : g.rows.slice(0, Math.max(0, budget));
                  if (!folded) budget -= take.length;
                  if (!folded && !take.length && prefs.group !== 'none') return null;
                  const wanderN = g.rows.filter((r) => r.wander).length;
                  return (
                    <Fragment key={g.key}>
                      {prefs.group !== 'none' && (
                        <tr className="lib-group">
                          <th colSpan={6}>
                            <button
                              type="button"
                              aria-expanded={!folded}
                              onClick={() => setPrefs({ collapsed: folded ? prefs.collapsed.filter((k) => k !== groupKey(g.key)) : [...prefs.collapsed, groupKey(g.key)] })}
                            >
                              <span className="lib-chev" aria-hidden>{folded ? '▸' : '▾'}</span>
                              <span aria-hidden>{g.icon}</span> <span className="lib-group-name">{g.label}</span>
                              <span className="lib-pill">{g.rows.length} place{g.rows.length === 1 ? '' : 's'}</span>
                              {wanderN > 0 && <span className="lib-pill">🎈 {wanderN}</span>}
                            </button>
                          </th>
                        </tr>
                      )}
                      {take.map((r) => (
                        <PlaceRow
                          key={placeKey(r.p)}
                          r={r}
                          now={now}
                          pending={requested.has(placeKey(r.p))}
                          onOpen={() => onOpen(r.p)}
                          onDownload={() => void download(r.p)}
                          onWander={() => wanderToggle(r.p)}
                        />
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total === 0 && <p className="small muted">No places match.</p>}
          {total > shown && (
            <button type="button" className="small" style={{ justifySelf: 'start' }} onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, total - shown)} more <span className="muted">({total - shown} left)</span>
            </button>
          )}
          <p className="small muted">
            Best months rate each calendar month’s typical weather with the same scoring as Sunny windows, from up to {lib.needed} years of stored history. Travel times are
            door to door estimates from Singapore. Places still gathering history can be downloaded in the background (the saved-dates share of the free Open-Meteo
            allowance; kept permanently).
          </p>
        </>
      )}
    </section>
  );
}

function goodInMonth(months: (MonthRating | null)[] | null, month: number): boolean {
  const r = months?.[month - 1]?.rating;
  return r === 'Pleasant' || r === 'Generally pleasant';
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lib-filter-row" role="group" aria-label={label}>
      <span className="lib-filter-label">{label}</span>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="legend-chip lib-chip" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

/** The colour key for the month strips, behind an ⓘ on the column header. */
function MonthKey() {
  return (
    <span className="lib-key" tabIndex={0} aria-label="Colour key for best months">
      ⓘ
      <span className="lib-key-pop" role="tooltip">
        {(['pleasant', 'generally-pleasant', 'mixed', 'challenging'] as const).map((c) => (
          <span key={c}>
            <i className={`month-cell ${c}`} /> {c === 'generally-pleasant' ? 'Generally pleasant' : c[0].toUpperCase() + c.slice(1)}
          </span>
        ))}
        <span>
          <i className="month-cell nodata" /> No data yet
        </span>
        <span className="muted">Typical weather by month, scored as in Sunny windows. The outlined month is this month.</span>
      </span>
    </span>
  );
}

function PlaceRow({ r, now, pending, onOpen, onDownload, onWander }: { r: Row; now: number; pending: boolean; onOpen: () => void; onDownload: () => void; onWander: () => void }) {
  const { p } = r;
  const months = p.months;
  const best = months ? bestMonthsLabel(months) : null;
  const next = months ? nextGoodMonth(months, now) : null;
  const gathering =
    p.status === 'ready'
      ? null
      : p.queue === 'downloading'
        ? `Downloading · ${p.years} of ${p.needed} years`
        : p.queue === 'waiting'
          ? `Waiting for the daily weather allowance · ${p.years} of ${p.needed} years`
          : p.queue === 'queued'
            ? `Queued · ${p.years} of ${p.needed} years`
            : `Gathering history · ${p.years} of ${p.needed} years`;
  const mfaShown = r.mfa === 'all' || r.mfa === 'nonEssential' || r.mfa === 'caution';
  return (
    <tr>
      <td className="lib-w">
        <button
          type="button"
          className={`lib-balloon${r.wander ? '' : ' off'}`}
          aria-pressed={r.wander}
          aria-label={r.wander ? `Remove ${p.name} from your wander list` : `Add ${p.name} to your wander list`}
          title={r.wander ? 'On your wander list' : 'Add to your wander list'}
          onClick={onWander}
        >
          🎈
        </button>
      </td>
      <td>
        {p.status === 'ready' ? (
          <button type="button" className="link-button lib-name" onClick={onOpen}>
            {p.name}
          </button>
        ) : (
          <strong>{p.name}</strong>
        )}
        {p.saved && <span className="lib-star" title="On your saved dates"> ★</span>}
        {p.country && <span className="small muted"> {p.country}</span>}
        {mfaShown && (
          <>
            {' '}
            <span className={`badge tone-${r.mfa === 'caution' ? 'warning' : 'critical'} lib-badge`} title="Singapore MFA travel advice for this area">
              MFA: {LEVEL_LABEL[r.mfa]}
            </span>
          </>
        )}
        {r.alerts.near > 0 && (
          <>
            {' '}
            <span className="badge tone-warning lib-badge" title="US embassy or UK FCDO alert near here in the last 14 days">
              ⚠ Recent alert
            </span>
          </>
        )}
      </td>
      <td className="lib-travel small">{r.travel}</td>
      <td>
        <div className="lib-months">
          <span className="month-strip" role="img" aria-label={months ? `Best months: ${best ?? 'no standout month'}` : 'No monthly ratings yet'}>
            {Array.from({ length: 12 }, (_, i) => {
              const m = months?.[i] ?? null;
              return (
                <i
                  key={i}
                  className={`month-cell ${m ? RATING_CLASS[m.rating] : 'nodata'}${i + 1 === now ? ' now' : ''}`}
                  title={`${MON[i]}: ${m ? m.rating : 'no data yet'}`}
                />
              );
            })}
          </span>
          <span className="small secondary">{gathering ?? (best ? `Best ${best}` : months?.some(Boolean) ? 'No standout month' : 'No monthly ratings yet')}</span>
        </div>
      </td>
      <td className="small">{next === 'now' ? <strong className="lib-good-now">Good now</strong> : next ? `From ${next}` : '—'}</td>
      <td className="lib-action">
        {p.status === 'ready' ? (
          <button type="button" className="small lib-open" onClick={onOpen}>
            ☀ Sunny windows
          </button>
        ) : p.queue ? null : (
          <button type="button" className="small" disabled={pending} onClick={onDownload} title="Download the missing years in the background (stored permanently)">
            {pending ? 'Queuing…' : 'Download'}
          </button>
        )}
      </td>
    </tr>
  );
}
