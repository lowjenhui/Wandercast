import { RISK_REFERENCE_NOTE } from '../data/seasonalRisks';
import { COLD_NIGHT_C, COOL_NIGHT_C, FROST_C, SNOW_DAY_CM, formatHours, type TripComfort } from '../lib/comfort';
import { formatDate } from '../lib/dates';
import { HEAVY_RAIN_MM, HOT_DAY_C, WET_DAY_MM, type SuitabilityRating } from '../lib/weatherAnalysis';
import type { EnsoOutlook } from '../lib/enso';
import type { TripOdds } from '../lib/tripOdds';
import type { Async, WeatherResult } from '../useTripEvaluation';
import { Mascot, type MascotMood } from './Brand';
import { DailyWetChanceChart, RainChart, RainContextChart, TemperatureChart, WetDaysChart } from './charts';
import { ThroughTheYear } from './ThroughTheYear';
import type { ReactNode } from 'react';
import { Badge, ConfidenceBadge, Notice, SkeletonCard, type Tone } from './ui';

export const ratingTone: Record<SuitabilityRating, Tone> = {
  Pleasant: 'good',
  'Generally pleasant': 'good',
  Mixed: 'warning',
  Challenging: 'critical',
};

/** Puff's mood on the loaded weather story follows the verdict. */
const ratingMood: Record<SuitabilityRating, MascotMood> = {
  Pleasant: 'happy',
  'Generally pleasant': 'happy',
  Mixed: 'searching',
  Challenging: 'sleepy',
};

const f1 = (n: number | null | undefined, unit = '') => (n === null || n === undefined ? '—' : `${n.toFixed(1)}${unit}`);
const f0 = (n: number | null | undefined, unit = '') => (n === null || n === undefined ? '—' : `${Math.round(n)}${unit}`);

/**
 * `mascot: false` leaves Puff out, for pages that already show Puff (Puff's Lookout).
 * `rainLately` is shown as the card's last section (the Rain lately block, when it's due).
 */
