import { useEffect, useState } from 'react';
import { Badge } from './ui';
import { addDays, daysBetween, formatShortDate, todayISO } from '../lib/dates';
import { RECENT_RAIN_LABEL, timesNormal, type RecentRain } from '../lib/recentRain';
import { getRecentRain } from '../services/recentRain';

/** The card shows from this many days before the trip until it ends. */
export const RAIN_LATELY_DAYS = 30;

export const rainLatelyDue = (start: string, end: string, today = todayISO()) => end >= today && daysBetween(today, start) <= RAIN_LATELY_DAYS;

export interface RainLatelyPlace {
  key: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * Rain lately: the last 7 and 30 days at each place compared with the same days in past years,
 * for trips starting within 30 days. Places with too little stored data are left out.
 * `embedded` drops the card frame so it sits as the last section of The weather story.
 */
export function RainLately({ places, embedded = false }: { places: RainLatelyPlace[]; embedded?: boolean }) {
  const [data, setData] = useState<Record<string, RecentRain | null>>({});
  const [active, setActive] = useState(0);
  const placeKey = places.map((p) => `${p.key}:${p.lat}:${p.lon}`).join('|');
  useEffect(() => {
    const ctrl = new AbortController();
    for (const p of places) {
      getRecentRain(p.lat, p.lon, ctrl.signal).then(
        (r) => setData((d) => ({ ...d, [p.key]: r })),
        () => !ctrl.signal.aborted && setData((d) => ({ ...d, [p.key]: null })),
      );
    }
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);

  const shown = places.filter((p) => data[p.key]);
  if (!shown.length) return null;
  const p = shown[Math.min(active, shown.length - 1)];
  const r = data[p.key]!;
  const x30 = timesNormal(r.mm30, r.normal30);
  const x7 = timesNormal(r.mm7, r.normal7);
  const weeks = r.weeks ?? [];
  const top = Math.max(1, ...weeks.map((w) => Math.max(w.mm ?? 0, w.normalMm)));

  const Wrap = embedded ? 'div' : 'section';
  const Title = embedded ? 'h3' : 'h2';
  return (
    <Wrap className={embedded ? 'rain-lately-embedded' : 'card'} aria-labelledby="rain-lately-h">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <Title id="rain-lately-h">Rain lately{shown.length === 1 && places.length > 1 ? ` in ${p.name}` : ''}</Title>
          <p className="small muted">The last 7 and 30 days, to {formatShortDate(r.end)}, compared with the same days in the past {r.years} years.</p>
        </div>
        <Badge tone={r.level === 'usual' ? 'neutral' : 'info'}>{RECENT_RAIN_LABEL[r.level]}</Badge>
      </div>
      {shown.length > 1 && (
        <div className="tabs stop-tabs" role="tablist" aria-label="Rain lately in">
          {shown.map((s, i) => (
            <button key={s.key} type="button" role="tab" aria-selected={s === p} onClick={() => setActive(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="tiles">
        <div className="tile">
          <span className="k">Last 7 days</span>
          <span className="v">{x7 ?? `${Math.round(r.mm7)} mm`}</span>
          <span className="s">{Math.round(r.mm7)} mm · usual {Math.round(r.normal7)}</span>
        </div>
        <div className="tile">
          <span className="k">Last 30 days</span>
          <span className="v">{x30 ?? `${Math.round(r.mm30)} mm`}</span>
          <span className="s">{Math.round(r.mm30)} mm · usual {Math.round(r.normal30)}</span>
        </div>
        <div className="tile">
          <span className="k">Wet days</span>
          <span className="v">{r.wetDays30}/30</span>
          <span className="s">usual {Math.round(r.usualWetDays30)}</span>
        </div>
      </div>
      {weeks.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <div className="rain-weeks" role="img" aria-label={`Weekly rain for the last ${weeks.length} weeks compared with normal`}>
            {weeks.map((w) => (
              <div key={w.start} className="rain-week" title={`${formatShortDate(w.start)} – ${formatShortDate(addDays(w.start, 6))}: ${w.mm === null ? 'not stored' : `${Math.round(w.mm)} mm`}, usual ${Math.round(w.normalMm)} mm`}>
                {w.mm !== null && <span className={`bar${w.mm > w.normalMm ? ' above' : ''}`} style={{ height: `${(w.mm / top) * 100}%` }} />}
                <span className="normal" style={{ bottom: `${(w.normalMm / top) * 100}%` }} />
              </div>
            ))}
          </div>
          <p className="small muted">Weekly rain, last {weeks.length} weeks. Darker bars are above normal; the line marks normal.</p>
        </div>
      )}
      <p className="small secondary">
        {r.level === 'usual'
          ? 'Nothing unusually wet lately.'
          : 'Ground and rivers may still be high after this much rain. Check local flood news before you go.'}
      </p>
    </Wrap>
  );
}
