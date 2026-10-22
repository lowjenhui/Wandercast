import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatShortDate, monthsInRange } from '../lib/dates';
import { rankCandidates, rateOutlook, RATING_CLASS, type SortMode } from '../lib/outlook';
import { services } from '../services';
import { destinationHours, destinationId, destinationPlace, directAirlinesOn, loadDestinations, travelLabel, type Destination } from '../services/destinations';
import { describePlan, getOutlookStore, usableOutlook } from '../services/tripOutlook';
import { useAdvisoryLevels } from '../services/advisories';
import { useAlerts } from '../services/alerts';
import { alertsAt } from '../lib/alerts';
import { Mascot } from './Brand';
import { onWanderList, useWanderList } from '../services/wander';
import { Badge, Notice, type Tone } from './ui';

const TONE: Record<'good' | 'average' | 'bad', Tone> = { good: 'good', average: 'warning', bad: 'critical' };
/** Cards shown at first, and added by each "Show more". */
const STEP = 5;

/**
 * Ranked destination suggestions for the chosen dates, as compact cards for the planner's side
 * panel. Hovering a card highlights the place on the map; clicking it zooms the map there and
 * expands the card with its actions.
 */
export function Suggestions({
  start,
  end,
  onAnalyse,
  onWhenToGo,
  onHover,
  onSelect,
  selectedCode,
  showVia = false,
}: {
  start: string;
  end: string;
  onAnalyse: (d: Destination) => void;
  /** Sunny windows for a destination: its best dates over the next 12 months. */
  onWhenToGo?: (d: Destination) => void;
  onHover?: (d: Destination | null) => void;
  onSelect?: (d: Destination) => void;
  selectedCode?: string | null;
  /** Include places reached via a direct-flight city (follows the map's "Via places" toggle). */
  showVia?: boolean;
}) {
  const [dests, setDests] = useState<Destination[] | null>(null);
  const wander = useWanderList();
  const [error, setError] = useState<string | null>(null);
  const [maxHours, setMaxHours] = useState<number | null>(null);
  const [sort, setSort] = useState<SortMode>('balanced');
  const [visible, setVisible] = useState(STEP);
  const [directOnly, setDirectOnly] = useState(false);
  const { store, plan } = useMemo(() => getOutlookStore(start, end), [start, end]);
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const status = store.getStatus();

  useEffect(() => {
    loadDestinations().then(setDests).catch((e: Error) => setError(e.message));
  }, []);

  // Hidden gateway places aren't requested, so they cost no API budget while "Via places" is off.
  const shown = useMemo(() => dests?.filter((d) => showVia || !d.via) ?? null, [dests, showVia]);
  useEffect(() => {
    if (shown && plan.basis !== 'none') store.request(shown.map((d) => ({ id: destinationId(d), lat: d.lat, lon: d.lon })));
  }, [shown, store, plan]);

  const months = useMemo(() => monthsInRange(start, end), [start, end]);
  const candidates = useMemo(() => {
    if (!dests) return [];
    return dests.map((d) => {
      const raw = store.get(destinationId(d));
      const o = usableOutlook(raw);
      const risks = services.risks.risksFor(destinationPlace(d), months);
      return { dest: d, hours: destinationHours(d), suitability: o ? rateOutlook(o, risks) : null, outlook: o, pending: raw?.pending ? raw : null, risks };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dests, store, version, months]);

  // MFA "defer all travel" places are left out (listed under the list); others are flagged.
  const levels = useAdvisoryLevels(dests, destinationId);
  // Recent unrest alerts naming a card's city: a flag only, never filtering or ranking.
  const alerts = useAlerts();
  const filtered = candidates.filter((c) => (showVia || !c.dest.via) && (!directOnly || directAirlinesOn(c.dest, start) || c.dest.ferry || c.dest.land));
  const deferred = filtered.filter((c) => levels.get(destinationId(c.dest)) === 'all');
  const pool = filtered.filter((c) => levels.get(destinationId(c.dest)) !== 'all');
  const ranked = rankCandidates(pool, sort, maxHours) as typeof candidates;
  const loaded = candidates.filter((c) => (showVia || !c.dest.via) && c.outlook !== undefined && !c.pending).length;
  const queued = candidates.filter((c) => (showVia || !c.dest.via) && c.pending).length;
  const total = shown?.length ?? 0;
  // A selection ranked below the shown cards is pinned first (keeping its rank), so the list
  // stays short instead of growing down to it. A new selection starts again from the top 5.
  const selectedIndex = selectedCode ? ranked.findIndex((c) => destinationId(c.dest) === selectedCode) : -1;
  useEffect(() => setVisible(STEP), [selectedCode]);
  const pinned = selectedIndex >= visible;
  const rows = (pinned ? [selectedIndex, ...ranked.slice(0, visible - 1).map((_, i) => i)] : ranked.slice(0, visible).map((_, i) => i)).map((rank) => ({ ...ranked[rank], rank }));

  return (
    <section className="panel-section" aria-labelledby="sug-h">
      <div className="panel-head">
        <h2 id="sug-h">Sunny picks for your dates</h2>
        <span className="small muted">
          {formatShortDate(start)} – {formatShortDate(end)} ·{' '}
          <span title={describePlan(plan)}>{plan.basis === 'forecast' ? 'forecast' : plan.basis === 'typical' ? 'typical weather' : 'no outlook'}</span>
        </span>
      </div>

      <div className="sug-controls">
        <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
          <option value="balanced">Best weather + short trip</option>
          <option value="weather">Best weather</option>
          <option value="flight">Shortest travel</option>
        </select>
        <select aria-label="Maximum travel time" value={maxHours ?? ''} onChange={(e) => setMaxHours(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any distance</option>
          <option value="3">Up to 3h</option>
          <option value="5">Up to 5h</option>
          <option value="8">Up to 8h</option>
          <option value="13">Up to 13h</option>
        </select>
        <label className="toggle">
          <input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} />
          Direct, ferry or overland
        </label>
      </div>

      {error && <Notice kind="err" title="Destinations could not be loaded"><p>{error}</p></Notice>}
      {plan.basis === 'none' && <Notice kind="warn" title="No weather outlook available"><p>{plan.reason}</p></Notice>}
      {status.rateLimitedUntil && (
        <div className="mascot-row">
          <Mascot mood="sleepy" size={56} float={false} />
          <p className="small tone-warning">Puff is waiting for more weather API budget; more destinations will load shortly.</p>
        </div>
      )}
      {dests && loaded === 0 && plan.basis !== 'none' && !status.rateLimitedUntil && (
        <div className="mascot-row">
          <Mascot mood="searching" size={56} />
          <p className="small muted">Scouting the skies for your dates…</p>
        </div>
      )}
      {dests && loaded < total && plan.basis !== 'none' && (
        <div className="load-line" aria-live="polite">
          <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.round((loaded / total) * 100)}%` }} /></div>
          <span className="small muted">Weather for {loaded} of {total} places{queued ? ` · ${queued} not stored yet, downloading in the background` : ''}</span>
        </div>
      )}

      {dests && (
        <ol className="sug-list">
          {rows.map(({ dest, suitability, outlook, pending, risks, rank }) => {
            const cls = suitability ? RATING_CLASS[suitability.rating] : null;
            const serious = risks.filter((r) => r.severity !== 'info');
            const mfa = levels.get(destinationId(dest));
            const alerted = alertsAt(alerts, dest).near.length > 0;
            const travel = travelLabel(dest, start);
            const selected = selectedCode === destinationId(dest);
            return (
              <li
                key={destinationId(dest)}
                className={`sug-card${selected ? ' selected' : ''}`}
                onMouseEnter={() => onHover?.(dest)}
                onMouseLeave={() => onHover?.(null)}
              >
                <button type="button" className="sug-main" onClick={() => onSelect?.(dest)} title="Show on map">
                  <span className={`sug-rank${cls ? ` ${cls}` : ''}`}>{rank + 1}</span>
                  <span className="sug-body">
                    <span className="sug-title">
                      <strong>{dest.name}</strong>
                      <span className="muted">{dest.country ?? dest.cc}</span>
                      {onWanderList(wander, dest.lat, dest.lon) && <span className="sug-wander" title="On your wander list">🎈 Wander list</span>}
                      {pinned && rank === selectedIndex && <span className="sug-pinned">Selected</span>}
                    </span>
                    <span className="sug-meta">
                      <span>{travel}</span>
                      {outlook ? (
                        <>
                          <span>{Math.round(outlook.tMaxC)}° / {Math.round(outlook.tMinC)}°</span>
                          <span>{outlook.wetDays.toFixed(1)} wet days</span>
                        </>
                      ) : null}
                    </span>
                    {(serious.length > 0 || alerted || mfa === 'nonEssential' || mfa === 'caution' || mfa === 'unknown') && (
                      <span className="sug-risks">
                        {mfa === 'nonEssential' && <span className="tone-critical">MFA: defer non-essential travel</span>}
                        {(mfa === 'caution' || mfa === 'unknown') && <span className="tone-warning">MFA: {mfa === 'caution' ? 'exercise caution' : 'check advice'}</span>}
                        {alerted && <span className="alert-chip" title="A US embassy alert in the last 14 days names this city. Doesn't affect the rating.">⚠ Recent alert</span>}
                        {serious.slice(0, 2).map((r) => (
                          <span key={r.id} className={r.severity === 'high' ? 'tone-critical' : 'tone-warning'}>{r.title}</span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="sug-rating">
                    {pending ? (
                      <span className="small muted" title={`${pending.years} of ${pending.yearsNeeded} years stored; the rest is downloading in the background (no API calls while you browse).`}>
                        Not stored yet
                      </span>
                    ) : outlook === undefined ? (
                      <span className="small muted">Loading…</span>
                    ) : !suitability || !cls ? (
                      <span className="small muted">No data</span>
                    ) : (
                      <Badge tone={TONE[cls]}>{suitability.rating}</Badge>
                    )}
                  </span>
                </button>
                {selected ? (
                  <div className="sug-actions">
                    <button type="button" className="small primary" onClick={() => onAnalyse(dest)}>
                      Analyse {formatShortDate(start)} – {formatShortDate(end)}
                    </button>
                    {onWhenToGo && <button type="button" className="small" onClick={() => onWhenToGo(dest)}>☀ Sunny windows</button>}
                  </div>
                ) : (
                  <button type="button" className="small sug-analyse" onClick={() => onAnalyse(dest)}>
                    Analyse
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {deferred.length > 0 && (
        <details className="small muted">
          <summary>
            {deferred.length} place{deferred.length === 1 ? '' : 's'} hidden: MFA advises deferring all travel
          </summary>
          <p>{deferred.map((c) => c.dest.name).join(', ')}. Analyse one from the map to see MFA's advice and insurance cover.</p>
        </details>
      )}
      {dests && ranked.length === 0 && (
        <div className="mascot-row">
          <Mascot mood="happy" size={56} />
          <p className="small muted">Nowhere matches these filters. Try a longer travel time, or turn off “Direct, ferry or overland”.</p>
        </div>
      )}
      {ranked.length > STEP && (
        <div className="sug-more">
          {visible < ranked.length && (
            <button type="button" className="small" onClick={() => setVisible((v) => v + STEP)}>
              Show {Math.min(STEP, ranked.length - visible)} more <span className="muted">({ranked.length - visible} left)</span>
            </button>
          )}
          {visible > STEP && (
            <button type="button" className="link-button small" onClick={() => setVisible(STEP)}>
              Show top {STEP}
            </button>
          )}
        </div>
      )}
      <p className="small muted">
        Flight times are estimated from distance; ferry, overland (🚌 coach, bus or train) and onward transfer times (e.g. Hoi An via Da Nang) are typical ranges, and the faster way counts for ranking. Ratings use the same scoring as the full analysis. Direct routes: Wikipedia’s Changi Airport list.
      </p>
    </section>
  );
}
