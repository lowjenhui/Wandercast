// MFA travel advisories from the local server, plus the shapes needed to place a destination
// inside them: admin-1 regions (public/advisory-regions.json) and country borders (world-atlas
// 50m, shared with the map's detailed outlines).

import { useEffect, useState } from 'react';
import { geoContains } from 'd3-geo';
import { mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { MultiLineString } from 'geojson';
import { ADVISORY_ZONES, DEFAULT_INSURER } from '../data/advisories';
import { advisoryAt, coverageFor, type AdvisoryFeed, type Coverage, type CountryZones, type Geo, type InsurerRules, type PlaceAdvisory, type RegionFeature } from '../lib/advisory';
import { todayISO } from '../lib/dates';
import { loadCountryPoints } from './currentWeather';
import { getJson } from './http';

export interface AdvisoryContext {
  feed: AdvisoryFeed;
  zones: Record<string, CountryZones>;
  regions: RegionFeature[];
  /** Border lines used by border zones, keyed "AA|BB" (sorted). */
  borders: Map<string, MultiLineString>;
  geo: Geo;
  insurer: InsurerRules;
}

const borderKey = (a: string, b: string) => [a, b].sort().join('|');

/** Distance in km from a point to the nearest segment of a line set (local flat projection). */
export function distanceToLinesKm(lines: MultiLineString, lon: number, lat: number): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let best = Infinity;
  for (const line of lines.coordinates) {
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - lon) * kx;
      const ay = (line[i - 1][1] - lat) * ky;
      const bx = (line[i][0] - lon) * kx;
      const by = (line[i][1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

async function loadBorders(zones: Record<string, CountryZones>): Promise<Map<string, MultiLineString>> {
  const pairs = new Set<string>();
  for (const z of Object.values(zones)) for (const zone of z.zones) if (zone.area.kind === 'border') pairs.add(borderKey(z.cc, zone.area.with));
  const out = new Map<string, MultiLineString>();
  if (!pairs.size) return out;
  const [mod, points] = await Promise.all([import('world-atlas/countries-50m.json'), loadCountryPoints()]);
  const topo = (mod.default ?? mod) as unknown as Topology<{ countries: GeometryCollection }>;
  const ccn3 = new Map(points.map((p) => [p.cc, p.ccn3]));
  for (const key of pairs) {
    const [a, b] = key.split('|').map((c) => ccn3.get(c));
    if (!a || !b) continue;
    const m = mesh(topo, topo.objects.countries, (x, y) => x !== y && ((String(x.id) === a && String(y.id) === b) || (String(x.id) === b && String(y.id) === a)));
    if (m.coordinates.length) out.set(key, m);
  }
  return out;
}

let cached: Promise<AdvisoryContext> | null = null;

/** Shared across callers; a failure is not cached, so the next caller retries. */
export function loadAdvisories(): Promise<AdvisoryContext> {
  cached ??= Promise.all([
    getJson<AdvisoryFeed>('/api/advisories', {}, 120_000),
    fetch(`${import.meta.env.BASE_URL}advisory-regions.json`).then((r) => {
      if (!r.ok) throw new Error(`Advisory regions failed to load (HTTP ${r.status})`);
      return r.json() as Promise<{ features: RegionFeature[] }>;
    }),
    loadBorders(ADVISORY_ZONES),
  ])
    .then(([feed, regions, borders]) => {
      const geo: Geo = {
        inRegion: (f, lon, lat) => geoContains(f, [lon, lat]),
        borderKm: (a, b, lon, lat) => {
          const lines = borders.get(borderKey(a, b));
          return lines ? distanceToLinesKm(lines, lon, lat) : null;
        },
      };
      return { feed, zones: ADVISORY_ZONES, regions: regions.features, borders, geo, insurer: DEFAULT_INSURER };
    })
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}

export interface PlaceSafety {
  advisory: PlaceAdvisory;
  coverage: Coverage;
}

export function safetyAt(ctx: AdvisoryContext, p: { cc: string; lat: number; lon: number }, bookedOn: string | null = null): PlaceSafety {
  const advisory = advisoryAt(ctx.feed, ctx.zones, ctx.regions, ctx.geo, p);
  return { advisory, coverage: coverageFor(ctx.insurer, advisory, p, ctx.regions, ctx.geo, ctx.feed.history, bookedOn, todayISO()) };
}

/** The advisory context once loaded (null while loading, or if it failed: callers show nothing). */
export function useAdvisories(): { ctx: AdvisoryContext | null; error: string | null } {
  const [state, setState] = useState<{ ctx: AdvisoryContext | null; error: string | null }>({ ctx: null, error: null });
  useEffect(() => {
    let live = true;
    loadAdvisories().then(
      (ctx) => live && setState({ ctx, error: null }),
      (e) => live && setState({ ctx: null, error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Strongest MFA level at each destination, keyed by `key(d)` (empty until advisories load). */
export function useAdvisoryLevels<T extends { cc: string; lat: number; lon: number }>(items: T[] | null, key: (d: T) => string): Map<string, PlaceAdvisory['level']> {
  const { ctx } = useAdvisories();
  const [out, setOut] = useState(new Map<string, PlaceAdvisory['level']>());
  useEffect(() => {
    if (!ctx || !items) return;
    setOut(new Map(items.map((d) => [key(d), advisoryAt(ctx.feed, ctx.zones, ctx.regions, ctx.geo, d).level])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, items]);
  return out;
}
