// Monthly rainfall normals for 1991–2020, bundled as static files, so no weather API calls are
// involved: GPCP v2.3 on a 2.5° global grid (scripts/build-rainfall.py) and ERA5 on a 0.25° grid
// for Asia and Australia (scripts/build-rainfall-era5.py), used from regional zoom so coasts with opposite
// monsoons (Sri Lanka's southwest and east…) show apart.

import { addDays, daysBetween } from './dates';

export interface RainMeta {
  source: { name: string; url: string; citation: string };
  units: 'mm/month';
  lat0: number;
  dlat: number;
  nlat: number;
  lon0: number;
  dlon: number;
  nlon: number;
  months: number;
  max: number;
}

/** Anything monthly rainfall can be read from: one grid, or a regional grid nested in a global one. */
export abstract class RainField {
  /** Mean rainfall (mm) for month 1–12 at a location. */
  abstract at(month: number, lat: number, lon: number): number;
  /** The grid behind the value at a location (its source and resolution). */
  abstract metaAt(lat: number, lon: number): RainMeta;

  /** All 12 months at a location. */
  year(lat: number, lon: number): number[] {
    return Array.from({ length: 12 }, (_, m) => this.at(m + 1, lat, lon));
  }

  /** Weighted mean over months, e.g. a trip spanning two months. */
  blend(weights: Map<number, number>, lat: number, lon: number): number {
    let sw = 0;
    let s = 0;
    for (const [m, w] of weights) {
      s += this.at(m, lat, lon) * w;
      sw += w;
    }
    return sw ? s / sw : 0;
  }
}

export class RainGrid extends RainField {
  constructor(
    readonly meta: RainMeta,
    private values: Uint16Array,
  ) {
    super();
  }

  metaAt(): RainMeta {
    return this.meta;
  }

  /** Degrees inside the grid's edge (negative outside); for a global grid, always well inside. */
  inside(lat: number, lon: number): number {
    const { lat0, dlat, nlat, lon0, dlon, nlon } = this.meta;
    const latA = Math.min(lat0, lat0 + dlat * (nlat - 1));
    const latB = Math.max(lat0, lat0 + dlat * (nlat - 1));
    if (nlon * dlon >= 359) return Math.min(lat - latA, latB - lat) + 180;
    const x = ((((lon - lon0) % 360) + 360) % 360);
    const lonSpan = dlon * (nlon - 1);
    const dLon = x <= lonSpan ? Math.min(x, lonSpan - x) : -Math.min(x - lonSpan, 360 - x);
    return Math.min(lat - latA, latB - lat, dLon);
  }

  private cell(m: number, i: number, j: number): number {
    const { nlat, nlon } = this.meta;
    const ii = Math.min(nlat - 1, Math.max(0, i));
    const jj = ((j % nlon) + nlon) % nlon;
    return this.values[m * nlat * nlon + ii * nlon + jj];
  }

  /** Bilinear mean rainfall (mm) for month 1–12 at a location. */
  at(month: number, lat: number, lon: number): number {
    const { lat0, dlat, lon0, dlon } = this.meta;
    const fi = (lat - lat0) / dlat;
    const fj = ((((lon - lon0) % 360) + 360) % 360) / dlon;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const di = fi - i;
    const dj = fj - j;
    const m = month - 1;
    return (
      this.cell(m, i, j) * (1 - di) * (1 - dj) +
      this.cell(m, i, j + 1) * (1 - di) * dj +
      this.cell(m, i + 1, j) * di * (1 - dj) +
      this.cell(m, i + 1, j + 1) * di * dj
    );
  }

}

/**
 * A finer regional grid inside a global one. Inside the region the regional grid is used,
 * blended into the global one over the last `margin` degrees so there is no seam at its edge.
 */
export class NestedRain extends RainField {
  constructor(
    readonly outer: RainGrid,
    readonly inner: RainGrid,
    private margin = 3,
  ) {
    super();
  }

  private weight(lat: number, lon: number): number {
    return Math.max(0, Math.min(1, this.inner.inside(lat, lon) / this.margin));
  }

