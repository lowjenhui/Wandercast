// Rainfall heat map pieces for the world map: the raster layer, month controls, legend,
// hover chart, monsoon labels and footprints, and the zone-by-zone strips. Data: bundled
// 1991–2020 monthly normals (GPCP worldwide, ERA5 for Asia and Australia when zoomed in; no API calls).

import type { GeoProjection } from 'd3-geo';
import { useEffect, useMemo, useState } from 'react';
import { MONSOONS, type MonsoonRegime } from '../data/monsoons';
import { sidesVerdict, type ClimateZone } from '../lib/climateZones';
import { monthName } from '../lib/dates';
import { driestNearby, monthsMean, type NearbyPlace } from '../lib/nearbyRain';
import { RAIN_STOPS, rainBand, rainColor, rainCss, rainSourceLabel, type RainField } from '../lib/rainfall';

/** The part of the map a raster covers, in map (untransformed) units. */
export interface RasterView {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Lon/lat for every raster pixel; computed once per projection and view. */
function useInverseGrid(projection: GeoProjection, view: RasterView, rw: number, rh: number) {
  return useMemo(() => {
    const lat = new Float32Array(rw * rh);
    const lon = new Float32Array(rw * rh);
    const ok = new Uint8Array(rw * rh);
    const vw = view.x1 - view.x0;
    const vh = view.y1 - view.y0;
    for (let py = 0; py < rh; py++) {
      for (let px = 0; px < rw; px++) {
        const x = view.x0 + ((px + 0.5) * vw) / rw;
        const y = view.y0 + ((py + 0.5) * vh) / rh;
        const p = projection.invert?.([x, y]);
        if (!p) continue;
        const back = projection(p);
        if (!back || Math.abs(back[0] - x) > 0.5 || Math.abs(back[1] - y) > 0.5) continue; // outside the globe
        const k = py * rw + px;
        lon[k] = p[0];
        lat[k] = p[1];
        ok[k] = 1;
      }
    }
    return { lat, lon, ok };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection, view.x0, view.y0, view.x1, view.y1, rw, rh]);
}

/**
 * A data URL for the rainfall field under `weights` (month → weight) over `view` (map units),
 * at rw × rh pixels. Zoomed in, only the view is drawn, so finer grids show their detail.
 */
export function useRainRaster(grid: RainField | null, weights: Map<number, number> | null, projection: GeoProjection, view: RasterView, rw: number, rh: number) {
  const inv = useInverseGrid(projection, view, rw, rh);
  const key = weights ? `${[...weights].map(([m, v]) => `${m}:${v}`).join(',')}|${view.x0},${view.y0},${view.x1},${view.y1}` : '';
  // Recent rasters per grid, so stepping through months or panning back is instant.
  const [caches] = useState(() => new WeakMap<RainField, Map<string, string>>());
  return useMemo(() => {
    if (!grid || !weights) return null;
    let cache = caches.get(grid);
    if (!cache) caches.set(grid, (cache = new Map()));
    const hit = cache.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(rw, rh);
    for (let k = 0; k < rw * rh; k++) {
      if (!inv.ok[k]) continue;
      const [r, g, b] = rainColor(grid.blend(weights, inv.lat[k], inv.lon[k]));
      img.data[k * 4] = r;
      img.data[k * 4 + 1] = g;
      img.data[k * 4 + 2] = b;
      img.data[k * 4 + 3] = 235;
    }
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    cache.set(key, url);
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
    return url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, key, inv]);
}

export function RainLegend({ grid, caption }: { grid: RainField | null; caption: string }) {
  const stops = RAIN_STOPS.map(([v]) => v);
  const top = stops[stops.length - 1];
  const gradient = `linear-gradient(to right, ${stops.map((v, i) => `${rainCss(v)} ${(i / (stops.length - 1)) * 100}%`).join(', ')})`;
  return (
    <div className="rain-legend" aria-label="Rainfall colour scale">
      <span className="small secondary">{caption}</span>
      <div className="rain-scale">
        <div className="rain-bar" style={{ background: gradient }} />
        <div className="rain-ticks small muted">
          {stops.map((v) => (
            <span key={v}>{v === top ? `${v}+` : v}</span>
          ))}
        </div>
      </div>
      <span className="small muted">mm / month{grid ? '' : ' · loading…'}</span>
    </div>
  );
}

/**
 * Month slider with play/pause. `months` limits the choices (e.g. only the trip's months);
 * play steps through them on a loop.
 */
export function MonthControls({
  month,
  months,
  onMonth,
  travelMonths,
}: {
  month: number;
  months: number[];
  onMonth: (m: number) => void;
  /** Highlighted on the slider. */
  travelMonths: number[];
}) {
  const [playing, setPlaying] = useState(false);
  const idx = Math.max(0, months.indexOf(month));
  useEffect(() => {
    if (!playing || months.length < 2) return;
    const id = window.setInterval(() => onMonth(months[(months.indexOf(month) + 1) % months.length]), 1100);
    return () => window.clearInterval(id);
  }, [playing, month, months, onMonth]);
  useEffect(() => setPlaying(false), [months.length]);

  return (
    <div className="month-controls" role="group" aria-label="Month">
      <button
        type="button"
        className="small"
        onClick={() => setPlaying((p) => !p)}
        disabled={months.length < 2}
        aria-label={playing ? 'Pause' : 'Play through the months'}
        title={playing ? 'Pause' : 'Play through the months'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="month-slider">
        <input
          type="range"
          min={0}
          max={months.length - 1}
          step={1}
          value={idx}
          onChange={(e) => (setPlaying(false), onMonth(months[Number(e.target.value)]))}
          aria-label="Month"
          aria-valuetext={monthName(month)}
          disabled={months.length < 2}
        />
        <div className="month-ticks" aria-hidden>
          {months.map((m) => (
            <button
              key={m}
              type="button"
              tabIndex={-1}
              className={`month-tick${m === month ? ' current' : ''}${travelMonths.includes(m) ? ' trip' : ''}`}
              onClick={() => (setPlaying(false), onMonth(m))}
            >
              {monthName(m)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Twelve monthly bars for one place, with the selected months highlighted. */
export function RainBars({ values, selected, height = 46 }: { values: number[]; selected: number[]; height?: number }) {
  const max = Math.max(150, ...values);
  const bw = 14;
  return (
    <svg width={bw * 12} height={height + 12} role="img" aria-label="Average monthly rainfall, January to December">
      {values.map((v, i) => {
        const bh = Math.max(1, (v / max) * height);
        return (
          <g key={i}>
            <rect x={i * bw + 1.5} y={height - bh} width={bw - 3} height={bh} rx={2} fill={rainCss(v)} stroke={selected.includes(i + 1) ? 'var(--text-primary)' : 'none'} strokeWidth={1.5} />
            <text x={i * bw + bw / 2} y={height + 10} textAnchor="middle" className="rain-bar-label">{monthName(i + 1)[0]}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function RainDetails({
  grid,
  lat,
  lon,
  name,
  months,
  label,
  regime,
  hideName,
}: {
  grid: RainField;
  lat: number;
  lon: number;
  name?: string;
  months: number[];
  label: string;
  regime?: MonsoonRegime | null;
  /** The name is shown elsewhere (e.g. a popover heading): show only the coordinates. */
  hideName?: boolean;
}) {
  const year = grid.year(lat, lon);
  const sel = months.reduce((a, m) => a + year[m - 1], 0) / Math.max(1, months.length);
  const total = year.reduce((a, b) => a + b, 0);
  const wettest = year.indexOf(Math.max(...year)) + 1;
  const driest = year.indexOf(Math.min(...year)) + 1;
  const src = rainSourceLabel(grid.metaAt(lat, lon));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {regime && (
        <div>
          <strong>{regime.name}</strong> <span className="small muted">({regime.months.map(monthName).join(', ')})</span>
          <p className="small secondary" style={{ margin: '2px 0 0' }}>{regime.description}</p>
        </div>
      )}
      <div>
        {!hideName && <><strong>{name ?? 'This area'}</strong>{' '}</>}
        <span className="small muted">{Math.abs(lat).toFixed(1)}°{lat >= 0 ? 'N' : 'S'}, {Math.abs(lon).toFixed(1)}°{lon >= 0 ? 'E' : 'W'}</span>
      </div>
      <span className="small">
        {label}: about <strong>{Math.round(sel)} mm</strong> ({rainBand(sel)})
      </span>
      <RainBars values={year} selected={months} />
      <span className="small muted">
        {Math.round(total)} mm a year · wettest {monthName(wettest)}, driest {monthName(driest)} · {src.grid} average (about {src.km} km), 1991–2020
      </span>
    </div>
  );
}

/** Labels for the regimes active in `months`, drawn in screen space. */
export function MonsoonLabels({
  months,
  project,
  onHover,
  hoverId,
}: {
  months: number[];
  project: (lon: number, lat: number) => [number, number] | null;
  onHover: (r: MonsoonRegime | null, e?: React.PointerEvent) => void;
  hoverId: string | null;
}) {
  const active = MONSOONS.filter((r) => r.months.some((m) => months.includes(m)));
  const boxes: [number, number, number, number][] = [];
  return (
    <g className="monsoon-labels">
      {active.map((r) => {
        const xy = project(r.lon, r.lat);
        if (!xy) return null;
        const [x, y] = xy;
        const w = r.name.length * 6.1 + 14;
        const box: [number, number, number, number] = [x - w / 2, y - 10, x + w / 2, y + 10];
        if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) return null;
        boxes.push(box);
        return (
          <g key={r.id} onPointerMove={(e) => onHover(r, e)} onPointerLeave={() => onHover(null)} style={{ cursor: 'help' }}>
            <rect x={box[0]} y={box[1]} width={w} height={20} rx={10} className={`monsoon-pill${hoverId === r.id ? ' active' : ''}`} />
            <text x={x} y={y + 4} textAnchor="middle" className="monsoon-text">{r.name}</text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Footprints of monsoon regimes that rain on particular climate zones (Sri Lanka's southwest or
 * east…): each zone's outline, clipped to its country, bolder while a regime covering it is
 * active in `months` and highlighted while its label is hovered. Drawn in map space.
 */
export function MonsoonFootprints({
  zones,
  months,
  hoverId,
  zonePath,
  clipFor,
}: {
  /** Climate zones and areas (parts of zones used only by footprints). */
  zones: { id: string; cc: string }[];
  months: number[];
  hoverId: string | null;
  zonePath: (id: string) => string | undefined;
  /** The clip-path id for a zone's country outline (none when the country isn't drawn). */
  clipFor: (cc: string) => string | null;
}) {
  const withRegime = MONSOONS.filter((r) => r.zones?.length);
  return (
    <g className="monsoon-footprints" pointerEvents="none" aria-hidden>
      {zones.map((z) => {
        const regimes = withRegime.filter((r) => r.zones!.includes(z.id));
        const clip = clipFor(z.cc);
        if (!regimes.length || !clip) return null;
        const on = regimes.some((r) => r.months.some((m) => months.includes(m)));
        const hover = hoverId !== null && regimes.some((r) => r.id === hoverId);
        return (
          <path
            key={z.id}
            d={zonePath(z.id)}
            clipPath={`url(#${clip})`}
            className={`monsoon-footprint${on ? ' on' : ''}${hover ? ' hover' : ''}`}
            vectorEffect="non-scaling-stroke"
            data-zone={z.id}
          />
        );
      })}
    </g>
  );
}

/**
 * A country's climate zones side by side: twelve months of rain at each zone's city, the chosen
 * months outlined, and a one-line verdict on which side is drier then.
 */
export function ZoneSides({ grid, zones, months, current }: { grid: RainField; zones: ClimateZone[]; months: number[]; current?: string }) {
  const rows = zones.map((z) => {
    const year = grid.year(z.city.lat, z.city.lon);
    return { z, year, mm: months.reduce((a, m) => a + year[m - 1], 0) / Math.max(1, months.length) };
  });
  const verdict = sidesVerdict(rows.map((r) => ({ name: r.z.name, mm: r.mm })));
  return (
    <div className="sides" aria-label="Rain by climate zone">
      <div className="small">
        <strong>{zones.length === 2 ? 'Two rainy sides' : 'Rain by area'}</strong>
        {verdict && <> · {months.map(monthName).join(' & ')}: {verdict}</>}
      </div>
      {rows.map(({ z, year, mm }) => (
        <div key={z.id}>
          <div className="small">
            <span style={{ fontWeight: z.id === current ? 700 : 600 }}>{z.name}</span>{' '}
            <span className="muted">{z.city.name} · {Math.round(mm)} mm</span>
          </div>
          <div className="sides-strip" role="img" aria-label={`${z.name}: ${year.map((v, i) => `${monthName(i + 1)} ${Math.round(v)} mm`).join(', ')}`}>
            {year.map((v, i) => (
              <span key={i} className={months.includes(i + 1) ? 'on' : undefined} style={{ background: rainCss(v) }} title={`${monthName(i + 1)}: ${Math.round(v)} mm`} />
            ))}
          </div>
        </div>
      ))}
      <div className="sides-months" aria-hidden>
        {Array.from({ length: 12 }, (_, i) => <span key={i}>{monthName(i + 1)[0]}</span>)}
      </div>
    </div>
  );
}

/**
 * "Rain around here": twelve months of rain at places near a pinned spot, the chosen months
 * outlined, and the driest of them then. The place you pinned (within 10 km) is shown in bold.
 */
export function NearbyRain({ grid, places, months }: { grid: RainField; places: NearbyPlace[]; months: number[] }) {
  if (places.length < 2) return null;
  const rows = places.map((p) => ({ ...p, year: grid.year(p.lat, p.lon) }));
  const dry = driestNearby(rows, months);
  const label = months.map(monthName).join(' & ');
  return (
    <div className="sides" aria-label="Rain around here">
      <div className="small">
        <strong>Rain around here</strong>
        <span className="muted"> · {dry ? `${label}: driest nearby is ${dry.name} (${Math.round(dry.mm)} mm)` : `${label}: similar across these places`}</span>
      </div>
      {rows.map((r) => (
        <div key={r.name} className="nearby-row">
          <span className="small" style={{ fontWeight: r.km < 10 ? 700 : 400 }}>{r.name}</span>
          <div className="sides-strip" role="img" aria-label={`${r.name}: ${r.year.map((v, i) => `${monthName(i + 1)} ${Math.round(v)} mm`).join(', ')}`}>
            {r.year.map((v, i) => (
              <span key={i} className={months.includes(i + 1) ? 'on' : undefined} style={{ background: rainCss(v) }} title={`${monthName(i + 1)}: ${Math.round(v)} mm`} />
            ))}
          </div>
          <span className="small muted" style={{ textAlign: 'right' }}>{Math.round(monthsMean(r.year, months))} mm</span>
        </div>
      ))}
      <div className="nearby-row" aria-hidden>
        <span />
        <div className="sides-months">{Array.from({ length: 12 }, (_, i) => <span key={i}>{monthName(i + 1)[0]}</span>)}</div>
        <span />
      </div>
    </div>
  );
}
