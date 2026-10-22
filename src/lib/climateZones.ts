// Climate zones: countries whose coasts get their rain in different seasons (Sri Lanka's two
// monsoons, peninsular Malaysia's coasts…) are split into zones, each rated from one
// representative city. Shapes come from public/climate-zones.json
// (scripts/build-climate-zones.mjs); the definitions live in src/data/climateZones.json.

import { geoContains } from 'd3-geo';
import type { Feature, FeatureCollection, MultiLineString, MultiPolygon } from 'geojson';
import { MONSOONS, type MonsoonRegime } from '../data/monsoons';

export interface ClimateZone {
  id: string;
  cc: string;
  name: string;
  /** Well-known places in the zone, e.g. "Trincomalee, Arugam Bay, Jaffna". */
  places: string;
  /** The city the zone is rated from (the exact point the app stores for it). */
  city: { name: string; lat: number; lon: number };
  shape: Feature<MultiPolygon>;
}

/** Part of a zone used only by monsoon footprints (western Hokkaido for the winter snow). */
export interface ClimateArea {
  id: string;
  cc: string;
  zone: string;
  name: string;
  shape: Feature<MultiPolygon>;
}

export interface ClimateZones {
  zones: ClimateZone[];
  areas: ClimateArea[];
  /** Lines where two zones of a country meet, by country code. */
  edges: Map<string, Feature<MultiLineString>>;
  byCc: Map<string, ClimateZone[]>;
}

type ZoneProps =
  | { kind: 'zone'; id: string; cc: string; name: string; places: string; city: ClimateZone['city'] | null }
  | { kind: 'area'; id: string; cc: string; zone: string; name: string }
  | { kind: 'edge'; cc: string };

export function parseClimateZones(fc: FeatureCollection<MultiPolygon | MultiLineString, ZoneProps>): ClimateZones {
  const zones: ClimateZone[] = [];
  const areas: ClimateArea[] = [];
  const edges = new Map<string, Feature<MultiLineString>>();
  for (const f of fc.features) {
    const p = f.properties;
    if (p.kind === 'edge') edges.set(p.cc, f as Feature<MultiLineString>);
    else if (p.kind === 'area') areas.push({ id: p.id, cc: p.cc, zone: p.zone, name: p.name, shape: f as Feature<MultiPolygon> });
    else if (p.city) zones.push({ id: p.id, cc: p.cc, name: p.name, places: p.places, city: p.city, shape: f as Feature<MultiPolygon> });
  }
  const byCc = new Map<string, ClimateZone[]>();
  for (const z of zones) byCc.set(z.cc, [...(byCc.get(z.cc) ?? []), z]);
  return { zones, areas, edges, byCc };
}

let cached: Promise<ClimateZones> | null = null;

export function loadClimateZones(base = import.meta.env.BASE_URL): Promise<ClimateZones> {
  cached ??= fetch(`${base}climate-zones.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`Climate zones failed to load (HTTP ${r.status})`);
      return r.json();
    })
    .then(parseClimateZones);
  cached.catch(() => (cached = null));
  return cached;
}

/** The zone a point falls in (zone shapes are simplified, so a coastal point may miss: null). */
export function zoneAt(cz: ClimateZones, lat: number, lon: number, cc?: string): ClimateZone | null {
  const list = cc ? cz.byCc.get(cc) ?? [] : cz.zones;
  return list.find((z) => geoContains(z.shape, [lon, lat])) ?? null;
}

/** The zone a point belongs to: the one containing it, else the nearest zone city in its country. */
export function zoneFor(cz: ClimateZones, cc: string, lat: number, lon: number): ClimateZone | null {
  const list = cz.byCc.get(cc);
  if (!list?.length) return null;
  const inside = zoneAt(cz, lat, lon, cc);
  if (inside) return inside;
  const d = (z: ClimateZone) => (z.city.lat - lat) ** 2 + ((z.city.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
  return [...list].sort((a, b) => d(a) - d(b))[0];
}

/** Monsoon regimes whose footprint covers a zone and that are active in any of `months`. */
export function regimesForZone(zoneId: string, months: number[], list: MonsoonRegime[] = MONSOONS): MonsoonRegime[] {
  return list.filter((r) => r.zones?.includes(zoneId) && r.months.some((m) => months.includes(m)));
}

/** Monsoon regimes with a footprint in a country (any zone or area), active in any of `months`. */
export function regimesForCountry(cz: ClimateZones, cc: string, months: number[], list: MonsoonRegime[] = MONSOONS): MonsoonRegime[] {
  const ids = new Set([...(cz.byCc.get(cc) ?? []).map((z) => z.id), ...cz.areas.filter((a) => a.cc === cc).map((a) => a.id)]);
  return list.filter((r) => r.zones?.some((z) => ids.has(z)) && r.months.some((m) => months.includes(m)));
}

/** Where in a country a regime rains: "everywhere", or "mainly Hokkaido and Sea of Japan coast". */
export function regimeWhere(cz: ClimateZones, cc: string, r: MonsoonRegime): string {
  const zones = cz.byCc.get(cc) ?? [];
  const ids = r.zones ?? [];
  if (zones.length && zones.every((z) => ids.includes(z.id))) return 'everywhere';
  const names = ids.flatMap((id) => {
    const z = zones.find((x) => x.id === id);
    const a = cz.areas.find((x) => x.id === id && x.cc === cc);
    return z ? [z.name] : a ? [a.name] : [];
  });
  return `mainly ${names.join(' and ')}`;
}

/**
 * One line comparing a country's zones for the given monthly rainfall (mm): which side is drier,
 * or that it's wet (or similar) everywhere. Differences under 40% or 60 mm count as similar.
 */
export function sidesVerdict(rows: { name: string; mm: number }[]): string {
  if (rows.length < 2) return '';
  const sorted = [...rows].sort((a, b) => a.mm - b.mm);
  const dry = sorted[0];
  const wet = sorted[sorted.length - 1];
  const similar = wet.mm - dry.mm < 60 || wet.mm < dry.mm * 1.4;
  if (similar) return dry.mm >= 200 ? 'Wet everywhere' : dry.mm < 75 ? 'Fairly dry everywhere' : 'Similar everywhere';
  const others = sorted.slice(1).filter((r) => r.mm >= dry.mm * 1.4 && r.mm - dry.mm >= 60);
  return `${dry.name} is the drier side${others.length === sorted.length - 1 ? '' : ' (with others close)'}`;
}
