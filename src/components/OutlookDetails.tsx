import type { ConditionClass } from '../lib/currentConditions';
import { estimateFlightHours, formatHours } from '../lib/outlook';
import type { Suitability } from '../lib/weatherAnalysis';
import type { TripOutlook } from '../services/tripOutlook';
import type { SeasonalRisk } from '../types';
import { Badge, type Tone } from './ui';

export const CLASS_TONE: Record<ConditionClass, Tone> = { good: 'good', average: 'warning', bad: 'critical' };

/** Tooltip / panel body for a point in the travel-dates view. */
export function OutlookDetails({
  title,
  subtitle,
  outlook,
  suitability,
  cls,
  risks,
  lat,
  lon,
  basisLabel,
  compact,
  travel,
  pending,
}: {
  title: string;
  subtitle?: string;
  outlook: TripOutlook | null | undefined;
  suitability: Suitability | null;
  cls: ConditionClass | null;
  risks: SeasonalRisk[];
  lat: number;
  lon: number;
  basisLabel: string;
  compact?: boolean;
  /** Overrides the estimated flight time (e.g. for ferry destinations). */
  travel?: string;
  /** History for this place isn't stored yet (fewer years than needed for a rating). */
  pending?: TripOutlook;
}) {
  const hours = estimateFlightHours(lat, lon);
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="t">{title}</div>
      <div className="secondary small">{subtitle ? `${subtitle}` : ''}{travel ? '' : `${subtitle ? ' · ' : ''}≈ ${formatHours(hours)} direct flight from SIN (estimate)`}</div>
      {pending ? (
        <div className="secondary small">
          Not stored yet: {pending.years} of {pending.yearsNeeded} years saved. The rest is downloading in the background, with no API calls while you browse.
        </div>
      ) : outlook === undefined ? (
        <div className="secondary small">Loading the outlook for your dates…</div>
      ) : !outlook || !suitability || !cls ? (
        <div className="secondary small">No outlook data for this location.</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Badge tone={CLASS_TONE[cls]}>{suitability.rating}</Badge>
            <span className="small muted">{basisLabel}</span>
          </div>
          <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>
            {Math.round(outlook.tMaxC)}° / {Math.round(outlook.tMinC)}°C <span className="small secondary" style={{ fontWeight: 400 }}>avg high / low</span>
          </div>
          <div className="small secondary">
            {outlook.wetDays.toFixed(1)} wet days of {outlook.tripDays} · {Math.round(outlook.totalRainMm)} mm rain
            {outlook.rhPct != null ? ` · humidity ${Math.round(outlook.rhPct)}%` : ''}
          </div>
          <div className="small">{suitability.headline}</div>
        </>
      )}
      {risks.length > 0 && (
        <div className="phenomena">
          <div className="small" style={{ fontWeight: 700 }}>Seasonal context for your dates</div>
          {risks
            .filter((r, i, arr) => arr.findIndex((x) => x.title === r.title) === i)
            .map((r) => (
              <div key={r.id} className="phen">
                <Badge tone={r.severity === 'high' ? 'critical' : r.severity === 'moderate' ? 'warning' : 'info'}>Season</Badge>
                <span className="small">
                  <strong>{r.title}.</strong> {compact ? firstSentence(r.description) : r.description}
                  {!compact && (
                    <>
                      {' '}<a href={r.source.url} target="_blank" rel="noreferrer">{r.source.name}</a>
                    </>
                  )}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function firstSentence(s: string): string {
  const i = s.indexOf('. ');
  return i > 0 ? s.slice(0, i + 1) : s;
}