export function WeatherSection({ result, mascot = true, rainLately }: { result: Async<WeatherResult>; mascot?: boolean; rainLately?: ReactNode }) {
  if (result.state === 'idle') return null;
  if (result.state === 'loading') return <SkeletonCard title="The weather story" note="Reading up to 25 years of daily weather history…" mascot={mascot} />;
  if (result.state === 'error') {
    return (
      <section className="card" aria-labelledby="wx-h">
        <div className="mascot-row">
          {mascot && <Mascot mood="sleepy" size={64} float={false} />}
          <h2 id="wx-h">The weather story</h2>
        </div>
        <Notice kind="err" title="Historical weather could not be retrieved">
          <p>{result.message}</p>
          {!/daily/i.test(result.message) && (
            <p className="small muted">The weather provider (Open-Meteo) may be temporarily unavailable or rate-limited. Try again in a minute.</p>
          )}
        </Notice>
      </section>
    );
  }

  const { analysis: a, history: h, risks, rainContext: rc, enso, ensoSource, extraNotes, comfort, comfortMissing } = result.value;
  const s = a.suitability;
  const n = a.years.length;

  if (!n || !s) {
    return (
      <section className="card" aria-labelledby="wx-h">
        <h2 id="wx-h">The weather story</h2>
        <Notice kind="warn" title="Not enough historical data">
          <p>The provider returned too few complete days for these dates to produce a reliable summary.</p>
        </Notice>
      </section>
    );
  }

  const oldest = a.years[n - 1].year;
  const newest = a.years[0].year;

  return (
    <section className="card" aria-labelledby="wx-h">
      <div className="card-head">
        <div className="mascot-row">
          {/* Same size as the loading card so nothing jumps; still once loaded (bobbing means "working on it"). */}
          {mascot && <Mascot mood={ratingMood[s.rating]} size={64} float={false} />}
          <div>
            <h2 id="wx-h">The weather story</h2>
            <p className="small muted">
              {a.odds
                ? `Odds from ${a.odds.years} years of history (${a.odds.firstYear}–${a.odds.lastYear}); charts show your exact dates in the last ${n} years. This is not a forecast.`
                : `Historical record for the same calendar dates, ${oldest}–${newest} (${n} years). This is not a forecast.`}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone={ratingTone[s.rating]}>{s.rating}</Badge>
          <ConfidenceBadge level={a.confidence} />
        </div>
      </div>

      <p>{s.headline}</p>

      {a.odds && <OddsBlock odds={a.odds} enso={enso} ensoSource={ensoSource} extraNotes={extraNotes} />}

      <div className="tiles">
        <Tile k="Wet days per trip" v={f1(a.wetDays.mean)} s={`median ${f1(a.wetDays.median)} · range ${f0(a.wetDays.min)}–${f0(a.wetDays.max)} of ${a.tripDays}`} />
        <Tile k="Total rainfall" v={f0(a.totalRain.median, ' mm')} s={`typical (median) · middle half ${f0(a.totalRain.p25)}–${f0(a.totalRain.p75)} mm`} />
        <Tile k="Avg daily max" v={f1(a.tMax.mean, ' °C')} s={`yearly range ${f1(a.tMax.min)}–${f1(a.tMax.max)} °C`} />
        <Tile k="Avg daily min" v={f1(a.tMin.mean, ' °C')} s={`yearly range ${f1(a.tMin.min)}–${f1(a.tMin.max)} °C`} />
        <Tile k="Relative humidity" v={a.rh ? f0(a.rh.mean, '%') : 'n/a'} s={a.rh ? `daily mean · range ${f0(a.rh.min)}–${f0(a.rh.max)}%` : 'not available for this location'} />
        <Tile k="Heavy-rain days" v={f1(a.heavyRainDaysMean)} s={`≥${HEAVY_RAIN_MM} mm per trip, on average`} />
      </div>

      <div className="components" aria-label="Suitability breakdown">
        {s.components.map((c) =>
          c.key === 'risk' ? (
            <div key={c.key} className="component-row">
              <span className="secondary">{c.label}</span>
              <span className="small">{c.note}</span>
              <span className="small tone-serious" style={{ textAlign: 'right' }}>{c.score}</span>
            </div>
          ) : (
            <div key={c.key} className="component-row">
              <span className="secondary">{c.label}</span>
              <div title={c.note}>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${c.score}%` }} /></div>
                <span className="small muted">{c.note}</span>
              </div>
              <span className="small" style={{ textAlign: 'right' }}>{c.score}</span>
            </div>
          ),
        )}
        <p className="small muted">Overall score {s.score}/100 (rain 45%, temperature 35%, humidity 20%, minus seasonal-risk penalties).</p>
      </div>

      {comfort && <ComfortBlock c={comfort} tMaxMean={a.tMax.mean} missing={comfortMissing} />}

      {a.lastYear && (
        <div className="notice" aria-label="Last year comparison">
          <h3>Last year: {formatDate(a.lastYear.start)} – {formatDate(a.lastYear.end)}</h3>
          <ul className="plain">
            {a.lastYearNotes.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      )}

      <div className="two-col">
        <ChartBox title="Wet days per year" caption={`Days with ≥${WET_DAY_MM} mm of precipitation during your dates. The darker bar is last year; the dashed line is the average (${f1(a.wetDays.mean)}).`}>
          <WetDaysChart years={a.years} mean={a.wetDays.mean} />
        </ChartBox>
        <ChartBox title="Total rainfall per year" caption={`Total precipitation over your dates. The darker bar is last year; the dashed line is the median (${f0(a.totalRain.median, ' mm')}).`}>
          <RainChart years={a.years} median={a.totalRain.median} />
        </ChartBox>
        <ChartBox title="Temperature per year" caption="Average daily maximum and minimum over your dates.">
          <TemperatureChart years={a.years} />
        </ChartBox>
        <ChartBox title="Chance of a wet day, by date" caption={`Share of the ${n} past years in which each date had ≥${WET_DAY_MM} mm.`}>
          <DailyWetChanceChart data={a.dailyWetChance} />
        </ChartBox>
      </div>

      <div style={{ display: 'grid', gap: 10 }} aria-label="Rainfall before, during and after your trip">
        <div className="card-head">
          <h3>Rainfall before, during and after your trip</h3>
          <div className="legend" aria-hidden>
            <span><i className="swatch block" style={{ background: 'var(--series-1)' }} /> Your dates</span>
            <span><i className="swatch block" style={{ background: 'var(--series-1-soft)' }} /> {rc.window.before} days before / {rc.window.after} days after</span>
            {rc.drierAlternative && <span><i className="swatch block" style={{ background: 'var(--good)', opacity: 0.35 }} /> Drier stretch</span>}
          </div>
        </div>
        <div className="tiles">
          <Tile k={`Before (${rc.window.before} days)`} v={rc.before.wetShare === null ? '—' : `${Math.round(rc.before.wetShare * 100)}%`} s={`wet days · avg ${f1(rc.before.meanMm, ' mm/day')}`} />
          <Tile k={`Your dates (${rc.window.tripDays} days)`} v={rc.trip.wetShare === null ? '—' : `${Math.round(rc.trip.wetShare * 100)}%`} s={`wet days · avg ${f1(rc.trip.meanMm, ' mm/day')}`} />
          <Tile k={`After (${rc.window.after} days)`} v={rc.after.wetShare === null ? '—' : `${Math.round(rc.after.wetShare * 100)}%`} s={`wet days · avg ${f1(rc.after.meanMm, ' mm/day')}`} />
        </div>
        <ul className="plain small">
          {rc.summary.map((t) => <li key={t} className={t.startsWith('A drier') ? 'tone-good' : undefined}>{t}</li>)}
        </ul>
        <div className="two-col">
          <ChartBox title="Chance of a wet day" caption={`Share of past years (up to ${rc.years}) with ≥${WET_DAY_MM} mm on each date, ${formatDate(rc.window.start)} – ${formatDate(rc.window.end)}.`}>
            <RainContextChart ctx={rc} metric="wet" />
          </ChartBox>
          <ChartBox title="Average daily rainfall" caption="Mean precipitation on each date across the same years.">
            <RainContextChart ctx={rc} metric="mm" />
          </ChartBox>
        </div>
      </div>

      <ThroughTheYear daily={h.daily} lat={h.gridLatitude} lon={h.gridLongitude} timeZone={h.timezone} tripMonths={a.monthly.filter((m) => m.inTrip).map((m) => m.month)} />

      <div style={{ display: 'grid', gap: 10 }}>
        <h3>Seasonal weather risks</h3>
        {risks.length === 0 ? (
          <p className="secondary small">No major seasonal hazards (monsoon, cyclone, extreme heat) are listed for this destination and month in our reference set. Always check local forecasts and warnings before travelling.</p>
        ) : (
          risks.map((r) => (
            <div key={r.id} className="risk">
              <div className="risk-head">
                <strong>{r.title}</strong>
                <Badge tone={r.severity === 'high' ? 'critical' : r.severity === 'moderate' ? 'warning' : 'info'}>
                  {r.severity === 'high' ? (r.inPeak ? 'High risk · peak season' : 'High risk') : r.severity === 'moderate' ? 'Moderate' : 'Note'}
                </Badge>
                {r.basis === 'data' && <Badge tone="neutral">From this location's data</Badge>}
              </div>
              <p className="small secondary">{r.description}</p>
              <p className="small">Source: <a href={r.source.url} target="_blank" rel="noreferrer">{r.source.name}</a></p>
            </div>
          ))
        )}
        <p className="small muted">{RISK_REFERENCE_NOTE}</p>
      </div>

      {rainLately}

      <details>
        <summary>Year-by-year data</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Year</th><th>Wet days</th><th>Rain (mm)</th><th>Wettest day (mm)</th><th>Avg max (°C)</th><th>Avg min (°C)</th><th>RH (%)</th><th>Days ≥{HOT_DAY_C} °C</th></tr>
            </thead>
            <tbody>
              {a.years.map((y, i) => (
                <tr key={y.year} className={i === 0 ? 'highlight' : undefined}>
                  <td>{y.year}{i === 0 ? ' (last year)' : ''}</td>
                  <td>{y.wetDays}</td>
                  <td>{y.totalRainMm.toFixed(0)}</td>
                  <td>{y.wettestDayMm.toFixed(0)}</td>
                  <td>{f1(y.meanTMaxC)}</td>
                  <td>{f1(y.meanTMinC)}</td>
                  <td>{f0(y.meanRhPct)}</td>
                  <td>{y.hotDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details>
        <summary>Data source & confidence</summary>
        <div style={{ display: 'grid', gap: 8 }}>
          <p className="small"><Badge tone="info">Model reanalysis, not station observations</Badge></p>
          <p className="small secondary">{h.datasetNote}</p>
          <p className="small secondary">
            Grid cell used: {h.gridLatitude.toFixed(2)}°, {h.gridLongitude.toFixed(2)}°{h.gridElevationM !== undefined ? ` (elevation ${Math.round(h.gridElevationM)} m)` : ''}.
            A wet day is any day with ≥{WET_DAY_MM} mm of precipitation.
          </p>
          <ul className="plain small secondary">
            {a.confidenceNotes.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <p className="small">
            Sources:{' '}
            {h.sources.map((src, i) => (
              <span key={src.url}>{i > 0 && ' · '}<a href={src.url} target="_blank" rel="noreferrer">{src.name}</a></span>
            ))}
          </p>
        </div>
      </details>
    </section>
  );
}

const pct = (p: number) => (p > 0 && p < 0.01 ? '<1%' : p > 0.99 && p < 1 ? '>99%' : `${Math.round(p * 100)}%`);
const oddsTone = (p: number, goodHigh: boolean) => {
  const g = goodHigh ? p : 1 - p;
  return g >= 0.66 ? 'tone-good' : g >= 0.4 ? undefined : 'tone-serious';
};
/** One-word reading of a probability, so a low number isn't mistaken for a description of the trip. */
const oddsVerdict = (p: number) => (p < 0.05 ? 'rare' : p < 0.35 ? 'unlikely' : p < 0.65 ? 'possible' : p < 0.95 ? 'likely' : 'near-certain');

function OddsBlock({ odds: o, enso, ensoSource, extraNotes }: { odds: TripOdds; enso: EnsoOutlook | null; ensoSource: { name: string; url: string } | null; extraNotes: string[] }) {
  const sig = o.ensoSignal;
  return (
    <div style={{ display: 'grid', gap: 10 }} aria-label="Odds for your trip">
      <div className="card-head">
        <h3>What are the odds?</h3>
        <span className="small muted">
          {o.samples} sample trips · {o.years} years · ±{o.pad} days{o.ensoApplied ? ' · ENSO-weighted' : ''}
        </span>
      </div>
      <div className="tiles">
        <OddsTile k="Chance of a dry trip" p={o.pMostlyDry} goodHigh s={`at least ${o.tripDays - o.dryMaxWetDays} of ${o.tripDays} days dry`} />
        <OddsTile k="Chance of rain most days" p={o.pRainMostDays} goodHigh={false} s={`more than half the days with ≥${WET_DAY_MM} mm`} />
        <OddsTile k="Chance of a downpour" p={o.pWashout} goodHigh={false} s={`a day with ≥${HEAVY_RAIN_MM} mm`} />
        <OddsTile k="Chance of a hot day" p={o.pHotDay} goodHigh={false} s={`a day reaching ≥${HOT_DAY_C} °C`} />
        <Tile k="Likely wet days" v={`${f0(o.wetDays.p25)}–${f0(o.wetDays.p75)}`} s={`middle half of trips · median ${f0(o.wetDays.p50)} of ${o.tripDays}`} />
        <Tile k="Likely rainfall" v={`${f0(o.rainMm.p25)}–${f0(o.rainMm.p75)} mm`} s={`middle half of trips · median ${f0(o.rainMm.p50, ' mm')}`} />
      </div>
      <p className="small muted">
        Each past year's trip is slid up to {o.pad} days either side of your dates. Recent years count more (weight halves every {o.halfLifeYears} years), as do dates closer to yours
        {o.ensoApplied ? ', and years in the same ENSO phase as expected for your trip' : ''}.
      </p>
      {enso && (
        <div className="notice" aria-label="El Niño and La Niña">
          <div className="risk-head">
            <strong>El Niño / La Niña</strong>
            <Badge tone={enso.latest.phase === 'Neutral' ? 'neutral' : 'info'}>
              Now: {enso.latest.strength ? `${enso.latest.strength} ` : ''}{enso.latest.phase}
            </Badge>
          </div>
          <p className="small secondary">{enso.note}</p>
          {sig ? (
            <p className="small">
              {sig.verdict === 'little difference'
                ? `Here, past ${sig.phase} years (${sig.years}) looked much like other years at these dates`
                : `Here, past ${sig.phase} years (${sig.years}) were ${sig.verdict} at these dates`}
              : {Math.round(sig.wetShareSame * 100)}% of days wet vs {Math.round(sig.wetShareAll * 100)}% overall, about {f0(sig.rainSame, ' mm')} vs {f0(sig.rainAll, ' mm')} per trip.
            </p>
          ) : enso.tripPhase !== 'Neutral' && enso.influence > 0 ? (
            <p className="small muted">Too few past {enso.tripPhase} years in this record to tell how it affects this place.</p>
          ) : null}
          {ensoSource && (
            <p className="small">Source: <a href={ensoSource.url} target="_blank" rel="noreferrer">{ensoSource.name}</a></p>
          )}
        </div>
      )}
      {!enso && <p className="small muted">The El Niño / La Niña index was unavailable, so all years count by recency only.</p>}
      {extraNotes.length > 0 && (
        <p className="small muted" title={extraNotes.join('\n')}>
          {extraNotes.length} older year{extraNotes.length === 1 ? ' was' : 's were'} left out because the weather API budget is busy right now. Search again later to include {extraNotes.length === 1 ? 'it' : 'them'}; once fetched, they're stored and cost nothing next time.
        </p>
      )}
    </div>
  );
}

function ComfortBlock({ c, tMaxMean, missing }: { c: TripComfort; tMaxMean: number | null; missing: number }) {
  const { feelsLike: fl, nights: nt, daylight: dl } = c;
  const nightCount =
    !nt ? null
    : nt.frostNightsMean >= 0.05 ? { k: 'Frost nights', v: nt.frostNightsMean, s: `below ${FROST_C} °C, per trip` }
    : nt.coldNightsMean >= 0.05 ? { k: 'Cold nights', v: nt.coldNightsMean, s: `below ${COLD_NIGHT_C} °C, per trip` }
    : nt.coolNightsMean >= 0.05 ? { k: 'Cool nights', v: nt.coolNightsMean, s: `below ${COOL_NIGHT_C} °C, per trip` }
    : null;
  // Night feels-like only when wind makes it colder; in the tropics humidity pushes it above the low.
  const nightFeels = fl?.lowMean != null && nt && fl.lowMean <= nt.lowMean - 2 ? `feels like ${f0(fl.lowMean, ' °C')} · ` : '';
  const sun = (d: TripComfort['daylight']['first']) =>
    d.polar === 'night' ? 'polar night' : d.polar === 'day' ? 'midnight sun' : d.sunrise && d.sunset ? `${d.sunrise}–${d.sunset}` : null;
  const firstSun = sun(dl.first);
  const lastSun = sun(dl.last);
  const vsHome = Math.abs(dl.vsHomeHours) < 1 / 60 ? `same as ${dl.homeName}` : `${formatHours(dl.vsHomeHours)} ${dl.vsHomeHours < 0 ? 'less' : 'more'} than ${dl.homeName}`;
  return (
    <div style={{ display: 'grid', gap: 10 }} aria-label="Feels like, nights and daylight">
      <div className="card-head">
        <h3>How it feels: heat, nights and daylight</h3>
        {fl && <span className="small muted">feels-like from the last {fl.years} years</span>}
      </div>
      {c.notes.length > 0 && (
        <ul className="plain small">
          {c.notes.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}
      <div className="tiles">
        {fl && (
          <Tile
            k="Feels-like high"
            v={f0(fl.highMean, ' °C')}
            s={`actual high ${f0(tMaxMean, ' °C')} · hottest felt ${f0(fl.hottest, ' °C')}`}
          />
        )}
        {nt && <Tile k="Night low" v={f0(nt.lowMean, ' °C')} s={`${nightFeels}coldest ${f0(nt.coldest.c, ' °C')} (${nt.coldest.year})`} />}
        {nightCount && <Tile k={nightCount.k} v={f1(nightCount.v)} s={nightCount.s} />}
        {nt?.snow && nt.snow.yearsWithSnow > 0 && (
          <Tile k="Snow days" v={f1(nt.snow.daysMean)} s={`≥${SNOW_DAY_CM} cm, per trip · snow in ${nt.snow.yearsWithSnow} of ${nt.snow.years} years`} />
        )}
        <Tile
          k="Daylight"
          v={formatHours(dl.meanHours)}
          s={[firstSun && (lastSun && lastSun !== firstSun ? `${firstSun} → ${lastSun}` : firstSun), vsHome].filter(Boolean).join(' · ')}
        />
      </div>
      <p className="small muted">
        Feels-like (apparent) temperature combines air temperature with humidity, wind and sun. Daylight is sunrise to sunset, calculated for these dates
        {dl.first.sunrise ? ', in local time' : ''}.
      </p>
      {!fl && missing > 0 && (
        <p className="small muted">Feels-like temperatures and snowfall couldn't be loaded because the weather API budget is busy. Search again later; once fetched, they're stored.</p>
      )}
    </div>
  );
}

function OddsTile({ k, p, s, goodHigh }: { k: string; p: number; s: string; goodHigh: boolean }) {
  return (
    <div className="tile">
      <span className="k">{k}</span>
      <span className={`v ${oddsTone(p, goodHigh) ?? ''}`}>
        {pct(p)} <span className="verdict">{oddsVerdict(p)}</span>
      </span>
      <span className="s">{s}</span>
    </div>
  );
}

function Tile({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="tile">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {s && <span className="s">{s}</span>}
    </div>
  );
}

function ChartBox({ title, caption, children }: { title: string; caption: string; children: React.ReactNode }) {
  return (
    <figure className="chart-box" style={{ margin: 0 }}>
      <h4>{title}</h4>
      {children}
      <figcaption className="caption">{caption}</figcaption>
    </figure>
  );
}

export { Tile, ChartBox };