  at(month: number, lat: number, lon: number): number {
    const w = this.weight(lat, lon);
    if (w <= 0) return this.outer.at(month, lat, lon);
    if (w >= 1) return this.inner.at(month, lat, lon);
    return this.inner.at(month, lat, lon) * w + this.outer.at(month, lat, lon) * (1 - w);
  }

  metaAt(lat: number, lon: number): RainMeta {
    return this.weight(lat, lon) >= 0.5 ? this.inner.meta : this.outer.meta;
  }
}

/** Short source name and grid size for a rainfall grid, e.g. "ERA5 (Copernicus), 0.25° grid". */
export function rainSourceLabel(meta: RainMeta): { name: string; grid: string; km: number } {
  const deg = Math.abs(meta.dlat);
  return { name: meta.source.url.includes('gpcp') ? 'GPCP v2.3 (NOAA PSL)' : 'ERA5 (Copernicus)', grid: `${deg}° grid`, km: Math.round(deg * 111) };
}

const loadGrid = (base: string, name: string, what: string) =>
  Promise.all([
    fetch(`${base}${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`${what} failed to load (HTTP ${r.status})`);
      return r.json() as Promise<RainMeta>;
    }),
    fetch(`${base}${name}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${what} failed to load (HTTP ${r.status})`);
      return r.arrayBuffer();
    }),
  ]).then(([meta, buf]) => new RainGrid(meta, new Uint16Array(buf)));

let cached: Promise<RainGrid> | null = null;

export function loadRainfall(base = import.meta.env.BASE_URL): Promise<RainGrid> {
  cached ??= loadGrid(base, 'rainfall-normals', 'Rainfall normals');
  cached.catch(() => (cached = null));
  return cached;
}

let cachedAsia: Promise<RainGrid> | null = null;

/** The 0.25° ERA5 grid for Asia and Australia (about 3.7 MB), loaded on first use. */
export function loadRainfallAsia(base = import.meta.env.BASE_URL): Promise<RainGrid> {
  cachedAsia ??= loadGrid(base, 'rainfall-asia', 'Asia rainfall normals');
  cachedAsia.catch(() => (cachedAsia = null));
  return cachedAsia;
}

/** Days of the trip in each month (1–12). */
export function tripMonthWeights(start: string, end: string): Map<number, number> {
  const out = new Map<number, number>();
  const n = Math.min(daysBetween(start, end) + 1, 400);
  for (let i = 0; i < n; i++) {
    const m = Number(addDays(start, i).slice(5, 7));
    out.set(m, (out.get(m) ?? 0) + 1);
  }
  return out;
}

/** Colour stops in mm per month: dry sand → green → blue → indigo → violet. */
export const RAIN_STOPS: [number, [number, number, number]][] = [
  [0, [246, 236, 214]],
  [25, [225, 236, 196]],
  [50, [180, 222, 190]],
  [100, [118, 200, 210]],
  [200, [62, 150, 228]],
  [300, [58, 96, 210]],
  [450, [92, 54, 184]],
  [650, [128, 30, 160]],
];

export function rainColor(mm: number): [number, number, number] {
  if (mm <= RAIN_STOPS[0][0]) return RAIN_STOPS[0][1];
  for (let k = 1; k < RAIN_STOPS.length; k++) {
    const [v1, c1] = RAIN_STOPS[k];
    if (mm <= v1) {
      const [v0, c0] = RAIN_STOPS[k - 1];
      const f = (mm - v0) / (v1 - v0);
      return [0, 1, 2].map((i) => Math.round(c0[i] + (c1[i] - c0[i]) * f)) as [number, number, number];
    }
  }
  return RAIN_STOPS[RAIN_STOPS.length - 1][1];
}

export function rainCss(mm: number): string {
  const [r, g, b] = rainColor(mm);
  return `rgb(${r} ${g} ${b})`;
}

/** Plain-language band for a monthly total. */
export function rainBand(mm: number): string {
  return mm < 25 ? 'dry' : mm < 75 ? 'fairly dry' : mm < 150 ? 'moderately wet' : mm < 300 ? 'wet' : 'very wet';
}
