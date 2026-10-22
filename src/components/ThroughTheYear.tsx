import { useEffect, useMemo, useState } from 'react';
import { monthlyNormals, type MonthNormal } from '../lib/bestTime';
import { daylightOn, formatHours } from '../lib/comfort';
import { monthName, todayISO } from '../lib/dates';
import { services } from '../services';
import type { DailyWeather } from '../types';

/**
 * Through the year, shared by the trip analysis, Puff's Lookout and Sunny windows: average rain
 * as bars (with the figure on each) above a table on the same grid, so every bar sits over its
 * month. Rows: wet days, high, low, feels-like high, humidity, daylight, sunrise · sunset.
 *
 * Feels-like comes from stored history only (`stored=1` with the extended variables); months
 * still missing it are queued for the background download and show "…" meanwhile. Daylight and
 * sun times are calculated for the 15th of each month, in local time.
 */
export function ThroughTheYear({
  daily,
  lat,
  lon,
  timeZone,
  tripMonths = [],
}: {
  daily: DailyWeather[];
  lat: number;
  lon: number;
  timeZone?: string;
  /** Months (1–12) of the trip, tinted in the bars and the table. */
  tripMonths?: number[];
}) {
  const normals = useMemo(() => monthlyNormals(daily), [daily]);
  const span = daily.length ? { start: daily[0].date, end: daily[daily.length - 1].date } : null;
  const feels = useStoredFeels(lat, lon, span, normals);
  const year = Number(todayISO().slice(0, 4));
  const sun = useMemo(() => Array.from({ length: 12 }, (_, i) => daylightOn(`${year}-${String(i + 1).padStart(2, '0')}-15`, lat, lon, timeZone)), [year, lat, lon, timeZone]);
  const top = Math.max(1, ...normals.map((m) => m.rainMm ?? 0));
  const trip = new Set(tripMonths);
  const cls = (m: number) => (trip.has(m) ? ' in-trip' : '');
  const f0 = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${Math.round(v)}${unit}`);
  const missingFeels = feels.some((v) => v === undefined);

  return (
    <div className="tty" aria-label="Through the year">
      <h3>Through the year</h3>
      <p className="small muted">
        Average month by month from the same history{trip.size ? '; your trip’s months are tinted' : ''}. Bars show average rain (mm).
      </p>
      <div className="tty-scroll">
        <div className="tty-grid tty-bars" aria-hidden>
          <div className="tty-label tty-label-muted">Rain (mm)</div>
          {normals.map((m) => (
            <div key={m.month} className={`tty-bar${cls(m.month)}`} title={`${monthName(m.month)}: ${f0(m.rainMm, ' mm')} average rain`}>
              <b>{f0(m.rainMm)}</b>
              <i style={{ height: `${m.rainMm == null ? 0 : Math.max(2, (m.rainMm / top) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="tty-grid tty-table" role="table" aria-label="Monthly averages">
          <div role="row" className="tty-row tty-head">
            <div role="columnheader" className="tty-label" />
            {normals.map((m) => (
              <div key={m.month} role="columnheader" className={`tty-cell${cls(m.month)}`}>{monthName(m.month)}</div>
            ))}
          </div>
          <Row label="Wet days" normals={normals} cls={cls} v={(m) => f0(m.wetDays)} />
          <Row label="High °C" normals={normals} cls={cls} v={(m) => f0(m.tMax)} />
          <Row label="Low °C" normals={normals} cls={cls} v={(m) => f0(m.tMin)} />
          <Row label="Feels-like high °C" normals={normals} cls={cls} v={(m) => (feels[m.month - 1] === undefined ? '…' : f0(feels[m.month - 1]))} />
          <Row label="Humidity %" normals={normals} cls={cls} v={(m) => f0(m.rh)} />
          <Row label="Daylight" normals={normals} cls={cls} v={(m) => formatHours(sun[m.month - 1].hours)} />
          <Row
            label="Sunrise · sunset"
            normals={normals}
            cls={cls}
            v={(m) => {
              const d = sun[m.month - 1];
              return d.sunrise && d.sunset ? (
                <>
                  {d.sunrise}
                  <br />
                  {d.sunset}
                </>
              ) : (
                '—'
              );
            }}
          />
        </div>
      </div>
      <p className="small muted">
        Daylight, sunrise and sunset are calculated for the 15th of each month{timeZone ? ', in local time' : ''}.
        {missingFeels ? ' Feels-like highs for some months are still downloading in the background; they appear once stored.' : ''}
      </p>
    </div>
  );
}

function Row({ label, normals, cls, v }: { label: string; normals: MonthNormal[]; cls: (m: number) => string; v: (m: MonthNormal) => React.ReactNode }) {
  return (
    <div role="row" className="tty-row">
      <div role="rowheader" className="tty-label">{label}</div>
      {normals.map((m) => (
        <div key={m.month} role="cell" className={`tty-cell${cls(m.month)}`}>{v(m)}</div>
      ))}
    </div>
  );
}

/**
 * Feels-like highs per month from stored history (no API call while you wait). Months without
 * enough stored days come back undefined; the server queues them for the background download.
 */
function useStoredFeels(lat: number, lon: number, span: { start: string; end: string } | null, normals: MonthNormal[]): (number | null | undefined)[] {
  const [feels, setFeels] = useState<(number | null | undefined)[]>(() => normals.map((m) => m.feelsMax ?? undefined));
  const key = span ? `${lat},${lon},${span.start},${span.end}` : '';
  useEffect(() => {
    if (!span) return;
    // History that already carries feels-like (the trip analysis's extended fetch) needs no call.
    if (normals.every((m) => m.feelsMax !== null)) {
      setFeels(normals.map((m) => m.feelsMax));
      return;
    }
    const ctrl = new AbortController();
    services.weather
      .getDaily(lat, lon, span.start, span.end, ctrl.signal, { storedOnly: true, extended: true })
      .then((h) => setFeels(monthlyNormals(h.daily).map((m) => m.feelsMax ?? undefined)))
      .catch(() => undefined);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return feels;
}
